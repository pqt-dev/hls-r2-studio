//! Job queue and state machine over the AppStore (spec 4.3 / 4.4 / 4.5). Port of
//! desktop-app/src/main/queue/jobQueue.ts; same states, messages, scheduling and cleanup rules.
//!
//! Concurrency model (the TS queue relies on the single JS thread; here jobs run on a
//! multi-threaded runtime):
//! - `state` (runtimes, shutdown flag, task count) is one `std::sync::Mutex`. Every decision
//!   ("is this job running?", "can it be retried?") and the store mutation that follows it
//!   happen inside ONE critical section, so check-then-act sequences are atomic (two clicks on
//!   Retry cannot both pass; a dedupe cannot race another add). No lock is ever held across an
//!   `.await`; async work (R2 cleanup, temp-dir removal, store flush) runs after the lock is
//!   released.
//! - Lock order: `emit_order` -> `state` -> store / auth / config (leaf locks). The store is only
//!   mutated with `state` held, so job records never change behind the queue's back.
//! - Every run has a sequence number (`seq`). Pipeline hooks and the completion re-check that
//!   the job's current runtime still has THEIR `seq` before touching anything, so a late hook
//!   (progress after cancel/completion/removal) is ignored.
//! - Events are built and sent under `emit_order`, so listeners always see snapshots in the
//!   order they were taken. Listeners must not call back into queue actions.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use chrono::SecondsFormat;
use serde_json::{json, Map, Number, Value};
use tokio::runtime::Handle;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::activity::{self, ActivityEvent, MarkKind};
use super::backend::{QueueBackend, QueueContext, RunOutcome};
use super::file_validation::{validate_video_path, PathStyle, REASON_DUPLICATE};
use super::job_dto::{has_register_payload, to_job_dto, JobRuntimeInfo};
use super::states::{
    is_attention_state, is_final_state, is_paused_upload, is_retryable_state, is_running_state,
};
use crate::api::video_links::VideoLinks;
use crate::api::AppConfig;
use crate::desktop::safe_https_url;
use crate::dto::{
    ActionResult, AuthState, AuthStatus, JobDto, JobState, QueueSummary, RejectedFile,
};
use crate::ffmpeg::errors::{PipelineError, PipelineErrorKind, RESUME_UNAVAILABLE};
use crate::logger::{redact_string, Log, RedactOptions};
use crate::pipeline::deps::Clock;
use crate::pipeline::job_dir::job_dir_path;
use crate::pipeline::public_id::is_valid_public_id;
use crate::pipeline::resume::ResumeUploadInput;
use crate::pipeline::run::{BeforeUploadInfo, PipelineHooks, PipelineJob, PipelineResult};
use crate::pipeline::steps::upload::NetworkWaitInfo;
use crate::store::{cap_history, AppStore, JobMode, JobRecord, MAX_DONE_HISTORY};

pub const DEFAULT_THROTTLE: Duration = Duration::from_millis(250);
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(15_000);

pub const INTERRUPTED_MESSAGE: &str =
    "The app was closed while this job was running. Use Retry to start it again.";
pub const RECOVERED_UPLOAD_MESSAGE: &str = "The app was closed during upload. Resume to continue.";
pub const NO_JOB: &str = "The job no longer exists.";
pub const CANCELLED_WAITING: &str = "The job was cancelled.";
pub const CANCELLED_ATTENTION: &str =
    "The job was cancelled. Files already uploaded to R2 were not removed.";
pub const CANNOT_CANCEL: &str = "This job cannot be cancelled.";
pub const CANNOT_RETRY: &str = "This job cannot be retried.";
pub const CANNOT_RESUME: &str = "This upload cannot be resumed.";
pub const CANNOT_REGISTER: &str = "This job cannot be registered again.";
pub const CANNOT_REMOVE: &str = "Only finished or paused jobs can be removed.";
pub const APP_CLOSING: &str = "The app is closing.";
pub const SIGN_IN_TO_RESUME: &str = "Sign in to resume this upload.";
pub const SIGN_IN_TO_REGISTER: &str = "Sign in to finish registering this video.";
pub const REGISTER_CANCELLED: &str = "Registering was cancelled. Use Retry to finish.";
pub const UNEXPECTED_ERROR: &str = "An unexpected error occurred.";
pub const GATE_SIGN_IN: &str = "Sign in to start processing.";
pub const GATE_SIGNING_IN: &str = "Signing in...";
pub const GATE_OFFLINE: &str = "Cannot reach the site. Reload the configuration to continue.";
pub const GATE_NO_CONFIG: &str = "R2 storage is not configured on the site yet.";
pub const WAITING_FOR_SLOT: &str = "Waiting for other jobs to finish.";

/// Shown when a job belongs to another site than the one that is signed in.
pub fn other_site_message(origin: &str) -> String {
    let host = url::Url::parse(origin)
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
        })
        .unwrap_or_else(|| origin.to_string());

    format!("This video was uploaded for {host}; sign in to that site to finish it.")
}

pub type IdGenerator = Box<dyn Fn() -> String + Send + Sync>;
pub type JobsListener = Arc<dyn Fn(&[JobDto]) + Send + Sync>;
pub type SummaryListener = Arc<dyn Fn(&QueueSummary) + Send + Sync>;

pub struct JobQueueOptions {
    pub store: Arc<AppStore>,
    pub backend: Arc<dyn QueueBackend>,
    pub context: Arc<dyn QueueContext>,
    pub clock: Arc<dyn Clock>,
    pub generate_id: IdGenerator,
    pub generate_public_id: IdGenerator,
    pub path_style: PathStyle,
    pub logger: Arc<dyn Log>,
    /// Where runs, cleanups and throttle timers are spawned.
    pub runtime: Handle,
    /// At most one progress event per job per `throttle`.
    pub throttle: Duration,
    /// Max wait for running jobs to clean up on shutdown.
    pub shutdown_timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddFilesOutcome {
    pub added: u32,
    pub rejected: Vec<RejectedFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunKind {
    Pipeline,
    Register,
    Resume,
}

struct Runtime {
    seq: u64,
    cancel: CancellationToken,
    kind: RunKind,
    /// State to return to when a register retry is cancelled.
    previous_state: JobState,
    progress: u32,
    /// Highest transcode / upload 10% mark already logged (`None` = not read from the record yet).
    transcode_mark: Option<u32>,
    upload_mark: Option<u32>,
    /// Upload retries because the network is down (RAM only, never persisted).
    waiting_for_network: bool,
    network_wait_since: Option<i64>,
    last_emit_at: i64,
    /// Token of the pending trailing emit, if any (a mismatching timer does nothing).
    trailing: Option<u64>,
}

#[derive(Default)]
struct QueueState {
    runtimes: HashMap<String, Runtime>,
    shutting_down: bool,
    /// Run tasks (including their bookkeeping) not finished yet.
    in_flight: usize,
}

#[derive(Default)]
struct Listeners {
    next_id: u64,
    jobs: Vec<(u64, JobsListener)>,
    summaries: Vec<(u64, SummaryListener)>,
}

enum RunFailure {
    Pipeline(PipelineError),
    /// The run panicked (the TS "not a PipelineError" case); the detail is only logged.
    Unexpected(String),
}

/// Async work left after a failure was recorded.
enum AfterFailure {
    Nothing,
    Restart {
        stale_prefix: Option<String>,
        origin: Option<String>,
        stale_id: Option<String>,
    },
    Cleanup {
        remove_tmp: Option<String>,
        delete_prefix: Option<(String, Option<String>)>,
    },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn fail(error: impl Into<String>) -> ActionResult {
    ActionResult::err(error)
}

fn redact(text: &str) -> String {
    redact_string(text, &RedactOptions::default())
}

fn error_detail(step: JobState, exit_code: Option<i32>, stderr_tail: Vec<String>) -> Value {
    json!({ "step": step, "exitCode": exit_code, "stderrTail": stderr_tail })
}

/// `job.registerPayload?.disk_prefix` (read from the raw stored value).
fn payload_prefix(job: &JobRecord) -> Option<String> {
    job.register_payload
        .as_ref()?
        .get("disk_prefix")?
        .as_str()
        .map(str::to_string)
}

pub struct JobQueue {
    store: Arc<AppStore>,
    backend: Arc<dyn QueueBackend>,
    ctx: Arc<dyn QueueContext>,
    clock: Arc<dyn Clock>,
    generate_id: IdGenerator,
    generate_public_id: IdGenerator,
    path_style: PathStyle,
    logger: Arc<dyn Log>,
    runtime: Handle,
    throttle_ms: i64,
    shutdown_timeout: Duration,
    state: Mutex<QueueState>,
    /// Orders event emission; holds the last summary sent.
    emit_order: Mutex<Option<QueueSummary>>,
    listeners: Mutex<Listeners>,
    next_seq: AtomicU64,
    tasks_done: Notify,
}

/// Decrements the run-task count when a run task ends (even by panic).
struct InFlight(Arc<JobQueue>);

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut st = self.0.lock_state();

        st.in_flight = st.in_flight.saturating_sub(1);
        drop(st);
        self.0.tasks_done.notify_waiters();
    }
}

impl JobQueue {
    pub fn new(options: JobQueueOptions) -> Arc<Self> {
        Arc::new(Self {
            store: options.store,
            backend: options.backend,
            ctx: options.context,
            clock: options.clock,
            generate_id: options.generate_id,
            generate_public_id: options.generate_public_id,
            path_style: options.path_style,
            logger: options.logger,
            runtime: options.runtime,
            throttle_ms: i64::try_from(options.throttle.as_millis()).unwrap_or(i64::MAX),
            shutdown_timeout: options.shutdown_timeout,
            state: Mutex::new(QueueState::default()),
            emit_order: Mutex::new(None),
            listeners: Mutex::new(Listeners::default()),
            next_seq: AtomicU64::new(1),
            tasks_done: Notify::new(),
        })
    }

