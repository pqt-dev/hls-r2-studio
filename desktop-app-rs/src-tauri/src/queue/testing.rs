//! Test helpers for the job queue (port of desktop-app/src/main/queue/testHarness.ts): a
//! controllable fake pipeline, fake collaborators and a manual clock.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{Map, Number, Value};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::backend::{QueueBackend, QueueContext, RunOutcome};
use super::file_validation::{FileStat, PathStyle};
use super::job_queue::{JobQueue, JobQueueOptions};
use crate::api::app_config::testing::config;
use crate::api::AppConfig;
use crate::dto::{AuthState, AuthStatus, JobDto, JobState};
use crate::ffmpeg::errors::{cancelled_error, PipelineError, PipelineErrorKind};
use crate::logger::testing::RecordingLogger;
use crate::pipeline::deps::Clock;
use crate::pipeline::job_dir::job_dir_path;
use crate::pipeline::register::{RegisterPayload, RegisteredVideo};
use crate::pipeline::resume::ResumeUploadInput;
use crate::pipeline::run::{PipelineHooks, PipelineJob, PipelineResult};
use crate::store::testing::create_memory_store;
use crate::store::{AppStore, JobRecord};

pub const TMP_ROOT: &str = "/tmp/hls";
pub const SITE: &str = "https://site.example.com";

/// `join('/tmp/hls', id)` as the queue computes it.
pub fn tmp(public_id: &str) -> String {
    job_dir_path(Path::new(TMP_ROOT), public_id)
        .to_string_lossy()
        .into_owned()
}

pub fn payload() -> RegisterPayload {
    RegisterPayload {
        public_id: "aaaaaaaaaaaa".into(),
        title: "t".into(),
        original_filename: "t.mp4".into(),
        original_size_bytes: 1,
        disk_prefix: "2026/01/01/t-aaaaaaaaaaaa/".into(),
        playlist_path: "2026/01/01/t-aaaaaaaaaaaa/playlist.m3u8".into(),
        thumbnail_path: None,
        storyboards: None,
        duration: None,
        output_width: None,
        output_height: None,
        output_fps: None,
        output_bitrate_kbps: None,
        output_codec: None,
    }
}

pub fn payload_value() -> Value {
    serde_json::to_value(payload()).unwrap()
}

pub fn signed_in(site: Option<&str>) -> AuthState {
    AuthState {
        status: AuthStatus::SignedIn,
        username: None,
        site_url: site.map(str::to_string),
        r2_configured: Some(true),
        persisted: None,
        error: None,
    }
}

pub fn signed_out(site: Option<&str>) -> AuthState {
    AuthState {
        site_url: site.map(str::to_string),
        ..AuthState::signed_out()
    }
}

pub fn with_status(status: AuthStatus) -> AuthState {
    AuthState {
        status,
        ..AuthState::signed_out()
    }
}

pub fn failed_error(step: JobState, message: &str) -> PipelineError {
    let mut error = PipelineError::new(PipelineErrorKind::Failed, step, message);

    error.exit_code = Some(1);
    error.stderr_tail = vec!["line 1".into(), "line 2".into()];
    error
}

pub fn error_of(kind: PipelineErrorKind, step: JobState, message: &str) -> PipelineError {
    PipelineError::new(kind, step, message)
}

/// A register failure with the stored payload (`register_failed` / `needs_sign_in`).
pub fn register_error(kind: PipelineErrorKind, message: &str) -> PipelineError {
    let mut error = PipelineError::new(kind, JobState::Registering, message);

    error.register_payload = Some(payload());
    error.prefix = Some(payload().disk_prefix);
    error
}

/// A resumable `upload_interrupted` (R2 objects and temp dir kept).
pub fn interrupted_error() -> PipelineError {
    let mut error = PipelineError::new(
        PipelineErrorKind::UploadInterrupted,
        JobState::Uploading,
        "Upload stopped: the network was unavailable for 30 minutes.",
    );

    error.register_payload = Some(payload());
    error.prefix = Some(payload().disk_prefix);
    error.tmp_dir = Some(PathBuf::from(tmp("aaaaaaaaaaaa")));
    error.resumable = true;
    error
}

