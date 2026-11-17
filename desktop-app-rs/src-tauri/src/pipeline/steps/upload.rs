//! R2 upload (spec 4.4 step 6, port of steps/upload.ts): 5 concurrent PutObject streams,
//! playlist.m3u8 strictly last, the network-wait policy and the 3-attempt policy for other
//! failures.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::dto::JobState;
use crate::ffmpeg::errors::{
    cancelled_error, upload_interrupted_error, PipelineError, PipelineErrorKind,
};
use crate::logger::Log;
use crate::pipeline::deps::{ObjectStore, PutFileRequest, Sleeper, StoreError};
use crate::pipeline::fault::Fault;
use crate::pipeline::file_names::PLAYLIST_FILE;
use crate::pipeline::pool::run_pool;
use crate::pipeline::upload::classify_error::{classify_upload_error, UploadErrorClass};
use crate::pipeline::upload::plan::{
    content_type_for, list_upload_files, object_key, progress_from_uploaded, UPLOAD_CONCURRENCY,
    UPLOAD_RETRY_DELAYS_MS,
};

/// Continuous network failure (no successful file) after which the upload is interrupted.
pub const NETWORK_STALL_BUDGET_MS: u64 = 30 * 60 * 1000;
/// Waits between attempts of a file that keeps failing with a network error; the last repeats.
pub const NETWORK_BACKOFF_MS: [u64; 6] = [2000, 5000, 10000, 20000, 30000, 60000];
/// `on_network_wait` is called at most this often.
pub const NETWORK_WAIT_NOTIFY_INTERVAL_MS: u64 = 5000;

pub const UPLOAD_FAILED_MESSAGE: &str =
    "Uploading to R2 failed. Check the R2 settings and your connection.";

/// The upload is waiting for the network (UI: "Waiting for network…", RAM only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkWaitInfo {
    /// Epoch ms when the current outage started (first network failure since the last
    /// success).
    pub since: i64,
    /// Network failures seen since the outage started (all files together).
    pub attempt: u64,
    pub next_retry_in_ms: u64,
    pub budget_remaining_ms: u64,
}

pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Jitter = Arc<dyn Fn(u64) -> f64 + Send + Sync>;

/// Test seams of the network-wait policy. All optional.
#[derive(Clone, Default)]
pub struct UploadTuning {
    /// Epoch ms clock. Default: the system clock.
    pub now: Option<NowMs>,
    /// Extra ms added to a backoff delay. Default: up to 20% of the delay, random.
    pub jitter: Option<Jitter>,
    /// Default [`NETWORK_STALL_BUDGET_MS`].
    pub stall_budget_ms: Option<u64>,
}

/// Status callbacks of the network-wait policy. A panicking hook is caught and logged (the TS
/// "a throwing hook never breaks the upload").
pub trait NetworkHooks: Send + Sync {
    fn on_network_wait(&self, _info: &NetworkWaitInfo) {}
    /// Called when the first upload succeeds after `on_network_wait` was called.
    fn on_network_restored(&self) {}
}

pub struct NoNetworkHooks;

impl NetworkHooks for NoNetworkHooks {}

pub type OnFraction = Arc<dyn Fn(f64) + Send + Sync>;
pub type OnEvent = Arc<dyn Fn() + Send + Sync>;

/// Everything the upload of one job directory needs.
#[derive(Clone)]
pub struct UploadContext {
    pub store: Arc<dyn ObjectStore>,
    pub bucket: String,
    pub prefix: String,
    /// Job directory holding the files.
    pub dir: PathBuf,
    pub cancel: CancellationToken,
    pub sleeper: Arc<dyn Sleeper>,
    pub logger: Arc<dyn Log>,
    /// Upload stage fraction (files done / total), never decreasing.
    pub on_progress: OnFraction,
    /// Called once, right before the first PutObject is sent (R2 may now hold objects).
    pub on_upload_started: OnEvent,
    pub network: Arc<dyn NetworkHooks>,
    pub tuning: UploadTuning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadResult {
    /// Names of the uploaded files, playlist last.
    pub files: Vec<String>,
}

fn system_now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn random_jitter(base: u64) -> f64 {
    use std::hash::{BuildHasher, Hasher, RandomState};

    let unit = (RandomState::new().build_hasher().finish() >> 11) as f64 / (1u64 << 53) as f64;

    base as f64 * 0.2 * unit
}

fn call_hook(logger: &dyn Log, call: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)).is_err() {
        logger.warn("A network status hook failed.", None);
    }
}

/// Shared (per upload step, not per file) network stall state: the outage starts at the first
/// network failure after the last success and any success ends it.
struct NetworkStall {
    failing_since: Option<i64>,
    attempts: u64,
    last_notify_at: Option<i64>,
    notified: bool,
}

enum StallDecision {
    Wait {
        delay: u64,
        notify: Option<NetworkWaitInfo>,
    },
    BudgetUsed,
}

struct Policy {
    now: NowMs,
    jitter: Jitter,
    budget_ms: u64,
}