    fn lock_state(&self) -> MutexGuard<'_, QueueState> {
        lock(&self.state)
    }

    fn now_ms(&self) -> i64 {
        self.clock.now().timestamp_millis()
    }

    fn iso(&self) -> String {
        self.clock
            .now()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    fn tmp_root(&self) -> PathBuf {
        PathBuf::from(self.store.read(|d| d.settings.tmp_root.clone()))
    }

    // ---- read side ----------------------------------------------------------------------

    pub fn list(&self) -> Vec<JobDto> {
        let st = self.lock_state();

        self.list_locked(&st)
    }

    pub fn get_job(&self, id: &str) -> Option<JobRecord> {
        self.store
            .read(|d| d.jobs.iter().find(|job| job.id == id).cloned())
    }

    pub fn has_active_jobs(&self) -> bool {
        !self.lock_state().runtimes.is_empty()
    }

    /// True while any job is uploaded but not registered (`register_failed` / `needs_sign_in`).
    pub fn has_attention_jobs(&self) -> bool {
        self.store
            .read(|d| d.jobs.iter().any(|job| is_attention_state(job.state)))
    }

    /// True while any upload is paused (or about to resume): its temp files and `siteOrigin`
    /// are needed, so the temp folder and the site cannot change.
    pub fn has_paused_uploads(&self) -> bool {
        self.store.read(|d| {
            d.jobs.iter().any(|job| {
                is_paused_upload(job.state)
                    || (job.state == JobState::Waiting && job.mode == Some(JobMode::Resume))
            })
        })
    }

    pub fn summary(&self) -> QueueSummary {
        let st = self.lock_state();

        self.summary_locked(&st)
    }

    pub fn subscribe(&self, listener: JobsListener) -> u64 {
        let mut listeners = lock(&self.listeners);
        listeners.next_id += 1;
        let id = listeners.next_id;
        listeners.jobs.push((id, listener));

        id
    }

    pub fn subscribe_summary(&self, listener: SummaryListener) -> u64 {
        let mut listeners = lock(&self.listeners);
        listeners.next_id += 1;
        let id = listeners.next_id;
        listeners.summaries.push((id, listener));

        id
    }

    pub fn unsubscribe(&self, id: u64) {
        let mut listeners = lock(&self.listeners);

        listeners.jobs.retain(|(i, _)| *i != id);
        listeners.summaries.retain(|(i, _)| *i != id);
    }

    fn runtime_info(
        &self,
        st: &QueueState,
        job: &JobRecord,
        reason: &Option<String>,
    ) -> JobRuntimeInfo {
        match st.runtimes.get(&job.id) {
            Some(rt) => JobRuntimeInfo {
                running: true,
                cancel_requested: rt.cancel.is_cancelled(),
                progress: Some(rt.progress),
                waiting_reason: reason.clone(),
                waiting_for_network: rt.waiting_for_network,
                network_wait_since: rt.network_wait_since,
            },
            None => JobRuntimeInfo {
                waiting_reason: reason.clone(),
                ..JobRuntimeInfo::default()
            },
        }
    }

    fn list_locked(&self, st: &QueueState) -> Vec<JobDto> {
        let reason = self.waiting_reason(st);

        self.store.read(|d| {
            d.jobs
                .iter()
                .map(|job| to_job_dto(job, &self.runtime_info(st, job, &reason), self.path_style))
                .collect()
        })
    }

    fn summary_locked(&self, st: &QueueState) -> QueueSummary {
        let (waiting, attention, done, failed, total) = self.store.read(|d| {
            let count = |pred: &dyn Fn(&JobRecord) -> bool| {
                d.jobs.iter().filter(|job| pred(job)).count() as u32
            };

            (
                count(&|j| j.state == JobState::Waiting && !st.runtimes.contains_key(&j.id)),
                count(&|j| is_attention_state(j.state) || is_paused_upload(j.state)),
                count(&|j| j.state == JobState::Done),
                count(&|j| matches!(j.state, JobState::Failed | JobState::Interrupted)),
                d.jobs.len() as u32,
            )
        });

        QueueSummary {
            running: st.runtimes.len() as u32,
            waiting,
            attention,
            done,
            failed,
            total,
            blocked_reason: if waiting > 0 { self.gate().err() } else { None },
        }
    }

    // ---- scheduling -----------------------------------------------------------------------

    /// The config to start jobs with, or why nothing can start right now.
    fn gate(&self) -> Result<AppConfig, String> {
        if let Some(block) = self.ctx.start_block() {
            return Err(block);
        }

        match self.ctx.auth_state().status {
            AuthStatus::SignedOut => return Err(GATE_SIGN_IN.into()),
            AuthStatus::SigningIn => return Err(GATE_SIGNING_IN.into()),
            AuthStatus::Offline => return Err(GATE_OFFLINE.into()),
            AuthStatus::SignedIn => {}
        }

        // A signed_in state alone is not enough: the token and the config must both exist.
        if !self.ctx.has_session() {
            return Err(GATE_SIGN_IN.into());
        }

        self.ctx.config().ok_or_else(|| GATE_NO_CONFIG.into())
    }

    fn waiting_reason(&self, st: &QueueState) -> Option<String> {
        match self.gate() {
            Err(reason) => Some(reason),
            Ok(_) if Self::pipeline_runs(st) >= self.max_concurrent() => {
                Some(WAITING_FOR_SLOT.into())
            }
            Ok(_) => None,
        }
    }

    /// Register retries are light and do not use a processing slot; pipeline and resume runs do.
    fn pipeline_runs(st: &QueueState) -> usize {
        st.runtimes
            .values()
            .filter(|rt| rt.kind != RunKind::Register)
            .count()
    }

    /// `settings.maxConcurrent`, clamped to 1..2 (anything that is not an integer counts as 1).
    fn max_concurrent(&self) -> usize {
        let value = self.store.read(|d| d.settings.max_concurrent.clone());

        let integer = value
            .as_i64()
            .map(|n| n as f64)
            .or_else(|| value.as_u64().map(|n| n as f64))
            .or_else(|| value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0));

        match integer {
            Some(n) if n >= 2.0 => 2,
            Some(_) => 1,
            None => 1,
        }
    }