/// A bare job record (`base` / `make` of the TS tests).
pub fn record(id: &str, state: JobState) -> JobRecord {
    JobRecord {
        id: id.into(),
        source_path: format!("/v/{id}.mp4"),
        size_bytes: Number::from(1),
        state,
        public_id: None,
        prefix: None,
        error_message: None,
        error_detail: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        started_at: None,
        finished_at: None,
        site_origin: None,
        register_payload: None,
        tmp_dir: None,
        register_started: None,
        mode: None,
        registered: None,
        thumbnail_url: None,
        activity: Vec::new(),
        extra: Map::new(),
    }
}

/// `pausedRecord` of the TS tests: an `upload_interrupted` job of `SITE`.
pub fn paused_record(id: &str) -> JobRecord {
    JobRecord {
        source_path: format!("/v/{id}.mp4"),
        public_id: Some("aaaaaaaaaaaa".into()),
        prefix: Some(payload().disk_prefix),
        error_message: Some("paused".into()),
        error_detail: Some(
            serde_json::json!({ "step": "uploading", "exitCode": null, "stderrTail": [] }),
        ),
        started_at: Some("2026-01-01T00:00:00.000Z".into()),
        register_payload: Some(payload_value()),
        tmp_dir: Some(tmp("aaaaaaaaaaaa")),
        site_origin: Some(SITE.into()),
        ..record(id, JobState::UploadInterrupted)
    }
}

// ---- clocks -------------------------------------------------------------------------------