impl NetworkStall {
    /// Delay before the next attempt of a file (`file_failures` = its network failures so far),
    /// or `BudgetUsed`.
    fn on_network_failure(&mut self, policy: &Policy, file_failures: usize) -> StallDecision {
        let now = (policy.now)();
        let since = *self.failing_since.get_or_insert(now);
        let used = now.saturating_sub(since).max(0) as u64;
        let remaining = policy.budget_ms.saturating_sub(used);

        if remaining == 0 {
            return StallDecision::BudgetUsed;
        }

        self.attempts += 1;

        let base = NETWORK_BACKOFF_MS[file_failures.min(NETWORK_BACKOFF_MS.len() - 1)];
        let jitter = (policy.jitter)(base).max(0.0);
        let delay = ((base as f64 + jitter).min(remaining as f64)).floor() as u64;
        let due = match self.last_notify_at {
            None => true,
            Some(last) => now.saturating_sub(last) >= NETWORK_WAIT_NOTIFY_INTERVAL_MS as i64,
        };
        let notify = due.then(|| {
            self.last_notify_at = Some(now);
            self.notified = true;

            NetworkWaitInfo {
                since,
                attempt: self.attempts,
                next_retry_in_ms: delay,
                budget_remaining_ms: remaining,
            }
        });

        StallDecision::Wait { delay, notify }
    }

    /// Ends the outage; true when `on_network_restored` must be called.
    fn on_success(&mut self) -> bool {
        let was_notified = self.notified;

        self.failing_since = None;
        self.attempts = 0;
        self.notified = false;
        self.last_notify_at = None;

        was_notified
    }
}

/// Why one file failed for good.
enum FileFailure {
    Pipeline(PipelineError),
    Store(StoreError),
}

struct Shared {
    ctx: UploadContext,
    /// Child of the job token: cancelled on the first failure so files that wait for the
    /// network stop at once (the TS internal AbortController).
    internal: CancellationToken,
    policy: Policy,
    stall: Mutex<NetworkStall>,
    sizes: HashMap<String, u64>,
    total_count: usize,
    done: Mutex<usize>,
    started: Mutex<bool>,
    first: Mutex<Option<FileFailure>>,
}

impl Shared {
    fn mark_started(&self) {
        let mut started = self.started.lock().expect("upload lock");

        if !*started {
            *started = true;
            (self.ctx.on_upload_started)();
        }
    }

    fn cancelled(&self) -> FileFailure {
        FileFailure::Pipeline(cancelled_error(JobState::Uploading))
    }

    async fn put_once(&self, name: &str) -> Result<(), StoreError> {
        let key = object_key(&self.ctx.prefix, name).map_err(StoreError::Local)?;
        let content_type = content_type_for(name).map_err(StoreError::Local)?;
        let path = self.ctx.dir.join(name);

        self.ctx
            .store
            .put_file(
                PutFileRequest {
                    bucket: &self.ctx.bucket,
                    key: &key,
                    path: &path,
                    content_length: self.sizes.get(name).copied().unwrap_or(0),
                    content_type,
                    on_bytes: None,
                },
                &self.internal,
            )
            .await
    }

    async fn put_one(&self, name: &str) -> Result<(), FileFailure> {
        let logger = &*self.ctx.logger;
        let mut other_failures = 0usize;
        let mut network_failures = 0usize;

        loop {
            if self.internal.is_cancelled() {
                return Err(self.cancelled());
            }

            self.mark_started();

            let error = match self.put_once(name).await {
                Ok(()) => {
                    let restored = self.stall.lock().expect("upload lock").on_success();

                    if restored {
                        call_hook(logger, || self.ctx.network.on_network_restored());
                    }

                    break;
                }
                Err(error) => error,
            };

            // Own cancel, or a sibling file already failed: stop without retrying.
            if self.internal.is_cancelled() {
                return Err(self.cancelled());
            }

            if classify_upload_error(&error, Some(&self.internal)) == UploadErrorClass::Network {
                let decision = self
                    .stall
                    .lock()
                    .expect("upload lock")
                    .on_network_failure(&self.policy, network_failures);

                network_failures += 1;

                let StallDecision::Wait { delay, notify } = decision else {
                    logger.warn(
                        &format!("Upload of {name} stopped: the network stall budget is used up."),
                        Some(json!({ "error": error.to_string() })),
                    );

                    return Err(FileFailure::Pipeline(upload_interrupted_error()));
                };

                if let Some(info) = notify {
                    call_hook(logger, || self.ctx.network.on_network_wait(&info));
                }

                logger.warn(
                    &format!("Upload of {name} hit a network error; waiting to retry."),
                    Some(json!({
                        "attempt": network_failures,
                        "delayMs": delay,
                        "error": error.to_string(),
                    })),
                );
                self.ctx.sleeper.sleep(delay, Some(&self.internal)).await;
            } else {
                let Some(delay) = UPLOAD_RETRY_DELAYS_MS.get(other_failures).copied() else {
                    return Err(FileFailure::Store(error));
                };

                other_failures += 1;
                logger.warn(
                    &format!("Upload of {name} failed; retrying."),
                    Some(json!({
                        "attempt": other_failures,
                        "delayMs": delay,
                        "error": error.to_string(),
                    })),
                );
                self.ctx.sleeper.sleep(delay, Some(&self.internal)).await;
            }
        }

        let mut done = self.done.lock().expect("upload lock");

        *done += 1;
        (self.ctx.on_progress)(progress_from_uploaded(
            *done as i64,
            self.total_count as i64,
        ));

        Ok(())
    }