    /// Re-evaluates what can start (after settings, config or the ffmpeg check changed).
    pub fn kick(self: &Arc<Self>) {
        self.changed(None);
        self.pump();
    }

    fn pump(self: &Arc<Self>) {
        let started = {
            let mut st = self.lock_state();

            self.pump_locked(&mut st)
        };

        if started {
            self.changed(None);
        }
    }

    fn pump_locked(self: &Arc<Self>, st: &mut QueueState) -> bool {
        if st.shutting_down {
            return false;
        }

        let Ok(config) = self.gate() else {
            return false;
        };
        let mut any = false;

        while Self::pipeline_runs(st) < self.max_concurrent() {
            let next = self.store.read(|d| {
                d.jobs
                    .iter()
                    .find(|j| j.state == JobState::Waiting && !st.runtimes.contains_key(&j.id))
                    .cloned()
            });
            let Some(job) = next else {
                break;
            };

            self.start_locked(st, &job, &config);
            any = true;

            // Safety net: starting must move the job out of `waiting` or give it a runtime.
            let still_waiting = !st.runtimes.contains_key(&job.id)
                && self
                    .get_job(&job.id)
                    .is_some_and(|j| j.state == JobState::Waiting);

            if still_waiting {
                break;
            }
        }

        any
    }

    fn start_locked(self: &Arc<Self>, st: &mut QueueState, job: &JobRecord, config: &AppConfig) {
        if job.mode == Some(JobMode::Resume) && self.start_resume_locked(st, job, config) {
            return;
        }

        let id = job.id.clone();
        let origin = self.ctx.auth_state().site_url;
        let public_id = (self.generate_public_id)();
        let seq = self.next_seq();
        let cancel = CancellationToken::new();

        st.runtimes.insert(
            id.clone(),
            self.new_runtime(seq, cancel.clone(), RunKind::Pipeline, JobState::Waiting),
        );

        let started_at = self.iso();
        self.note_transition(&id, JobState::Transcoding);
        self.patch(&id, |j| {
            j.state = JobState::Transcoding;
            j.public_id = Some(public_id.clone());
            j.prefix = None;
            j.error_message = None;
            j.error_detail = None;
            j.set_register_payload(None);
            j.started_at = Some(started_at);
            j.finished_at = None;
            j.mode = None;
            j.tmp_dir = None;
            j.register_started = None;
            j.site_origin = origin;
        });
        self.logger.info("Job started", Some(json!({ "id": id })));

        let pipeline_job = PipelineJob {
            id: id.clone(),
            source_path: job.source_path.clone(),
            filename: self.path_style.base_name(&job.source_path),
            public_id,
        };
        let hooks = self.hooks(&id, seq, RunKind::Pipeline);
        let backend = Arc::clone(&self.backend);
        let config = config.clone();
        let tmp_root = self.tmp_root();

        self.spawn_run(st, id, seq, async move {
            backend
                .run_pipeline(pipeline_job, config, tmp_root, hooks, cancel)
                .await
        });
    }

    /// Starts the resume of a `waiting` job with `mode: resume`. False when the job has no
    /// stored upload data (it then runs as a fresh job).
    fn start_resume_locked(
        self: &Arc<Self>,
        st: &mut QueueState,
        job: &JobRecord,
        config: &AppConfig,
    ) -> bool {
        let payload = job.register_payload_typed();
        let public_id = job.public_id.clone().filter(|id| is_valid_public_id(id));
        let (Some(payload), Some(public_id)) = (payload, public_id) else {
            self.patch(&job.id, |j| j.mode = None);

            return false;
        };

        if let Some(foreign) = self.foreign_origin(job) {
            // The signed-in site changed while the resume was queued: never touch another site.
            let message = other_site_message(&foreign);

            self.patch(&job.id, |j| {
                j.state = JobState::UploadInterrupted;
                j.error_message = Some(message);
                j.mode = None;
            });
            self.note(
                &job.id,
                ActivityEvent::Ended {
                    state: JobState::UploadInterrupted,
                    message: self
                        .get_job(&job.id)
                        .and_then(|j| j.error_message)
                        .as_deref(),
                },
            );

            return true;
        }

        let id = job.id.clone();
        let seq = self.next_seq();
        let cancel = CancellationToken::new();

        st.runtimes.insert(
            id.clone(),
            self.new_runtime(
                seq,
                cancel.clone(),
                RunKind::Resume,
                JobState::UploadInterrupted,
            ),
        );
        self.patch(&id, |j| {
            j.state = JobState::Uploading;
            j.error_message = None;
            j.error_detail = None;
            j.finished_at = None;
            j.mode = None;
        });
        self.note(&id, ActivityEvent::Resuming);
        self.logger
            .info("Upload resumed", Some(json!({ "id": id })));

        let tmp_root = self.tmp_root();
        let input = ResumeUploadInput {
            job_id: id.clone(),
            tmp_dir: job_dir_path(&tmp_root, &public_id),
            public_id,
            payload,
        };
        let hooks = self.hooks(&id, seq, RunKind::Resume);
        let backend = Arc::clone(&self.backend);
        let config = config.clone();

        self.spawn_run(st, id, seq, async move {
            backend
                .resume_upload(input, config, tmp_root, hooks, cancel)
                .await
        });

        true
    }

    fn new_runtime(
        &self,
        seq: u64,
        cancel: CancellationToken,
        kind: RunKind,
        previous_state: JobState,
    ) -> Runtime {
        Runtime {
            seq,
            cancel,
            kind,
            previous_state,
            progress: 0,
            transcode_mark: None,
            upload_mark: None,
            waiting_for_network: false,
            network_wait_since: None,
            last_emit_at: self.now_ms(),
            trailing: None,
        }
    }

    fn hooks(self: &Arc<Self>, id: &str, seq: u64, kind: RunKind) -> Arc<dyn PipelineHooks> {
        Arc::new(QueueHooks {
            queue: Arc::clone(self),
            id: id.to_string(),
            seq,
            kind,
        })
    }

    /// Runs `run` in its own task (a panic becomes an "unexpected error" failure), then the
    /// bookkeeping, then `pump`.
    fn spawn_run<F>(self: &Arc<Self>, st: &mut QueueState, id: String, seq: u64, run: F)
    where
        F: Future<Output = RunOutcome> + Send + 'static,
    {
        st.in_flight += 1;

        let queue = Arc::clone(self);
        let runtime = self.runtime.clone();

        self.runtime.spawn(async move {
            let _in_flight = InFlight(Arc::clone(&queue));
            let outcome = match runtime.spawn(run).await {
                Ok(outcome) => outcome.map_err(RunFailure::Pipeline),
                Err(error) => Err(RunFailure::Unexpected(error.to_string())),
            };

            match outcome {
                Ok(result) => queue.on_done(&id, seq, result),
                Err(failure) => queue.on_failure(&id, seq, failure).await,
            }

            queue.pump();
        });
    }

    /// Removes and returns the runtime of `id` when it is the run `seq`.
    fn take_runtime(st: &mut QueueState, id: &str, seq: u64) -> Option<Runtime> {
        if st.runtimes.get(id).is_some_and(|rt| rt.seq == seq) {
            st.runtimes.remove(id)
        } else {
            None
        }
    }

