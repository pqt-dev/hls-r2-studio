//! The full job pipeline (spec 4.4, port of runPipeline.ts): checks, prefix, probe, transcode,
//! thumbnail, storyboard, upload, register; plus the register-only retry (`retry_register`) and
//! the shared helpers `resume.rs` uses.
//!
//! Entry points for the job queue (M6):
//! - [`run_pipeline`]`(job, config, deps, hooks, cancel)`;
//! - [`retry_register`]`(payload, deps, hooks, cancel)` (`jobs_retry_register`);
//! - `resume::resume_upload` (`jobs_resume`).
//!
//! Failure handling (same as the TS): `upload_interrupted` keeps the R2 objects and the temp
//! dir (`resumable`); `failed` / `cancelled` after the first PutObject delete the R2 prefix
//! (best effort, with a cleanup client); `register_failed` / `needs_sign_in` keep R2; the temp
//! dir is removed in every other case. Paths in the stderr tail are scrubbed.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::api::{AppConfig, AppConfigR2};
use crate::dto::JobState;
use crate::ffmpeg::binaries::Binaries;
use crate::ffmpeg::errors::{cancelled_error, scrub_paths, PipelineError, PipelineErrorKind};
use crate::ffmpeg::runner::ProcessRunner;
use crate::logger::Log;
use crate::pipeline::deps::{
    ClientPurpose, Clock, CommandRunner, FreeSpace, ObjectStore, ObjectStoreFactory, RealFs,
    Sleeper, StepFs, SystemClock, SystemFreeSpace, TokioSleeper,
};
use crate::pipeline::fault::{classify, Fault};
use crate::pipeline::job_dir::{prepare_job_dir, remove_job_dir};
use crate::pipeline::prefix::{build_prefix, is_valid_prefix};
use crate::pipeline::progress_model::{overall_progress, PipelineStage};
use crate::pipeline::public_id::is_valid_public_id;
use crate::pipeline::register::{
    build_register_payload, map_register_error, validate_prefix_length, validate_register_payload,
    BuildRegisterPayloadInput, RegisterClient, RegisterErrorInfo, RegisterFailure, RegisterPayload,
    RegisterRequestError, RegisteredVideo, REGISTER_RETRY_DELAYS_MS,
};
use crate::pipeline::s3::R2ClientFactory;
use crate::pipeline::slug::{base_name_without_extension, slugify};
use crate::pipeline::steps::cleanup::delete_r2_prefix;
use crate::pipeline::steps::env::StepEnv;
use crate::pipeline::steps::probe::{probe_duration, probe_fps, probe_output_info};
use crate::pipeline::steps::storyboard::{generate_storyboards, StoryboardInput};
use crate::pipeline::steps::thumbnail::{generate_thumbnail, ThumbnailInput};
use crate::pipeline::steps::transcode::{transcode_to_hls, TranscodeInput};
use crate::pipeline::steps::upload::{
    upload_directory, NetworkHooks, NetworkWaitInfo, UploadContext, UploadTuning,
};
use crate::pipeline::upload::plan::with_retry;

pub const ALLOWED_EXTENSIONS: [&str; 5] = ["mp4", "mov", "mkv", "avi", "webm"];
pub const DISK_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
pub const DISK_SIZE_FACTOR: f64 = 1.5;

/// Everything the pipeline needs from the outside world (the TS `PipelineDeps`).
#[derive(Clone)]
pub struct PipelineDeps {
    pub binaries: Binaries,
    /// Spawns a child process (kill-tree/priority already bound).
    pub run: Arc<dyn CommandRunner>,
    /// Filesystem of the ffmpeg steps.
    pub fs: Arc<dyn StepFs>,
    /// `createS3Client`.
    pub object_stores: Arc<dyn ObjectStoreFactory>,
    pub register: Arc<dyn RegisterClient>,
    /// Parent folder of the per-job temp directories (`<tmp_root>/<public_id>/`).
    pub tmp_root: PathBuf,
    pub clock: Arc<dyn Clock>,
    /// Waits `ms`; returns early when the token is cancelled.
    pub sleeper: Arc<dyn Sleeper>,
    pub free_space: Arc<dyn FreeSpace>,
    pub logger: Arc<dyn Log>,
    /// Optional encoder thread limit (PHP `FFMPEG_THREADS`).
    pub threads: Option<i64>,
    /// Clock / jitter / stall budget of the upload network-wait policy (tests only).
    pub upload_tuning: UploadTuning,
}