    /// `guarded()`: the first failure is kept and stops every other file.
    async fn guarded(&self, name: &str) -> Result<(), ()> {
        match self.put_one(name).await {
            Ok(()) => Ok(()),
            Err(failure) => {
                self.first
                    .lock()
                    .expect("upload lock")
                    .get_or_insert(failure);
                self.internal.cancel();

                Err(())
            }
        }
    }
}

/// Uploads `files` (playlist last) with the retry policy: a network failure is retried with
/// exponential backoff until the shared stall budget is used up (then `upload_interrupted`), any
/// other failure gets [`UPLOAD_RETRY_DELAYS_MS`] (3 attempts) and then fails. Progress is
/// `(initial_done + uploaded) / total_count` (files skipped on resume count as done).
pub async fn upload_files(
    ctx: UploadContext,
    files: Vec<String>,
    sizes: HashMap<String, u64>,
    total_count: usize,
    initial_done: usize,
) -> Result<(), PipelineError> {
    let others: Vec<String> = files
        .iter()
        .filter(|n| *n != PLAYLIST_FILE)
        .cloned()
        .collect();
    let has_playlist = files.iter().any(|n| n == PLAYLIST_FILE);
    let policy = Policy {
        now: ctx
            .tuning
            .now
            .clone()
            .unwrap_or_else(|| Arc::new(system_now_ms)),
        jitter: ctx
            .tuning
            .jitter
            .clone()
            .unwrap_or_else(|| Arc::new(random_jitter)),
        budget_ms: ctx
            .tuning
            .stall_budget_ms
            .unwrap_or(NETWORK_STALL_BUDGET_MS),
    };
    let job_cancel = ctx.cancel.clone();
    let logger = Arc::clone(&ctx.logger);
    let shared = Arc::new(Shared {
        internal: ctx.cancel.child_token(),
        ctx,
        policy,
        stall: Mutex::new(NetworkStall {
            failing_since: None,
            attempts: 0,
            last_notify_at: None,
            notified: false,
        }),
        sizes,
        total_count,
        done: Mutex::new(initial_done),
        started: Mutex::new(false),
        first: Mutex::new(None),
    });

    let outcome: Result<(), ()> = async {
        let worker = Arc::clone(&shared);

        run_pool(others, UPLOAD_CONCURRENCY, move |name: String, _index| {
            let worker = Arc::clone(&worker);

            async move { worker.guarded(&name).await }
        })
        .await?;

        if job_cancel.is_cancelled() {
            shared
                .first
                .lock()
                .expect("upload lock")
                .get_or_insert(FileFailure::Pipeline(cancelled_error(JobState::Uploading)));

            return Err(());
        }

        if has_playlist {
            shared.guarded(PLAYLIST_FILE).await?;
        }

        Ok(())
    }
    .await;

    if outcome.is_ok() {
        return Ok(());
    }

    let first = shared.first.lock().expect("upload lock").take();

    if job_cancel.is_cancelled() {
        return Err(cancelled_error(JobState::Uploading));
    }

    match first {
        Some(FileFailure::Pipeline(error)) => Err(error),
        Some(FileFailure::Store(error)) => {
            logger.error(
                "Upload failed.",
                Some(json!({ "error": error.to_string() })),
            );

            Err(PipelineError::new(
                PipelineErrorKind::Failed,
                JobState::Uploading,
                UPLOAD_FAILED_MESSAGE,
            )
            .with_cause(error))
        }
        None => Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Uploading,
            UPLOAD_FAILED_MESSAGE,
        )),
    }
}

/// Uploads the output files of `ctx.dir` (playlist last). Fails when there is no playlist.
/// `on_playlist_uploaded` runs once, after the playlist (the last file) was uploaded.
pub async fn upload_directory(
    ctx: UploadContext,
    on_playlist_uploaded: impl FnOnce(),
) -> Result<UploadResult, Fault> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(&ctx.dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }

    let names = list_upload_files(&names);

    if !names.iter().any(|n| n == PLAYLIST_FILE) {
        return Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Uploading,
            "The playlist file is missing, so nothing can be uploaded.",
        )
        .into());
    }

    let mut sizes = HashMap::new();

    for name in &names {
        sizes.insert(
            name.clone(),
            tokio::fs::metadata(ctx.dir.join(name)).await?.len(),
        );
    }

    let total = names.len();

    upload_files(ctx, names.clone(), sizes, total, 0).await?;
    on_playlist_uploaded();

    Ok(UploadResult { files: names })
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