    fn current_runtime<'a>(st: &'a mut QueueState, id: &str, seq: u64) -> Option<&'a mut Runtime> {
        st.runtimes.get_mut(id).filter(|rt| rt.seq == seq)
    }

    // ---- lifecycle ------------------------------------------------------------------------

    /// Startup recovery. A running job whose upload was prepared (payload + temp dir still on
    /// disk) becomes a resumable `upload_interrupted`; any other running job becomes
    /// `interrupted` and its temp dir is removed. R2 objects are never deleted here.
    pub async fn recover(self: &Arc<Self>) {
        let candidates: Vec<(String, String)> = self.store.read(|d| {
            d.jobs
                .iter()
                .filter(|job| {
                    is_running_state(job.state)
                        && has_register_payload(job)
                        && job.public_id.as_deref().is_some_and(is_valid_public_id)
                })
                .filter_map(|job| Some((job.id.clone(), job.tmp_dir.clone()?)))
                .collect()
        });
        let mut resumable = HashSet::new();

        for (id, tmp_dir) in candidates {
            // The temp files must still be there to resume.
            if self.backend.stat(&tmp_dir).await.is_ok() {
                resumable.insert(id);
            }
        }

        let now = self.iso();
        let (orphans, paused) = {
            let _st = self.lock_state();

            self.store.update(|d| {
                let mut orphans = Vec::new();
                let mut paused = 0usize;

                for job in &mut d.jobs {
                    if job.state == JobState::Waiting && job.mode == Some(JobMode::Resume) {
                        // The app closed before the resume started: back to the paused state.
                        job.mode = None;
                        job.state = JobState::UploadInterrupted;
                        job.error_message = Some(RECOVERED_UPLOAD_MESSAGE.into());
                        job.error_detail = Some(error_detail(JobState::Uploading, None, vec![]));
                        job.updated_at = now.clone();
                        activity::record(
                            job,
                            &now,
                            ActivityEvent::Ended {
                                state: JobState::UploadInterrupted,
                                message: Some(RECOVERED_UPLOAD_MESSAGE),
                            },
                        );
                        paused += 1;
                        continue;
                    }

                    if !is_running_state(job.state) {
                        continue;
                    }

                    if resumable.contains(&job.id) {
                        job.error_detail = Some(error_detail(JobState::Uploading, None, vec![]));
                        job.state = JobState::UploadInterrupted;
                        job.error_message = Some(RECOVERED_UPLOAD_MESSAGE.into());
                        job.finished_at = None;
                        job.updated_at = now.clone();
                        activity::record(
                            job,
                            &now,
                            ActivityEvent::Ended {
                                state: JobState::UploadInterrupted,
                                message: Some(RECOVERED_UPLOAD_MESSAGE),
                            },
                        );
                        paused += 1;
                        continue;
                    }

                    job.error_detail = Some(error_detail(job.state, None, vec![]));
                    job.state = JobState::Interrupted;
                    job.error_message = Some(INTERRUPTED_MESSAGE.into());
                    job.finished_at = Some(now.clone());
                    job.updated_at = now.clone();
                    job.tmp_dir = None;
                    activity::record(
                        job,
                        &now,
                        ActivityEvent::Ended {
                            state: JobState::Interrupted,
                            message: Some(INTERRUPTED_MESSAGE),
                        },
                    );

                    if let Some(public_id) =
                        job.public_id.as_deref().filter(|id| is_valid_public_id(id))
                    {
                        orphans.push(public_id.to_string());
                    }
                }

                (orphans, paused)
            })
        };

        for public_id in &orphans {
            self.remove_tmp_dir(public_id).await;
        }

        if !orphans.is_empty() {
            self.logger.info(
                "Recovered interrupted jobs",
                Some(json!({ "count": orphans.len() })),
            );
        }

        if paused > 0 {
            self.logger
                .info("Recovered paused uploads", Some(json!({ "count": paused })));
        }

        self.changed(None);
        self.pump();
    }

    /// Cancels every running job and waits (bounded) for their cleanup. No new job starts.
    pub async fn shutdown(&self) {
        {
            let mut st = self.lock_state();

            st.shutting_down = true;

            for rt in st.runtimes.values() {
                rt.cancel.cancel();
            }

            if st.in_flight == 0 {
                return;
            }
        }

        let deadline = tokio::time::Instant::now() + self.shutdown_timeout;

        loop {
            let notified = self.tasks_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self.lock_state().in_flight == 0 {
                return;
            }

            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                self.logger
                    .warn("Gave up waiting for running jobs to stop", None);

                return;
            }
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        self.lock_state().shutting_down
    }

    /// Every auth change: after a sign-in, `needs_sign_in` jobs of THIS site are registered
    /// again and waiting jobs start.
    pub fn on_auth_changed(self: &Arc<Self>, state: &AuthState) {
        if self.is_shutting_down() {
            return;
        }

        if state.status == AuthStatus::SignedIn {
            let (retry, noted) = {
                let st = self.lock_state();
                let candidates: Vec<JobRecord> = self.store.read(|d| {
                    d.jobs
                        .iter()
                        .filter(|j| {
                            j.state == JobState::NeedsSignIn && !st.runtimes.contains_key(&j.id)
                        })
                        .cloned()
                        .collect()
                });
                let mut retry = Vec::new();
                let mut noted = Vec::new();

                for job in candidates {
                    match self.foreign_origin(&job) {
                        None => retry.push(job.id.clone()),
                        Some(foreign) => {
                            // Never register (or clean up) against a different site.
                            let message = other_site_message(&foreign);

                            if job.error_message.as_deref() != Some(message.as_str()) {
                                self.patch(&job.id, |j| j.error_message = Some(message));
                                noted.push(job.id.clone());
                            }
                        }
                    }
                }

                (retry, noted)
            };

            for id in retry {
                let _ = self.retry_register(&id);
            }

            for id in noted {
                self.changed(Some(&id));
            }
        }

        self.changed(None);
        self.pump();
    }

    // ---- actions --------------------------------------------------------------------------

    /// Validates and enqueues files. A batch runs smallest first; batches are FIFO.
    pub async fn add_files(self: &Arc<Self>, paths: &[String]) -> AddFilesOutcome {
        let mut rejected = Vec::new();
        let mut valid = Vec::new();

        for path in paths {
            let backend = Arc::clone(&self.backend);
            let checked = validate_video_path(path, self.path_style, move |p: String| async move {
                backend.stat(&p).await
            })
            .await;

            match checked {
                Ok(file) => valid.push(file),
                Err(rejection) => rejected.push(rejection),
            }
        }

        let added = {
            // Dedupe and insert in one critical section so two concurrent adds cannot both pass.
            let _st = self.lock_state();
            let style = self.path_style;
            let mut taken: HashSet<String> = self.store.read(|d| {
                d.jobs
                    .iter()
                    .filter(|job| !is_final_state(job.state))
                    .map(|job| style.path_key(&job.source_path))
                    .collect()
            });
            let mut fresh = Vec::new();

            for file in valid {
                if taken.insert(style.path_key(&file.path)) {
                    fresh.push(file);
                } else {
                    rejected.push(RejectedFile {
                        name: style.base_name(&file.path),
                        reason: REASON_DUPLICATE.into(),
                    });
                }
            }

            fresh.sort_by_key(|file| file.size);

            if !fresh.is_empty() {
                let now = self.iso();
                let records: Vec<JobRecord> = fresh
                    .iter()
                    .map(|file| JobRecord {
                        id: (self.generate_id)(),
                        source_path: file.path.clone(),
                        size_bytes: Number::from(file.size),
                        state: JobState::Waiting,
                        public_id: None,
                        prefix: None,
                        error_message: None,
                        error_detail: None,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                        started_at: None,
                        finished_at: None,
                        site_origin: None,
                        register_payload: Some(Value::Null),
                        tmp_dir: None,
                        register_started: None,
                        mode: None,
                        registered: None,
                        thumbnail_url: None,
                        activity: activity::initial(&now),
                        extra: Map::new(),
                    })
                    .collect();

                self.store.update(|d| d.jobs.extend(records));
            }

            fresh.len()
        };

        if added > 0 {
            self.changed(None);
            self.pump();
        }

        AddFilesOutcome {
            added: added as u32,
            rejected,
        }
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> ActionResult {
        let discard = {
            let mut st = self.lock_state();
            let Some(job) = self.get_job(id) else {
                return fail(NO_JOB);
            };

            if let Some(rt) = st.runtimes.get_mut(id) {
                let first = !rt.cancel.is_cancelled();

                rt.cancel.cancel();
                drop(st);

                if first {
                    self.changed(None);
                }

                return ActionResult::Ok;
            }

            if job.state == JobState::Waiting {
                let resuming = job.mode == Some(JobMode::Resume);
                let finished = self.iso();

                self.note(
                    id,
                    ActivityEvent::Ended {
                        state: JobState::Cancelled,
                        message: None,
                    },
                );

                self.patch(id, |j| {
                    j.state = JobState::Cancelled;
                    j.error_message = Some(CANCELLED_WAITING.into());
                    j.error_detail = None;
                    j.finished_at = Some(finished);

                    if resuming {
                        j.set_register_payload(None);
                        j.mode = None;
                        j.tmp_dir = None;
                    }
                });

                // A queued resume owns kept files; cancelling discards them like a running cancel.
                resuming.then_some(job)
            } else if is_attention_state(job.state) {
                // Files stay on R2: the site may already have registered the video.
                let finished = self.iso();

                self.note(
                    id,
                    ActivityEvent::Ended {
                        state: JobState::Cancelled,
                        message: None,
                    },
                );
                self.patch(id, |j| {
                    j.state = JobState::Cancelled;
                    j.error_message = Some(CANCELLED_ATTENTION.into());
                    j.error_detail = Some(error_detail(JobState::Registering, None, vec![]));
                    j.set_register_payload(None);
                    j.finished_at = Some(finished);
                });

                None
            } else {
                return fail(CANNOT_CANCEL);
            }
        };

        self.changed(None);

        if let Some(job) = discard {
            self.discard_paused_files(&job).await;
        }

        ActionResult::Ok
    }

    /// Re-runs a failed/cancelled/interrupted job from scratch with a NEW public id. For a
    /// paused upload this is "Start over".
    pub async fn retry(self: &Arc<Self>, id: &str) -> ActionResult {
        let (stale_prefix, origin, stale_id) = {
            let st = self.lock_state();
            let Some(job) = self.get_job(id).filter(|_| !st.runtimes.contains_key(id)) else {
                return fail(NO_JOB);
            };

            if !is_retryable_state(job.state) && !is_paused_upload(job.state) {
                return fail(CANNOT_RETRY);
            }

            let stale_prefix = self.stale_prefix_of(&job);

            self.note(
                id,
                ActivityEvent::RetryRequested {
                    paused: is_paused_upload(job.state),
                },
            );
            self.restart_fresh_locked(id);

            (stale_prefix, job.site_origin.clone(), job.public_id.clone())
        };

        self.changed(None);
        self.restart_cleanup(stale_prefix, origin, stale_id).await;

        ActionResult::Ok
    }

    /// The R2 prefix a restart may delete, or `None`. Only partial uploads of failed/cancelled
    /// jobs are certainly unregistered. An `interrupted` job was cut off at an unknown point and
    /// a paused upload whose register call started may be registered: those files are NEVER
    /// deleted automatically.
    fn stale_prefix_of(&self, job: &JobRecord) -> Option<String> {
        if is_paused_upload(job.state) {
            let prefix = job.prefix.clone().or_else(|| payload_prefix(job));

            if job.register_started == Some(true) && prefix.is_some() {
                self.logger.warn(
                    "Restarting a paused upload whose register call may have reached the site; its R2 files were kept and may be orphaned.",
                    Some(json!({ "prefix": prefix, "siteOrigin": job.site_origin })),
                );

                return None;
            }

            return prefix;
        }

        if job.state == JobState::Interrupted && job.prefix.is_some() {
            self.logger.warn(
                "Retrying an interrupted job; its R2 files were kept and may be orphaned.",
                Some(json!({ "prefix": job.prefix, "siteOrigin": job.site_origin })),
            );
        }

        let failed_while_uploading = job
            .error_detail
            .as_ref()
            .and_then(|d| d.get("step"))
            .and_then(Value::as_str)
            == Some("uploading");

        job.prefix
            .clone()
            .filter(|_| job.state != JobState::Interrupted && failed_while_uploading)
    }

    /// Resets the job to `waiting` (a new public id is drawn on start).
    fn restart_fresh_locked(&self, id: &str) {
        self.patch(id, |j| {
            j.state = JobState::Waiting;
            j.public_id = None;
            j.prefix = None;
            j.error_message = None;
            j.error_detail = None;
            j.set_register_payload(None);
            j.registered = None;
            j.started_at = None;
            j.finished_at = None;
            j.tmp_dir = None;
            j.register_started = None;
            j.mode = None;
        });
    }

    /// Removes the old artifacts of a restarted job, then lets it start.
    async fn restart_cleanup(
        self: &Arc<Self>,
        stale_prefix: Option<String>,
        origin: Option<String>,
        stale_id: Option<String>,
    ) {
        if let Some(prefix) = stale_prefix {
            self.cleanup_prefix(&prefix, origin.as_deref()).await;
        }

        if let Some(public_id) = stale_id {
            self.remove_tmp_dir(&public_id).await;
        }

        self.pump();
    }

    /// Continues a paused upload without transcoding again. The job goes through the normal
    /// run loop (it respects maxConcurrent and the start gate).
    pub fn resume(self: &Arc<Self>, id: &str) -> ActionResult {
        {
            let st = self.lock_state();
            let Some(job) = self.get_job(id).filter(|_| !st.runtimes.contains_key(id)) else {
                return fail(NO_JOB);
            };

            if !is_paused_upload(job.state)
                || !has_register_payload(&job)
                || job.public_id.is_none()
            {
                return fail(CANNOT_RESUME);
            }

            if st.shutting_down {
                return fail(APP_CLOSING);
            }

            if self.ctx.auth_state().status != AuthStatus::SignedIn {
                return fail(SIGN_IN_TO_RESUME);
            }

            if let Some(foreign) = self.foreign_origin(&job) {
                return fail(other_site_message(&foreign));
            }

            self.note(id, ActivityEvent::ResumeRequested);
            self.patch(id, |j| {
                j.state = JobState::Waiting;
                j.mode = Some(JobMode::Resume);
                j.error_message = None;
                j.error_detail = None;
                j.finished_at = None;
            });
        }

        self.changed(None);
        self.pump();

        ActionResult::Ok
    }

    /// Finishes registering a job whose files are already on R2 (no re-upload).
    pub fn retry_register(self: &Arc<Self>, id: &str) -> ActionResult {
        {
            let mut st = self.lock_state();
            let Some(job) = self.get_job(id).filter(|_| !st.runtimes.contains_key(id)) else {
                return fail(NO_JOB);
            };
            let payload = job.register_payload_typed();

            let Some(payload) = payload.filter(|_| is_attention_state(job.state)) else {
                return fail(CANNOT_REGISTER);
            };

            if st.shutting_down {
                return fail(APP_CLOSING);
            }

            if self.ctx.auth_state().status != AuthStatus::SignedIn {
                return fail(SIGN_IN_TO_REGISTER);
            }

            if let Some(foreign) = self.foreign_origin(&job) {
                return fail(other_site_message(&foreign));
            }

            let seq = self.next_seq();
            let cancel = CancellationToken::new();

            st.runtimes.insert(
                id.to_string(),
                self.new_runtime(seq, cancel.clone(), RunKind::Register, job.state),
            );
            self.note_transition(id, JobState::Registering);
            self.patch(id, |j| {
                j.state = JobState::Registering;
                j.error_message = None;
            });

            let hooks = self.hooks(id, seq, RunKind::Register);
            let backend = Arc::clone(&self.backend);
            let tmp_root = self.tmp_root();

            self.spawn_run(&mut st, id.to_string(), seq, async move {
                backend
                    .retry_register(payload, tmp_root, hooks, cancel)
                    .await
            });
        }

        self.changed(None);

        ActionResult::Ok
    }

    /// Removes a finished job or a paused upload from the list. A paused upload also loses its
    /// temp dir and (unless the site may already have registered it) its R2 objects.
    pub async fn remove(self: &Arc<Self>, id: &str) -> ActionResult {
        let job = {
            let st = self.lock_state();
            let Some(job) = self.get_job(id) else {
                return fail(NO_JOB);
            };

            if st.runtimes.contains_key(id)
                || !(is_final_state(job.state) || is_paused_upload(job.state))
            {
                return fail(CANNOT_REMOVE);
            }

            self.store.update(|d| d.jobs.retain(|j| j.id != id));

            job
        };

        self.changed(None);

        if is_paused_upload(job.state) {
            self.discard_paused_files(&job).await;
        }

        ActionResult::Ok
    }

    pub fn clear_finished(self: &Arc<Self>) -> ActionResult {
        {
            let st = self.lock_state();

            self.store.update(|d| {
                d.jobs
                    .retain(|j| st.runtimes.contains_key(&j.id) || !is_final_state(j.state));
            });
        }

        self.changed(None);

        ActionResult::Ok
    }

    // ---- run results ----------------------------------------------------------------------

    fn on_done(self: &Arc<Self>, id: &str, seq: u64, result: PipelineResult) {
        {
            let mut st = self.lock_state();

            if Self::take_runtime(&mut st, id, seq).is_none() {
                return;
            }

            let now = self.iso();
            let registered = serde_json::to_value(&result.registered).ok();
            let thumbnail_url = self.completed_thumbnail_url(&result);

            self.store.update(|d| {
                if let Some(job) = d.jobs.iter_mut().find(|j| j.id == id) {
                    job.state = JobState::Done;
                    job.registered = registered;
                    job.thumbnail_url = thumbnail_url;
                    job.prefix = Some(result.prefix.clone());
                    job.public_id = Some(result.registered.public_id.clone());
                    job.set_register_payload(None);
                    job.tmp_dir = None;
                    job.register_started = None;
                    job.mode = None;
                    job.error_message = None;
                    job.error_detail = None;
                    job.finished_at = Some(now.clone());
                    job.updated_at = now.clone();
                    activity::record(job, &now, ActivityEvent::Done);
                }

                d.jobs = cap_history(&d.jobs, MAX_DONE_HISTORY);
            });
        }

        self.logger.info("Job done", Some(json!({ "id": id })));
        self.changed(None);
    }

    /// Public URL of the thumbnail of the video that was just registered, for the job record
    /// (the Queue shows it from there and never asks the site). Built from the register payload
    /// and the R2 public base the app already holds, and validated; `None` when either is
    /// missing. Jobs finished before this field existed keep `None` (no backfill from the
    /// server).
    fn completed_thumbnail_url(&self, result: &PipelineResult) -> Option<String> {
        let r2_base = self.ctx.config().map(|config| config.r2.url);

        VideoLinks::from_registered(&result.registered, &result.payload, r2_base.as_deref())
            .thumbnail_url
            .as_deref()
            .and_then(safe_https_url)
    }

    async fn on_failure(self: &Arc<Self>, id: &str, seq: u64, failure: RunFailure) {
        let after = {
            let mut st = self.lock_state();
            let Some(runtime) = Self::take_runtime(&mut st, id, seq) else {
                return;
            };
            let job = self.get_job(id);
            let error = match failure {
                RunFailure::Pipeline(error) => error,
                RunFailure::Unexpected(detail) => {
                    self.logger.error(
                        "Job failed unexpectedly",
                        Some(json!({ "id": id, "error": detail })),
                    );

                    PipelineError::new(
                        PipelineErrorKind::Failed,
                        job.as_ref().map_or(JobState::Waiting, |j| j.state),
                        UNEXPECTED_ERROR,
                    )
                }
            };

            self.apply_failure_locked(id, job, &runtime, error)
        };

        self.changed(None);

        match after {
            AfterFailure::Nothing => {}
            AfterFailure::Restart {
                stale_prefix,
                origin,
                stale_id,
            } => self.restart_cleanup(stale_prefix, origin, stale_id).await,
            AfterFailure::Cleanup {
                remove_tmp,
                delete_prefix,
            } => {
                if let Some(public_id) = remove_tmp {
                    self.remove_tmp_dir(&public_id).await;
                }

                if let Some((prefix, origin)) = delete_prefix {
                    self.cleanup_prefix(&prefix, origin.as_deref()).await;
                }
            }
        }
    }

    /// Records a failure (called with `state` held). Returns the async work still to do.
    fn apply_failure_locked(
        &self,
        id: &str,
        job: Option<JobRecord>,
        runtime: &Runtime,
        failure: PipelineError,
    ) -> AfterFailure {
        if failure.kind == PipelineErrorKind::Cancelled && runtime.kind == RunKind::Register {
            // Cancelling a register retry only stops that attempt; the uploaded files stay.
            let previous = runtime.previous_state;

            self.note(id, ActivityEvent::RegisterCancelled);
            self.patch(id, |j| {
                j.state = previous;
                j.error_message = Some(REGISTER_CANCELLED.into());
            });

            return AfterFailure::Nothing;
        }

        if failure.kind == PipelineErrorKind::UploadInterrupted {
            if let (true, Some(payload), Some(tmp_dir)) = (
                failure.resumable,
                failure.register_payload.as_ref(),
                failure.tmp_dir.as_ref(),
            ) {
                // Keep everything (R2 objects, temp dir, payload): the user can resume later.
                let message = redact(&failure.message);
                let tmp_dir = tmp_dir.to_string_lossy().into_owned();

                self.note(
                    id,
                    ActivityEvent::Ended {
                        state: JobState::UploadInterrupted,
                        message: Some(&message),
                    },
                );
                self.patch(id, |j| {
                    j.state = JobState::UploadInterrupted;
                    j.error_message = Some(message);
                    j.error_detail = Some(error_detail(JobState::Uploading, None, vec![]));
                    j.set_register_payload(Some(payload));
                    j.tmp_dir = Some(tmp_dir);
                    j.finished_at = None;
                    j.mode = None;

                    if let Some(prefix) = &failure.prefix {
                        j.prefix = Some(prefix.clone());
                    }
                });
                self.logger.info("Upload paused", Some(json!({ "id": id })));

                return AfterFailure::Nothing;
            }

            self.logger.error(
                "Upload stopped but cannot be resumed.",
                Some(json!({ "id": id })),
            );
        }

        if runtime.kind == RunKind::Resume && failure.code.as_deref() == Some(RESUME_UNAVAILABLE) {
            if let Some(job) = &job {
                // The kept temp files are gone (or the temp folder changed): process it again.
                let prefix = job.prefix.clone().or_else(|| failure.prefix.clone());

                self.logger.warn(
                    "Cannot resume the upload; starting over with a new video ID.",
                    Some(json!({ "id": id })),
                );
                self.note(id, ActivityEvent::ResumeUnavailable);
                self.restart_fresh_locked(id);

                return AfterFailure::Restart {
                    stale_prefix: if job.register_started == Some(true) {
                        None
                    } else {
                        prefix
                    },
                    origin: job.site_origin.clone(),
                    stale_id: job.public_id.clone(),
                };
            }
        }

        let kind = match failure.kind {
            PipelineErrorKind::Failed | PipelineErrorKind::UploadInterrupted => JobState::Failed,
            PipelineErrorKind::Cancelled => JobState::Cancelled,
            PipelineErrorKind::RegisterFailed => JobState::RegisterFailed,
            PipelineErrorKind::NeedsSignIn => JobState::NeedsSignIn,
        };
        let stderr_tail: Vec<String> = failure.stderr_tail.iter().map(|l| redact(l)).collect();
        let message = redact(&failure.message);
        let keeps_payload = is_attention_state(kind);
        let finished = self.iso();

        self.note(
            id,
            ActivityEvent::Ended {
                state: kind,
                message: Some(&message),
            },
        );
        self.patch(id, |j| {
            j.state = kind;
            j.error_message = Some(message);
            j.error_detail = Some(error_detail(failure.step, failure.exit_code, stderr_tail));

            if !keeps_payload {
                j.set_register_payload(None);
            } else if let Some(payload) = &failure.register_payload {
                j.set_register_payload(Some(payload));
            } else if j.register_payload.is_none() {
                j.set_register_payload(None);
            }

            // The pipeline removed its temp dir on every outcome except a paused upload.
            j.tmp_dir = None;
            j.mode = None;

            if let Some(prefix) = &failure.prefix {
                j.prefix = Some(prefix.clone());
            }

            j.finished_at = Some(finished);
        });
        self.logger.info(
            "Job ended",
            Some(json!({ "id": id, "kind": super::states::state_name(kind) })),
        );

        // Resume runs and unresumable pauses can leave a temp dir the pipeline did not remove.
        let remove_tmp = (matches!(kind, JobState::Failed | JobState::Cancelled)
            && (runtime.kind == RunKind::Resume
                || failure.kind == PipelineErrorKind::UploadInterrupted))
            .then(|| job.as_ref().and_then(|j| j.public_id.clone()))
            .flatten();

        // A definitive register rejection during a register retry: the files are useless.
        let delete_prefix =
            (kind == JobState::Failed && failure.definitive && runtime.kind == RunKind::Register)
                .then(|| failure.prefix.clone())
                .flatten()
                .map(|prefix| (prefix, job.as_ref().and_then(|j| j.site_origin.clone())));

        AfterFailure::Cleanup {
            remove_tmp,
            delete_prefix,
        }
    }

    // ---- pipeline hooks -------------------------------------------------------------------

    fn hook_stage(&self, id: &str, seq: u64, stage: JobState) {
        {
            let mut st = self.lock_state();
            let Some(rt) = Self::current_runtime(&mut st, id, seq) else {
                return;
            };

            // The network wait only exists while uploading.
            if stage != JobState::Uploading {
                Self::clear_network_wait(rt);
            }

            self.note_transition(id, stage);
            self.patch(id, |j| j.state = stage);
        }

        self.changed(Some(id));
    }

    fn hook_progress(self: &Arc<Self>, id: &str, seq: u64, percent: u32) {
        let emit = {
            let mut st = self.lock_state();
            let Some(rt) = Self::current_runtime(&mut st, id, seq) else {
                return;
            };

            rt.progress = rt.progress.max(percent.min(100));
            self.note_marks(rt, id);
            self.throttle(rt, id)
        };

        if emit {
            self.emit_jobs();
        }
    }

    fn hook_prefix(&self, id: &str, seq: u64, prefix: &str) {
        let mut st = self.lock_state();

        if Self::current_runtime(&mut st, id, seq).is_some() {
            self.patch(id, |j| j.prefix = Some(prefix.to_string()));
        }
    }

    /// Durable before the first PutObject: a crash or a network stall can then be resumed from
    /// the persisted payload and temp dir.
    async fn hook_before_upload(&self, id: &str, seq: u64, info: &BeforeUploadInfo) {
        {
            let mut st = self.lock_state();

            if Self::current_runtime(&mut st, id, seq).is_none() {
                return;
            }

            self.patch(id, |j| {
                j.prefix = Some(info.prefix.clone());
                j.tmp_dir = Some(info.tmp_dir.to_string_lossy().into_owned());
                j.set_register_payload(Some(&info.register_payload));
            });
        }

        self.backend.flush_store().await;
    }

    /// Persists (durably) that the site may register this video from now on.
    async fn hook_before_register(&self, id: &str, seq: u64) {
        {
            let mut st = self.lock_state();

            if Self::current_runtime(&mut st, id, seq).is_none() {
                return;
            }

            self.patch(id, |j| j.register_started = Some(true));
        }

        self.backend.flush_store().await;
    }

    fn hook_network_wait(self: &Arc<Self>, id: &str, seq: u64, info: &NetworkWaitInfo) {
        let (started, emit) = {
            let mut st = self.lock_state();
            let Some(rt) = Self::current_runtime(&mut st, id, seq) else {
                return;
            };
            let started = !rt.waiting_for_network;

            rt.waiting_for_network = true;
            rt.network_wait_since = Some(info.since);

            // Entering the wait is a visible state change; later notifications only refresh.
            (started, !started && self.throttle(rt, id))
        };

        if started {
            self.note(id, ActivityEvent::NetworkWait);
            self.changed(Some(id));
        } else if emit {
            self.emit_jobs();
        }
    }

    fn hook_network_restored(&self, id: &str, seq: u64) {
        {
            let mut st = self.lock_state();
            let Some(rt) = Self::current_runtime(&mut st, id, seq) else {
                return;
            };

            if !rt.waiting_for_network {
                return;
            }

            Self::clear_network_wait(rt);
            self.note(id, ActivityEvent::NetworkRestored);
        }

        self.changed(Some(id));
    }

    fn clear_network_wait(rt: &mut Runtime) {
        rt.waiting_for_network = false;
        rt.network_wait_since = None;
    }

    /// At most one job event per `throttle` for one job. True = emit now; otherwise a single
    /// trailing emit is scheduled (it carries the latest values).
    fn throttle(self: &Arc<Self>, rt: &mut Runtime, id: &str) -> bool {
        let now = self.now_ms();
        let wait = self.throttle_ms - (now - rt.last_emit_at);

        if wait <= 0 {
            rt.last_emit_at = now;

            return true;
        }

        if rt.trailing.is_none() {
            let token = self.next_seq();
            let queue = Arc::clone(self);
            let (id, seq) = (id.to_string(), rt.seq);

            // The deadline is fixed now, not when the timer task first runs.
            let deadline = tokio::time::Instant::now() + Duration::from_millis(wait as u64);

            rt.trailing = Some(token);
            self.runtime.spawn(async move {
                tokio::time::sleep_until(deadline).await;
                queue.fire_trailing(&id, seq, token);
            });
        }

        false
    }

    fn fire_trailing(&self, id: &str, seq: u64, token: u64) {
        {
            let mut st = self.lock_state();
            let now = self.now_ms();
            let Some(rt) = Self::current_runtime(&mut st, id, seq) else {
                return;
            };

            if rt.trailing != Some(token) {
                return;
            }

            rt.trailing = None;
            rt.last_emit_at = now;
        }

        self.emit_jobs();
    }

    // ---- helpers --------------------------------------------------------------------------

    /// Writes the activity line(s) of `event` into the job record, inside the same in-memory
    /// store the state change uses (no extra file write: the store saves debounced). Callers
    /// hold `state`. The texts and the decision to write live in `activity`.
    fn note(&self, id: &str, event: ActivityEvent<'_>) {
        let now = self.iso();

        self.store.update(|d| {
            if let Some(job) = d.jobs.iter_mut().find(|j| j.id == id) {
                activity::record(job, &now, event);
            }
        });
    }

    /// `note` for the job moving from its current state to `to` (call BEFORE the patch that
    /// changes the state).
    fn note_transition(&self, id: &str, to: JobState) {
        let now = self.iso();

        self.store.update(|d| {
            if let Some(job) = d.jobs.iter_mut().find(|j| j.id == id) {
                let from = job.state;

                activity::record(job, &now, ActivityEvent::Transition { from, to });
            }
        });
    }

    /// Progress ticks write nothing unless the transcode or upload crossed a new 10% mark (at
    /// most 9 lines per stage per attempt). The marks already in the record (a resume) are read
    /// once per run.
    fn note_marks(&self, rt: &mut Runtime, id: &str) {
        for kind in MarkKind::ALL {
            let Some(mark) = activity::mark_of(kind, rt.progress) else {
                continue;
            };
            let cache = match kind {
                MarkKind::Transcode => &mut rt.transcode_mark,
                MarkKind::Upload => &mut rt.upload_mark,
            };
            let logged = cache.unwrap_or_else(|| {
                self.store.read(|d| {
                    d.jobs
                        .iter()
                        .find(|j| j.id == id)
                        .map_or(0, |j| activity::logged_mark(kind, &j.activity))
                })
            });

            if mark > logged {
                self.note(id, ActivityEvent::Mark(kind, mark));
            }

            *cache = Some(mark.max(logged));
        }
    }

    /// Persisted state change (a transition, never a progress tick). Callers hold `state`.
    fn patch(&self, id: &str, mutate: impl FnOnce(&mut JobRecord)) {
        let now = self.iso();

        self.store.update(|d| {
            if let Some(job) = d.jobs.iter_mut().find(|j| j.id == id) {
                mutate(job);
                job.updated_at = now;
            }
        });
    }

    /// Immediate emit (state changes). Resets the progress throttle of `id`. Never call with
    /// `state` held.
    fn changed(&self, id: Option<&str>) {
        let mut last_summary = lock(&self.emit_order);
        let (job_listeners, summary_listeners) = {
            let listeners = lock(&self.listeners);
            let jobs: Vec<JobsListener> =
                listeners.jobs.iter().map(|(_, l)| Arc::clone(l)).collect();
            let summaries: Vec<SummaryListener> = listeners
                .summaries
                .iter()
                .map(|(_, l)| Arc::clone(l))
                .collect();

            (jobs, summaries)
        };
        let (jobs, summary) = {
            let mut st = self.lock_state();

            if let Some(id) = id {
                let now = self.now_ms();

                if let Some(rt) = st.runtimes.get_mut(id) {
                    rt.trailing = None;
                    rt.last_emit_at = now;
                }
            }

            let jobs = (!job_listeners.is_empty()).then(|| self.list_locked(&st));
            let summary = (!summary_listeners.is_empty()).then(|| self.summary_locked(&st));

            (jobs, summary)
        };

        if let Some(jobs) = jobs {
            for listener in &job_listeners {
                self.safe(|| listener(&jobs));
            }
        }

        if let Some(summary) = summary {
            if last_summary.as_ref() != Some(&summary) {
                *last_summary = Some(summary.clone());

                for listener in &summary_listeners {
                    self.safe(|| listener(&summary));
                }
            }
        }
    }

    /// Job list only (progress refresh).
    fn emit_jobs(&self) {
        let _order = lock(&self.emit_order);
        let listeners: Vec<JobsListener> = lock(&self.listeners)
            .jobs
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();

        if listeners.is_empty() {
            return;
        }

        let jobs = {
            let st = self.lock_state();

            self.list_locked(&st)
        };

        for listener in &listeners {
            self.safe(|| listener(&jobs));
        }
    }

    fn safe(&self, f: impl FnOnce()) {
        if catch_unwind(AssertUnwindSafe(f)).is_err() {
            self.logger.error("Queue listener failed", None);
        }
    }

    /// The origin the job was uploaded for when it differs from the signed-in site, else
    /// `None`. Records without an origin (older versions) are not bound to a site.
    fn foreign_origin(&self, job: &JobRecord) -> Option<String> {
        let origin = job.site_origin.as_ref()?;

        if Some(origin) == self.ctx.auth_state().site_url.as_ref() {
            None
        } else {
            Some(origin.clone())
        }
    }

    async fn cleanup_prefix(&self, prefix: &str, job_origin: Option<&str>) {
        if let Some(origin) = job_origin {
            if Some(origin) != self.ctx.auth_state().site_url.as_deref() {
                self.logger.warn(
                    "Skipped R2 cleanup: the files belong to a different site.",
                    None,
                );

                return;
            }
        }

        let Some(config) = self.ctx.config() else {
            self.logger
                .warn("Cannot clean up R2 files: no site config is loaded.", None);

            return;
        };

        if let Err(error) = self.backend.delete_prefix(&config, prefix).await {
            self.logger
                .warn("R2 cleanup failed", Some(json!({ "error": error })));
        }
    }

    /// Deletes the temp dir and, when the site cannot have registered it, the R2 objects.
    async fn discard_paused_files(&self, job: &JobRecord) {
        if let Some(prefix) = job.prefix.clone().or_else(|| payload_prefix(job)) {
            if job.register_started == Some(true) {
                self.logger.warn(
                    "Kept the R2 files of a paused upload: the site may have registered it.",
                    Some(json!({ "prefix": prefix })),
                );
            } else {
                self.cleanup_prefix(&prefix, job.site_origin.as_deref())
                    .await;
            }
        }

        if let Some(public_id) = &job.public_id {
            self.remove_tmp_dir(public_id).await;
        }
    }

    /// Removes `<tmp root>/<public id>` (safe API only; an invalid id is ignored).
    async fn remove_tmp_dir(&self, public_id: &str) {
        if !is_valid_public_id(public_id) {
            return;
        }

        let tmp_root = self.tmp_root();

        if let Err(error) = self.backend.remove_job_dir(&tmp_root, public_id).await {
            self.logger.warn(
                "Could not remove a temp directory",
                Some(json!({ "error": error })),
            );
        }
    }
}