impl PipelineDeps {
    /// The real implementations (`createDefaultDeps`).
    pub fn real(
        binaries: Binaries,
        tmp_root: PathBuf,
        register: Arc<dyn RegisterClient>,
        logger: Arc<dyn Log>,
        threads: Option<i64>,
    ) -> Self {
        Self {
            binaries,
            run: Arc::new(ProcessRunner::new()),
            fs: Arc::new(RealFs),
            object_stores: Arc::new(R2ClientFactory::new()),
            register,
            tmp_root,
            clock: Arc::new(SystemClock),
            sleeper: Arc::new(TokioSleeper),
            free_space: Arc::new(SystemFreeSpace),
            logger,
            threads,
            upload_tuning: UploadTuning::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineJob {
    pub id: String,
    pub source_path: String,
    /// Original file name (title and slug come from it).
    pub filename: String,
    pub public_id: String,
}

/// Given to `on_before_upload` (persisted by the queue so the upload can be resumed).
#[derive(Debug, Clone, PartialEq)]
pub struct BeforeUploadInfo {
    pub prefix: String,
    pub public_id: String,
    pub tmp_dir: PathBuf,
    pub register_payload: RegisterPayload,
}

/// What the queue hears from a run. Every method but `on_stage` / `on_progress` is optional.
#[async_trait]
pub trait PipelineHooks: Send + Sync {
    /// One of `transcoding`, `thumbnail`, `storyboard`, `uploading`, `registering`.
    fn on_stage(&self, stage: JobState);
    /// Whole-number overall percent (0-100), never decreasing.
    fn on_progress(&self, percent: u32);
    /// Called as soon as the R2 prefix is known (so an interrupted job can be cleaned later).
    fn on_prefix(&self, _prefix: &str) {}
    /// Awaited after the `uploading` transition, once thumbnail and storyboard are done and
    /// BEFORE the first PutObject. The queue persists `register_payload` (identical to what is
    /// registered at the end) and `tmp_dir` durably here. An error stops the job.
    async fn on_before_upload(&self, _info: &BeforeUploadInfo) -> io::Result<()> {
        Ok(())
    }
    /// Awaited after the `registering` transition and BEFORE the first register request (the
    /// queue flushes the store here). An error stops the job.
    async fn on_before_register(&self) -> io::Result<()> {
        Ok(())
    }
    /// The upload is waiting for the network (throttled to about one call per 5 s).
    fn on_network_wait(&self, _info: &NetworkWaitInfo) {}
    /// The first upload succeeded after `on_network_wait` was called.
    fn on_network_restored(&self) {}
}

/// Adapts the job hooks to the upload step's network hooks.
pub(crate) struct NetworkHooksOf(pub Arc<dyn PipelineHooks>);

impl NetworkHooks for NetworkHooksOf {
    fn on_network_wait(&self, info: &NetworkWaitInfo) {
        self.0.on_network_wait(info);
    }

    fn on_network_restored(&self) {
        self.0.on_network_restored();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PipelineResult {
    pub registered: RegisteredVideo,
    pub prefix: String,
    pub payload: RegisterPayload,
}

fn stage_of(step: JobState) -> PipelineStage {
    match step {
        JobState::Thumbnail => PipelineStage::Thumbnail,
        JobState::Storyboard => PipelineStage::Storyboard,
        JobState::Uploading => PipelineStage::Upload,
        JobState::Registering => PipelineStage::Register,
        _ => PipelineStage::Transcoding,
    }
}

/// The never-decreasing overall percent, shared with the step callbacks.
pub(crate) struct Reporter {
    overall: Mutex<u32>,
    hooks: Arc<dyn PipelineHooks>,
}

impl Reporter {
    pub(crate) fn new(hooks: Arc<dyn PipelineHooks>) -> Arc<Self> {
        Arc::new(Self {
            overall: Mutex::new(0),
            hooks,
        })
    }

    pub(crate) fn report(&self, stage: PipelineStage, fraction: f64) {
        let mut overall = self.overall.lock().expect("progress lock");
        let next = overall_progress(stage, fraction, *overall);

        if next == *overall {
            return;
        }

        *overall = next;
        self.hooks.on_progress(next);
    }
}

fn hook_failed(error: io::Error) -> Fault {
    Fault::Io(error)
}

struct RunState {
    job_dir: Option<PathBuf>,
    prefix: Option<String>,
    client: Option<Arc<dyn ObjectStore>>,
    upload_started: Arc<AtomicBool>,
    payload: Option<RegisterPayload>,
    step: JobState,
}

/// Runs the whole pipeline for one job. On failure the error is already classified, its
/// `prefix` set and its stderr tail scrubbed; R2 and the temp dir are cleaned as described in
/// the module docs.
pub async fn run_pipeline(
    job: &PipelineJob,
    config: &AppConfig,
    deps: &PipelineDeps,
    hooks: Arc<dyn PipelineHooks>,
    cancel: &CancellationToken,
) -> Result<PipelineResult, PipelineError> {
    let mut state = RunState {
        job_dir: None,
        prefix: None,
        client: None,
        upload_started: Arc::new(AtomicBool::new(false)),
        payload: None,
        step: JobState::Waiting,
    };
    let outcome = execute(job, config, deps, &hooks, cancel, &mut state).await;

    // `finally`: the upload client is dropped (destroyed) whatever happened.
    state.client = None;

    match outcome {
        Ok(result) => {
            remove_job_dir(&deps.tmp_root, state.job_dir.as_deref(), &*deps.logger).await;

            Ok(result)
        }
        Err(fault) => {
            let mut failure = classify(fault, state.step, cancel, &*deps.logger);

            if failure.kind == PipelineErrorKind::UploadInterrupted {
                // Keep the R2 objects and the temp dir: resume_upload needs both.
                failure.resumable = state.payload.is_some() && state.job_dir.is_some();
                failure.register_payload = state.payload.clone();
                failure.tmp_dir = state.job_dir.clone();
            } else {
                // Everything uploaded so far is useless after a failure or cancel.
                let cleans = matches!(
                    failure.kind,
                    PipelineErrorKind::Failed | PipelineErrorKind::Cancelled
                );

                if cleans && state.upload_started.load(Ordering::SeqCst) {
                    if let Some(prefix) = &state.prefix {
                        cleanup_uploaded(&config.r2, deps, prefix).await;
                    }
                }

                remove_job_dir(&deps.tmp_root, state.job_dir.as_deref(), &*deps.logger).await;
            }

            failure.prefix = state.prefix.clone();

            let mut replacements = vec![(job.source_path.clone(), "<source>")];

            if let Some(parent) = Path::new(&job.source_path).parent() {
                replacements.push((parent.to_string_lossy().into_owned(), "<source-dir>"));
            }

            if let Some(dir) = &state.job_dir {
                replacements.push((dir.to_string_lossy().into_owned(), "<job-dir>"));
            }

            replacements.push((deps.tmp_root.to_string_lossy().into_owned(), "<tmp-root>"));
            failure.stderr_tail = scrub_paths(&failure.stderr_tail, &replacements);

            Err(failure)
        }
    }
}

/// Deletes the uploaded files with a dedicated client (cleanup calls may retry).
pub async fn cleanup_uploaded(r2: &AppConfigR2, deps: &PipelineDeps, prefix: &str) {
    match deps.object_stores.create(r2, ClientPurpose::Cleanup) {
        Ok(client) => {
            delete_r2_prefix(&*client, &r2.bucket, prefix, Some(&*deps.logger)).await;
        }
        Err(error) => deps.logger.warn(
            "Cleaning up the R2 prefix failed (best effort).",
            Some(json!({ "error": error.to_string() })),
        ),
    }
}

/// Retries the register call of a job whose files are already on R2 (no upload happens).
pub async fn retry_register(
    payload: &RegisterPayload,
    deps: &PipelineDeps,
    hooks: Arc<dyn PipelineHooks>,
    cancel: &CancellationToken,
) -> Result<PipelineResult, PipelineError> {
    let reporter = Reporter::new(Arc::clone(&hooks));
    let errors = validate_register_payload(payload);

    if !errors.is_empty() {
        deps.logger.error(
            "Stored register payload is invalid.",
            Some(json!({ "errors": errors })),
        );

        return Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Registering,
            "The stored video data is invalid, so it cannot be registered.",
        )
        .with_prefix(&payload.disk_prefix));
    }

    hooks.on_stage(JobState::Registering);
    reporter.report(PipelineStage::Register, 0.0);

    if let Err(error) = hooks.on_before_register().await {
        return Err(classify(
            hook_failed(error),
            JobState::Registering,
            cancel,
            &*deps.logger,
        ));
    }

    let registered = register_with_retry(payload, deps, cancel).await?;

    reporter.report(PipelineStage::Register, 1.0);

    Ok(PipelineResult {
        registered,
        prefix: payload.disk_prefix.clone(),
        payload: payload.clone(),
    })
}

async fn execute(
    job: &PipelineJob,
    config: &AppConfig,
    deps: &PipelineDeps,
    hooks: &Arc<dyn PipelineHooks>,
    cancel: &CancellationToken,
    state: &mut RunState,
) -> Result<PipelineResult, Fault> {
    let reporter = Reporter::new(Arc::clone(hooks));
    let enter = |state: &mut RunState, step: JobState| -> Result<(), Fault> {
        state.step = step;

        if cancel.is_cancelled() {
            return Err(cancelled_error(step).into());
        }

        hooks.on_stage(step);
        reporter.report(stage_of(step), 0.0);

        Ok(())
    };

    // ---- step 0: checks and temp dir ----
    let source_size = check_source(job, deps, cancel).await?;
    let job_dir = prepare_job_dir(&deps.tmp_root, &job.public_id).await?;

    state.job_dir = Some(job_dir.clone());

    // ---- step 1: prefix ----
    let slug = slugify(&base_name_without_extension(&job.filename));
    let prefix = build_prefix(deps.clock.now(), &slug, &job.public_id)
        .ok()
        .filter(|p| is_valid_prefix(p, &job.public_id))
        .ok_or_else(|| {
            PipelineError::new(
                PipelineErrorKind::Failed,
                JobState::Waiting,
                "Could not build a valid upload location for this file name.",
            )
        })?;

    // The server columns are varchar(255): fail now, before anything is processed or uploaded.
    if !validate_prefix_length(&prefix).is_empty() {
        return Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Waiting,
            "The file name is too long to build a valid upload location.",
        )
        .into());
    }

    state.prefix = Some(prefix.clone());
    hooks.on_prefix(&prefix);

    let env = |step: JobState| StepEnv {
        run: Arc::clone(&deps.run),
        fs: Arc::clone(&deps.fs),
        ffmpeg: deps.binaries.ffmpeg.clone(),
        ffprobe: deps.binaries.ffprobe.clone(),
        cwd: job_dir.clone(),
        cancel: cancel.clone(),
        logger: Arc::clone(&deps.logger),
        step,
    };

    // ---- steps 2-3: probe + transcode ----
    enter(state, JobState::Transcoding)?;

    let transcoding = env(JobState::Transcoding);
    let duration = probe_duration(&transcoding, &job.source_path).await?;
    // Like the PHP job, the source fps is only probed when the config does not force one.
    let output_fps = match config.transcode.fps {
        Some(fps) => fps,
        None => probe_fps(&transcoding, &job.source_path).await?,
    };
    let on_fraction = {
        let reporter = Arc::clone(&reporter);

        Arc::new(move |fraction: f64| reporter.report(PipelineStage::Transcoding, fraction))
    };

    transcode_to_hls(
        &transcoding,
        TranscodeInput {
            input: job.source_path.clone(),
            transcode: config.transcode.clone(),
            duration,
            output_fps,
            threads: deps.threads,
            on_fraction,
        },
    )
    .await?;

    let output = probe_output_info(&transcoding, config.transcode.segment_seconds).await?;

    // ---- step 4: thumbnail ----
    enter(state, JobState::Thumbnail)?;

    let has_thumbnail = generate_thumbnail(
        &env(JobState::Thumbnail),
        &ThumbnailInput {
            input: job.source_path.clone(),
            duration,
            width: output.width,
            height: output.height,
        },
    )
    .await?;

    // ---- step 5: storyboard ----
    enter(state, JobState::Storyboard)?;

    let storyboards = generate_storyboards(
        &env(JobState::Storyboard),
        &StoryboardInput {
            input: job.source_path.clone(),
            duration,
            prefix: prefix.clone(),
            threads: deps.threads,
        },
    )
    .await?;
    let storyboard_grids: Vec<u32> = storyboards
        .iter()
        .flat_map(|map| map.keys())
        .filter_map(|key| key.split('x').next()?.parse().ok())
        .collect();

    // ---- step 6: upload ----
    // Everything the register call needs is known now; build it before the first byte is sent.
    let payload = build_register_payload(&BuildRegisterPayloadInput {
        public_id: job.public_id.clone(),
        prefix: prefix.clone(),
        original_filename: job.filename.clone(),
        original_size_bytes: i64::try_from(source_size).unwrap_or(i64::MAX),
        duration,
        has_thumbnail,
        storyboard_grids,
        output: Some(output),
    });
    let problems = validate_register_payload(&payload);

    if !problems.is_empty() {
        deps.logger.error(
            "Built register payload is invalid.",
            Some(json!({ "problems": problems })),
        );

        return Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Registering,
            "Internal error: the video data to register is invalid.",
        )
        .into());
    }

    state.payload = Some(payload.clone());
    enter(state, JobState::Uploading)?;
    hooks
        .on_before_upload(&BeforeUploadInfo {
            prefix: prefix.clone(),
            public_id: job.public_id.clone(),
            tmp_dir: job_dir.clone(),
            register_payload: payload.clone(),
        })
        .await
        .map_err(hook_failed)?;

    let client = deps
        .object_stores
        .create(&config.r2, ClientPurpose::Upload)
        .map_err(|e| Fault::Other(format!("could not create the R2 client: {e}")))?;

    state.client = Some(Arc::clone(&client));

    let upload_started = Arc::clone(&state.upload_started);
    let on_progress = {
        let reporter = Arc::clone(&reporter);

        Arc::new(move |fraction: f64| reporter.report(PipelineStage::Upload, fraction))
    };

    upload_directory(
        UploadContext {
            store: client,
            bucket: config.r2.bucket.clone(),
            prefix: prefix.clone(),
            dir: job_dir.clone(),
            cancel: cancel.clone(),
            sleeper: Arc::clone(&deps.sleeper),
            logger: Arc::clone(&deps.logger),
            on_progress,
            on_upload_started: Arc::new(move || upload_started.store(true, Ordering::SeqCst)),
            network: Arc::new(NetworkHooksOf(Arc::clone(hooks))),
            tuning: deps.upload_tuning.clone(),
        },
        || (),
    )
    .await?;

    // ---- step 7: register ----
    enter(state, JobState::Registering)?;
    hooks.on_before_register().await.map_err(hook_failed)?;

    let registered = register_with_retry(&payload, deps, cancel).await?;

    reporter.report(PipelineStage::Register, 1.0);

    Ok(PipelineResult {
        registered,
        prefix,
        payload,
    })
}