/// Starts at 2026-01-01T00:00:00Z and only moves with `advance`.
pub struct ManualClock(Mutex<DateTime<Utc>>);

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl ManualClock {
    pub fn new() -> Self {
        Self(Mutex::new(
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    pub fn advance(&self, ms: i64) {
        *self.0.lock().unwrap() += chrono::Duration::milliseconds(ms);
    }

    pub fn ms(&self) -> i64 {
        self.0.lock().unwrap().timestamp_millis()
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

/// Follows tokio's (pausable) clock, like the TS tests' `now: () => new Date(Date.now())` with
/// fake timers.
pub struct TokioClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
}

impl Default for TokioClock {
    fn default() -> Self {
        Self::new()
    }
}

impl TokioClock {
    pub fn new() -> Self {
        Self {
            base: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            start: tokio::time::Instant::now(),
        }
    }
}

impl Clock for TokioClock {
    fn now(&self) -> DateTime<Utc> {
        let elapsed = tokio::time::Instant::now() - self.start;

        self.base + chrono::Duration::milliseconds(elapsed.as_millis() as i64)
    }
}

// ---- fake pipeline -------------------------------------------------------------------------

enum FakeOutcome {
    Done(RunOutcome),
    Panic,
}

/// One call of a fake pipeline function, settled by the test.
pub struct FakeCall<A> {
    pub args: A,
    pub hooks: Arc<dyn PipelineHooks>,
    pub cancel: CancellationToken,
    tx: Mutex<Option<oneshot::Sender<FakeOutcome>>>,
}

pub struct PipelineArgs {
    pub job: PipelineJob,
    pub config: AppConfig,
    pub tmp_root: PathBuf,
}

pub struct RegisterArgs {
    pub payload: RegisterPayload,
}

pub struct ResumeArgs {
    pub input: ResumeUploadInput,
    pub config: AppConfig,
}

pub type FakeRun = FakeCall<PipelineArgs>;
pub type FakeRegisterRun = FakeCall<RegisterArgs>;
pub type FakeResumeRun = FakeCall<ResumeArgs>;

impl<A: Send + Sync + 'static> FakeCall<A> {
    fn settle(&self, outcome: FakeOutcome) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(outcome);
        }
    }

    pub fn reject(&self, error: PipelineError) {
        self.settle(FakeOutcome::Done(Err(error)));
    }

    pub fn resolve_with(&self, result: PipelineResult) {
        self.settle(FakeOutcome::Done(Ok(result)));
    }

    /// The run panics (the TS "rejects with a plain Error").
    pub fn panic(&self) {
        self.settle(FakeOutcome::Panic);
    }

    /// Rejects with a cancelled error as soon as the token is cancelled.
    pub fn cancel_on_abort(self: &Arc<Self>, step: JobState) {
        let call = Arc::clone(self);

        tokio::spawn(async move {
            call.cancel.cancelled().await;
            call.reject(cancelled_error(step));
        });
    }
}

fn registered(id: i64, public_id: &str) -> RegisteredVideo {
    RegisteredVideo {
        id,
        public_id: public_id.to_string(),
        embed_url: format!("{SITE}/embed/{public_id}"),
    }
}

impl FakeRun {
    pub fn resolve(&self) {
        let public_id = self.args.job.public_id.clone();

        self.resolve_with(PipelineResult {
            registered: registered(1, &public_id),
            prefix: format!("2026/01/01/x-{public_id}/"),
            payload: payload(),
        });
    }
}

impl FakeRegisterRun {
    pub fn resolve(&self) {
        self.resolve_with(PipelineResult {
            registered: registered(1, &self.args.payload.public_id),
            prefix: self.args.payload.disk_prefix.clone(),
            payload: self.args.payload.clone(),
        });
    }
}

impl FakeResumeRun {
    pub fn resolve(&self) {
        self.resolve_with(PipelineResult {
            registered: registered(1, &self.args.input.public_id),
            prefix: self.args.input.payload.disk_prefix.clone(),
            payload: self.args.input.payload.clone(),
        });
    }
}

async fn wait_outcome(rx: oneshot::Receiver<FakeOutcome>) -> RunOutcome {
    match rx.await {
        Ok(FakeOutcome::Done(outcome)) => outcome,
        Ok(FakeOutcome::Panic) => panic!("secret internal detail /home/x"),
        Err(_) => std::future::pending().await,
    }
}

#[derive(Default)]
pub struct FakeBackend {
    pub runs: Mutex<Vec<Arc<FakeRun>>>,
    pub register_runs: Mutex<Vec<Arc<FakeRegisterRun>>>,
    pub resume_runs: Mutex<Vec<Arc<FakeResumeRun>>>,
    /// `(bucket, prefix)` of every R2 cleanup.
    pub deleted: Mutex<Vec<(String, String)>>,
    /// Every temp dir removed (`<tmp root>/<public id>`).
    pub removed: Mutex<Vec<String>>,
    /// path -> size; a negative size is a directory.
    pub files: Mutex<HashMap<String, i64>>,
    pub flushes: AtomicUsize,
}

fn call<A>(
    args: A,
    hooks: Arc<dyn PipelineHooks>,
    cancel: CancellationToken,
) -> (Arc<FakeCall<A>>, oneshot::Receiver<FakeOutcome>) {
    let (tx, rx) = oneshot::channel();

    (
        Arc::new(FakeCall {
            args,
            hooks,
            cancel,
            tx: Mutex::new(Some(tx)),
        }),
        rx,
    )
}

#[async_trait]
impl QueueBackend for FakeBackend {
    async fn run_pipeline(
        &self,
        job: PipelineJob,
        config: AppConfig,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        let (run, rx) = call(
            PipelineArgs {
                job,
                config,
                tmp_root,
            },
            hooks,
            cancel,
        );

        self.runs.lock().unwrap().push(run);
        wait_outcome(rx).await
    }

    async fn retry_register(
        &self,
        payload: RegisterPayload,
        _tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        let (run, rx) = call(RegisterArgs { payload }, hooks, cancel);

        self.register_runs.lock().unwrap().push(run);
        wait_outcome(rx).await
    }

    async fn resume_upload(
        &self,
        input: ResumeUploadInput,
        config: AppConfig,
        _tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        let (run, rx) = call(ResumeArgs { input, config }, hooks, cancel);

        self.resume_runs.lock().unwrap().push(run);
        wait_outcome(rx).await
    }

    async fn delete_prefix(&self, config: &AppConfig, prefix: &str) -> Result<(), String> {
        self.deleted
            .lock()
            .unwrap()
            .push((config.r2.bucket.clone(), prefix.to_string()));

        Ok(())
    }

    async fn stat(&self, path: &str) -> io::Result<FileStat> {
        match self.files.lock().unwrap().get(path) {
            None => Err(io::Error::from(io::ErrorKind::NotFound)),
            Some(size) => Ok(FileStat {
                is_file: *size >= 0,
                size: (*size).max(0) as u64,
            }),
        }
    }

    async fn remove_job_dir(&self, tmp_root: &Path, public_id: &str) -> Result<(), String> {
        self.removed.lock().unwrap().push(
            job_dir_path(tmp_root, public_id)
                .to_string_lossy()
                .into_owned(),
        );

        Ok(())
    }

    async fn flush_store(&self) {
        self.flushes.fetch_add(1, Ordering::SeqCst);
    }
}

pub struct FakeContext {
    pub auth: Mutex<AuthState>,
    pub config: Mutex<Option<AppConfig>>,
    pub block: Mutex<Option<String>>,
    pub session: AtomicBool,
}

impl QueueContext for FakeContext {
    fn auth_state(&self) -> AuthState {
        self.auth.lock().unwrap().clone()
    }

    fn has_session(&self) -> bool {
        self.session.load(Ordering::SeqCst)
    }

    fn config(&self) -> Option<AppConfig> {
        self.config.lock().unwrap().clone()
    }

    fn start_block(&self) -> Option<String> {
        self.block.lock().unwrap().clone()
    }
}

// ---- harness -------------------------------------------------------------------------------

pub struct HarnessOptions {
    pub auth: AuthState,
    pub config: Option<AppConfig>,
    pub files: Vec<(&'static str, i64)>,
    pub max_concurrent: i64,
    pub session: bool,
    /// Use a clock that follows tokio time (throttle / timeout tests).
    pub tokio_clock: bool,
}

impl Default for HarnessOptions {
    fn default() -> Self {
        Self {
            auth: signed_in(None),
            config: Some(config()),
            files: vec![],
            max_concurrent: 1,
            session: true,
            tokio_clock: false,
        }
    }
}

pub struct Harness {
    pub queue: Arc<JobQueue>,
    pub store: Arc<AppStore>,
    pub backend: Arc<FakeBackend>,
    pub ctx: Arc<FakeContext>,
    pub clock: Arc<ManualClock>,
    pub logger: Arc<RecordingLogger>,
    pub snapshots: Arc<Mutex<Vec<Vec<JobDto>>>>,
}

impl Harness {
    pub fn new(options: HarnessOptions) -> Self {
        let store = Arc::new(create_memory_store(TMP_ROOT));

        store.load();
        store.update(|d| d.settings.max_concurrent = Number::from(options.max_concurrent));

        let backend = Arc::new(FakeBackend::default());

        backend.files.lock().unwrap().extend(
            options
                .files
                .iter()
                .map(|(path, size)| (path.to_string(), *size)),
        );

        let ctx = Arc::new(FakeContext {
            auth: Mutex::new(options.auth),
            config: Mutex::new(options.config),
            block: Mutex::new(None),
            session: AtomicBool::new(options.session),
        });
        let clock = Arc::new(ManualClock::new());
        let logger = Arc::new(RecordingLogger::default());
        let ids = Arc::new(AtomicUsize::new(0));
        let public_ids = Arc::new(AtomicUsize::new(0));
        let queue_clock: Arc<dyn Clock> = if options.tokio_clock {
            Arc::new(TokioClock::new())
        } else {
            Arc::clone(&clock) as Arc<dyn Clock>
        };
        let queue = JobQueue::new(JobQueueOptions {
            store: Arc::clone(&store),
            backend: Arc::clone(&backend) as Arc<dyn QueueBackend>,
            context: Arc::clone(&ctx) as Arc<dyn QueueContext>,
            clock: queue_clock,
            generate_id: Box::new(move || {
                format!("job-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)
            }),
            generate_public_id: Box::new(move || {
                format!("pub{:09}", public_ids.fetch_add(1, Ordering::SeqCst) + 1)
            }),
            path_style: PathStyle::Posix,
            logger: Arc::clone(&logger) as Arc<dyn crate::logger::Log>,
            runtime: tokio::runtime::Handle::current(),
            throttle: Duration::from_millis(250),
            shutdown_timeout: Duration::from_millis(200),
        });
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&snapshots);

        queue.subscribe(Arc::new(move |jobs: &[JobDto]| {
            sink.lock().unwrap().push(jobs.to_vec());
        }));

        Self {
            queue,
            store,
            backend,
            ctx,
            clock,
            logger,
            snapshots,
        }
    }

    pub fn with(f: impl FnOnce(&mut HarnessOptions)) -> Self {
        let mut options = HarnessOptions::default();

        f(&mut options);
        Self::new(options)
    }

    pub fn runs(&self) -> Vec<Arc<FakeRun>> {
        self.backend.runs.lock().unwrap().clone()
    }

    pub fn run(&self, index: usize) -> Arc<FakeRun> {
        self.runs()[index].clone()
    }

    pub fn register_runs(&self) -> Vec<Arc<FakeRegisterRun>> {
        self.backend.register_runs.lock().unwrap().clone()
    }

    pub fn resume_runs(&self) -> Vec<Arc<FakeResumeRun>> {
        self.backend.resume_runs.lock().unwrap().clone()
    }

    pub fn deleted(&self) -> Vec<(String, String)> {
        self.backend.deleted.lock().unwrap().clone()
    }

    pub fn deleted_prefixes(&self) -> Vec<String> {
        self.deleted().into_iter().map(|(_, p)| p).collect()
    }

    pub fn removed(&self) -> Vec<String> {
        self.backend.removed.lock().unwrap().clone()
    }

    pub fn flushes(&self) -> usize {
        self.backend.flushes.load(Ordering::SeqCst)
    }

    /// Sets the auth state and notifies the queue (like the auth service does), then lets the
    /// started runs reach the fake pipeline.
    pub async fn set_auth(&self, state: AuthState) {
        *self.ctx.auth.lock().unwrap() = state.clone();
        self.queue.on_auth_changed(&state);
        flush().await;
    }

    pub fn set_config(&self, config: Option<AppConfig>) {
        *self.ctx.config.lock().unwrap() = config;
    }

    pub fn set_block(&self, block: Option<&str>) {
        *self.ctx.block.lock().unwrap() = block.map(str::to_string);
    }

    pub fn job(&self, id: &str) -> JobRecord {
        self.queue
            .get_job(id)
            .unwrap_or_else(|| panic!("no job {id}"))
    }

    pub fn push_jobs(&self, jobs: Vec<JobRecord>) {
        self.store.update(|d| d.jobs.extend(jobs));
    }

    pub fn states(&self) -> Vec<String> {
        self.store.read(|d| {
            d.jobs
                .iter()
                .map(|j| format!("{}:{}", j.id, super::states::state_name(j.state)))
                .collect()
        })
    }

    pub fn dto(&self, id: &str) -> JobDto {
        self.queue
            .list()
            .into_iter()
            .find(|j| j.id == id)
            .unwrap_or_else(|| panic!("no dto {id}"))
    }

    pub fn snapshot_count(&self) -> usize {
        self.snapshots.lock().unwrap().len()
    }

    pub fn last_snapshot(&self) -> Vec<JobDto> {
        self.snapshots
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }

    pub fn logged(&self, needle: &str) -> bool {
        self.logger.messages().iter().any(|m| m.contains(needle))
    }

    pub async fn add(&self, paths: &[&str]) -> super::AddFilesOutcome {
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();

        let outcome = self.queue.add_files(&paths).await;

        flush().await;
        outcome
    }
}

/// Lets spawned tasks (runs, bookkeeping, cleanups) run until they wait on something.
pub async fn flush() {
    crate::test_support::tick().await;
}