/// The hooks one run reports through. Every call is tied to the run's `seq`, so hooks of a run
/// that already ended (or was replaced) are ignored.
struct QueueHooks {
    queue: Arc<JobQueue>,
    id: String,
    seq: u64,
    kind: RunKind,
}

#[async_trait]
impl PipelineHooks for QueueHooks {
    fn on_stage(&self, stage: JobState) {
        self.queue.hook_stage(&self.id, self.seq, stage);
    }

    fn on_progress(&self, percent: u32) {
        self.queue.hook_progress(&self.id, self.seq, percent);
    }

    fn on_prefix(&self, prefix: &str) {
        if self.kind == RunKind::Pipeline {
            self.queue.hook_prefix(&self.id, self.seq, prefix);
        }
    }

    async fn on_before_upload(&self, info: &BeforeUploadInfo) -> io::Result<()> {
        if self.kind == RunKind::Pipeline {
            self.queue
                .hook_before_upload(&self.id, self.seq, info)
                .await;
        }

        Ok(())
    }

    async fn on_before_register(&self) -> io::Result<()> {
        self.queue.hook_before_register(&self.id, self.seq).await;

        Ok(())
    }

    fn on_network_wait(&self, info: &NetworkWaitInfo) {
        if self.kind != RunKind::Register {
            self.queue.hook_network_wait(&self.id, self.seq, info);
        }
    }

    fn on_network_restored(&self) {
        if self.kind != RunKind::Register {
            self.queue.hook_network_restored(&self.id, self.seq);
        }
    }
}