/// `\.([^./\\]+)$` of the source path, lower-cased.
fn extension_of(path: &str) -> String {
    match path.rfind('.') {
        Some(dot) => {
            let ext = &path[dot + 1..];

            if ext.is_empty() || ext.contains(['/', '\\']) {
                String::new()
            } else {
                ext.to_lowercase()
            }
        }
        None => String::new(),
    }
}

/// Step 0: the source must exist, have an allowed extension and fit on disk. Returns its size.
async fn check_source(
    job: &PipelineJob,
    deps: &PipelineDeps,
    cancel: &CancellationToken,
) -> Result<u64, Fault> {
    let fail = |message: &str| -> Fault {
        PipelineError::new(PipelineErrorKind::Failed, JobState::Waiting, message).into()
    };

    if !is_valid_public_id(&job.public_id) {
        return Err(fail("The job has an invalid video ID."));
    }

    if !ALLOWED_EXTENSIONS.contains(&extension_of(&job.source_path).as_str()) {
        return Err(fail(&format!(
            "Unsupported file type. Supported: {}.",
            ALLOWED_EXTENSIONS.join(", ")
        )));
    }

    let size = match tokio::fs::metadata(&job.source_path).await {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return Err(fail("The source file was not found.")),
    };

    if size < 1 {
        return Err(fail("The source file is empty."));
    }

    tokio::fs::create_dir_all(&deps.tmp_root).await?;

    let needed = (size as f64 * DISK_SIZE_FACTOR + DISK_RESERVE_BYTES as f64).ceil();
    let free = deps.free_space.free_bytes(&deps.tmp_root)?;

    if (free as f64) < needed {
        let gb = needed / (1024.0 * 1024.0 * 1024.0);

        return Err(fail(&format!(
            "Not enough free disk space for temporary files (about {gb:.1} GB needed)."
        )));
    }

    if cancel.is_cancelled() {
        return Err(cancelled_error(JobState::Waiting).into());
    }

    Ok(size)
}

/// Register with the backoff of `register.rs` (5 retries: 1, 2, 4, 8, 16 s; 429 may override
/// with Retry-After). A cancel during a backoff sleep never sends another request.
pub async fn register_with_retry(
    payload: &RegisterPayload,
    deps: &PipelineDeps,
    cancel: &CancellationToken,
) -> Result<RegisteredVideo, PipelineError> {
    // Nothing was sent yet, so a cancel here is a plain cancel.
    if cancel.is_cancelled() {
        return Err(cancelled_error(JobState::Registering));
    }

    let last: Mutex<Option<RegisterErrorInfo>> = Mutex::new(None);
    let interrupted = AtomicBool::new(false);
    let result = with_retry(
        |attempt| async move {
            // The backoff sleep returns early on cancel: never send another request after it.
            if attempt > 1 && cancel.is_cancelled() {
                return Err(RegisterRequestError::with_message(
                    RegisterFailure::Network,
                    "aborted before the next register attempt",
                ));
            }

            deps.register.register(payload).await
        },
        &REGISTER_RETRY_DELAYS_MS,
        |ms| {
            let wait = last
                .lock()
                .expect("register lock")
                .as_ref()
                .and_then(|info| info.retry_after_ms)
                .unwrap_or(ms);

            deps.sleeper.sleep(wait, Some(cancel))
        },
        |error: &RegisterRequestError, _attempt| {
            let info = map_register_error(&error.failure);
            let retryable = info.retryable;

            *last.lock().expect("register lock") = Some(info);

            if retryable && cancel.is_cancelled() {
                interrupted.store(true, Ordering::SeqCst);
            }

            retryable && !cancel.is_cancelled()
        },
        |_error, attempt, delay_ms| {
            deps.logger.warn(
                "Register failed; retrying.",
                Some(json!({ "attempt": attempt, "delayMs": delay_ms })),
            );
        },
    )
    .await;

    let error = match result {
        Ok(registered) => return Ok(registered),
        Err(error) => error,
    };
    let info = last
        .lock()
        .expect("register lock")
        .clone()
        .unwrap_or_else(|| map_register_error(&error.failure));

    deps.logger.warn(
        "Register failed.",
        Some(json!({ "error": error.to_string() })),
    );

    let with_payload = |kind: PipelineErrorKind, message: String| {
        let mut failure = PipelineError::new(kind, JobState::Registering, message)
            .with_prefix(&payload.disk_prefix)
            .with_cause(&error);

        failure.register_payload = Some(payload.clone());
        failure
    };

    if info.needs_sign_in {
        return Err(with_payload(
            PipelineErrorKind::NeedsSignIn,
            info.user_message.clone(),
        ));
    }

    if !info.definitive {
        let message = if interrupted.load(Ordering::SeqCst) {
            "Registering was interrupted. The video is uploaded; use Retry to finish.".to_string()
        } else {
            format!(
                "{} The video is uploaded; use Retry to finish registering.",
                info.user_message
            )
        };

        return Err(with_payload(PipelineErrorKind::RegisterFailed, message));
    }

    // Only `playlist_not_found` / `public_id_conflict` are definitive: retrying cannot help.
    let mut failure = PipelineError::new(
        PipelineErrorKind::Failed,
        JobState::Registering,
        info.user_message,
    )
    .with_prefix(&payload.disk_prefix)
    .with_cause(&error);

    failure.definitive = true;

    Err(failure)
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
