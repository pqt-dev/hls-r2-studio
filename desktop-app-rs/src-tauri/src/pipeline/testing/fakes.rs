//! Test doubles for the pipeline (port of testing/fakes.ts): a scripted async ffmpeg runner that
//! writes real files into the job directory, a fake object store (with created/dropped client
//! counts), a fake register client, a recording sleeper with an optional fake clock, and hooks
//! that record everything.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::api::{AppConfig, AppConfigR2, AppConfigTranscode, Resolution};
use crate::dto::JobState;
use crate::ffmpeg::binaries::Binaries;
use crate::ffmpeg::runner::{RunError, RunProcessInput, RunResult};
use crate::logger::testing::RecordingLogger;
use crate::pipeline::deps::{
    ClientPurpose, Clock, CommandRunner, FreeSpace, ListPage, ListedObject, ObjectStore,
    ObjectStoreFactory, PutFileRequest, RealFs, Sleeper, StoreError,
};
use crate::pipeline::register::{
    RegisterClient, RegisterFailure, RegisterPayload, RegisterRequestError, RegisteredVideo,
};
use crate::pipeline::run::{BeforeUploadInfo, PipelineDeps, PipelineHooks};
use crate::pipeline::steps::upload::{NetworkWaitInfo, UploadTuning};
use crate::secure::Secret;

pub const PUBLIC_ID: &str = "ab12cd34ef56";
pub const START_MS: i64 = 1_700_000_000_000;

pub fn test_r2(endpoint: &str) -> AppConfigR2 {
    AppConfigR2 {
        access_key_id: Secret::from(super::fake_s3_server::TEST_ACCESS_KEY),
        secret_access_key: Secret::from(super::fake_s3_server::TEST_SECRET_KEY),
        bucket: "test-bucket".into(),
        endpoint: endpoint.into(),
        url: "https://cdn.example.com".into(),
    }
}

pub fn test_config() -> AppConfig {
    AppConfig {
        r2: test_r2("http://127.0.0.1:9"),
        transcode: AppConfigTranscode {
            resolution: Resolution::P720,
            segment_seconds: 6.0,
            fps: None,
        },
    }
}

// ---- ffmpeg ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    ProbeDuration,
    ProbeFps,
    ProbeOutput,
    Transcode,
    ThumbFrame,
    MeasureSaturation,
    MeasureDetail,
    CropScale,
    Crop,
    Hstack,
    SbCandidates,
    SbTile,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct FakeCall {
    pub kind: CallKind,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

pub fn classify_call(command: &str, args: &[String]) -> CallKind {
    let has = |text: &str| args.iter().any(|a| a.contains(text));
    let starts = |text: &str| args.iter().any(|a| a.starts_with(text));

    if command.contains("ffprobe") {
        return if has("format=duration") {
            CallKind::ProbeDuration
        } else if has("stream=width,height,r_frame_rate") {
            CallKind::ProbeOutput
        } else if has("stream=r_frame_rate") {
            CallKind::ProbeFps
        } else if starts("movie=") {
            if has("edgedetect") {
                CallKind::MeasureDetail
            } else {
                CallKind::MeasureSaturation
            }
        } else {
            CallKind::Unknown
        };
    }

    if args.last().map(String::as_str) == Some("playlist.m3u8") {
        CallKind::Transcode
    } else if has("thumbnail=24") {
        CallKind::ThumbFrame
    } else if starts("scale=") && has("force_original_aspect_ratio") {
        CallKind::CropScale
    } else if starts("crop=") {
        CallKind::Crop
    } else if has("hstack=inputs=3") {
        CallKind::Hstack
    } else if starts("fps=75/") {
        CallKind::SbCandidates
    } else if starts("tile=") {
        CallKind::SbTile
    } else {
        CallKind::Unknown
    }
}

/// Minimal JPEG header (SOI + SOF0) that the image-size reader understands.
pub fn fake_jpeg(width: u16, height: u16) -> Vec<u8> {
    vec![
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        (height >> 8) as u8,
        (height & 255) as u8,
        (width >> 8) as u8,
        (width & 255) as u8,
        0x03,
        0x01,
        0x22,
        0x00,
        0x02,
        0x11,
        0x01,
        0x03,
        0x11,
        0x01,
        0xff,
        0xd9,
    ]
}

type CallPredicate = Box<dyn Fn(&FakeCall) -> bool + Send + Sync>;
type CallOverride = Box<dyn Fn(&FakeCall) -> Option<RunResult> + Send + Sync>;

pub struct FakeRunnerOptions {
    /// ffprobe duration output (`"12"`, `"N/A"`, ...).
    pub duration: String,
    pub fps: String,
    pub output_width: u16,
    pub output_height: u16,
    /// Return a result to replace the default behavior of a call (e.g. a failure).
    pub override_call: Option<CallOverride>,
    /// Return true to keep the call "running" until its cancel token fires.
    pub block_on: Option<CallPredicate>,
}

impl Default for FakeRunnerOptions {
    fn default() -> Self {
        Self {
            duration: "12".into(),
            fps: "30/1".into(),
            output_width: 1280,
            output_height: 720,
            override_call: None,
            block_on: None,
        }
    }
}

pub fn exit_code(code: i32, stderr: &[&str]) -> RunResult {
    RunResult {
        exit_code: Some(code),
        stdout_text: Some(String::new()),
        stderr_tail: stderr.iter().map(|s| (*s).to_string()).collect(),
        ..RunResult::default()
    }
}

/// Scripted ffmpeg/ffprobe: answers like the real tools and writes the expected files.
pub struct FakePipelineRunner {
    options: FakeRunnerOptions,
    pub calls: Mutex<Vec<FakeCall>>,
}

impl FakePipelineRunner {
    pub fn new(options: FakeRunnerOptions) -> Arc<Self> {
        Arc::new(Self {
            options,
            calls: Mutex::new(Vec::new()),
        })
    }

    pub fn kinds(&self) -> Vec<CallKind> {
        self.calls.lock().unwrap().iter().map(|c| c.kind).collect()
    }

    pub fn count(&self, kind: CallKind) -> usize {
        self.kinds().into_iter().filter(|k| *k == kind).count()
    }
}

fn ok(stdout: &str) -> RunResult {
    RunResult {
        exit_code: Some(0),
        stdout_text: Some(stdout.to_string()),
        ..RunResult::default()
    }
}

#[async_trait]
impl CommandRunner for FakePipelineRunner {
    async fn run(&self, mut input: RunProcessInput) -> Result<RunResult, RunError> {
        let call = FakeCall {
            kind: classify_call(&input.command, &input.args),
            command: input.command.clone(),
            args: input.args.clone(),
            cwd: input.cwd.clone(),
        };

        self.calls.lock().unwrap().push(call.clone());

        if self.options.block_on.as_ref().is_some_and(|f| f(&call)) {
            if let Some(cancel) = &input.cancel {
                cancel.cancelled().await;
            }

            return Ok(RunResult {
                exit_code: None,
                aborted: true,
                ..RunResult::default()
            });
        }

        if let Some(result) = self.options.override_call.as_ref().and_then(|f| f(&call)) {
            return Ok(result);
        }

        let cwd = input.cwd.clone().unwrap_or_else(|| PathBuf::from("."));
        let last = input.args.last().cloned().unwrap_or_default();
        let (w, h) = (self.options.output_width, self.options.output_height);
        let write = |name: &str, data: &[u8]| std::fs::write(cwd.join(name), data).unwrap();

        Ok(match call.kind {
            CallKind::ProbeDuration => ok(&format!("{}\n", self.options.duration)),
            CallKind::ProbeFps => ok(&format!("{}\n", self.options.fps)),
            CallKind::ProbeOutput => ok(&serde_json::json!({
                "streams": [{
                    "codec_name": "h264",
                    "width": w,
                    "height": h,
                    "r_frame_rate": "30/1",
                    "bit_rate": "1500000",
                }]
            })
            .to_string()),
            CallKind::MeasureSaturation => ok("40\n"),
            CallKind::MeasureDetail => ok("20\n"),
            CallKind::Transcode => {
                if let Some(on_stdout) = input.on_stdout.as_mut() {
                    on_stdout("out_time_us=3000000\nprogress=continue\n");
                }

                write("playlist.m3u8", b"#EXTM3U\n");
                write("segment_000.ts", &[0; 100]);
                write("segment_001.ts", &[0; 100]);

                if let Some(on_stdout) = input.on_stdout.as_mut() {
                    on_stdout("out_time_us=12000000\nprogress=end\n");
                }

                ok("")
            }
            CallKind::ThumbFrame | CallKind::Crop | CallKind::Hstack => {
                write(&last, &fake_jpeg(w, h));
                ok("")
            }
            CallKind::CropScale => {
                write(&last, &fake_jpeg(1920, 1080));
                ok("")
            }
            CallKind::SbCandidates => {
                for i in 0..75 {
                    write(&format!("candidate_{i:04}.jpg"), &fake_jpeg(160, 160));
                }

                ok("")
            }
            CallKind::SbTile => {
                write(&last, &fake_jpeg(480, 480));
                ok("")
            }
            CallKind::Unknown => exit_code(1, &[]),
        })
    }
}

// ---- object store ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum S3RequestKind {
    Put,
    List,
    Delete,
}

#[derive(Debug, Clone)]
pub struct S3Request {
    pub kind: S3RequestKind,
    pub keys: Vec<String>,
    pub content_type: Option<String>,
}

type FailPut = Box<dyn Fn(&str, usize) -> Option<StoreError> + Send + Sync>;
type FailList = Box<dyn Fn() -> Option<StoreError> + Send + Sync>;
type BlockPut = Box<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Default)]
pub struct FakeS3Options {
    /// Called for each PutObject (key, attempt of that key); return an error to fail it.
    pub fail_put: Option<FailPut>,
    /// Block the PutObject until its cancel token fires when this returns true.
    pub block_put: Option<BlockPut>,
    /// ListObjectsV2 page size (default: everything in one page).
    pub list_page_size: Option<usize>,
    pub fail_list: Option<FailList>,
}

#[derive(Default)]
pub struct FakeS3State {
    pub options: FakeS3Options,
    pub requests: Mutex<Vec<S3Request>>,
    pub objects: Mutex<BTreeMap<String, u64>>,
    attempts: Mutex<HashMap<String, usize>>,
    pub created: AtomicUsize,
    pub destroyed: AtomicUsize,
    pub purposes: Mutex<Vec<ClientPurpose>>,
}

/// Records PutObject / ListObjectsV2 / DeleteObjects calls and keeps the stored keys (with the
/// sent `Content-Length`) in memory. As a factory it counts the clients it hands out and the
/// ones that were dropped (`destroy()` in the TS).
#[derive(Clone, Default)]
pub struct FakeS3(pub Arc<FakeS3State>);

impl FakeS3 {
    pub fn new(options: FakeS3Options) -> Self {
        Self(Arc::new(FakeS3State {
            options,
            ..FakeS3State::default()
        }))
    }

    pub fn put_keys(&self) -> Vec<String> {
        self.requests_of(S3RequestKind::Put)
            .into_iter()
            .flat_map(|r| r.keys)
            .collect()
    }

    pub fn requests_of(&self, kind: S3RequestKind) -> Vec<S3Request> {
        self.0
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.kind == kind)
            .cloned()
            .collect()
    }

    pub fn requests(&self) -> Vec<S3Request> {
        self.0.requests.lock().unwrap().clone()
    }

    pub fn deletes(&self) -> Vec<Vec<String>> {
        self.requests_of(S3RequestKind::Delete)
            .into_iter()
            .map(|r| r.keys)
            .collect()
    }

    pub fn objects(&self) -> BTreeMap<String, u64> {
        self.0.objects.lock().unwrap().clone()
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.objects.lock().unwrap().contains_key(key)
    }

    pub fn set_object(&self, key: &str, size: u64) {
        self.0.objects.lock().unwrap().insert(key.to_string(), size);
    }

    pub fn created(&self) -> usize {
        self.0.created.load(Ordering::SeqCst)
    }

    pub fn destroyed(&self) -> usize {
        self.0.destroyed.load(Ordering::SeqCst)
    }

    pub fn client(&self) -> Arc<dyn ObjectStore> {
        self.0.created.fetch_add(1, Ordering::SeqCst);

        Arc::new(FakeS3Client(Arc::clone(&self.0)))
    }
}

impl ObjectStoreFactory for FakeS3 {
    fn create(
        &self,
        _r2: &AppConfigR2,
        purpose: ClientPurpose,
    ) -> Result<Arc<dyn ObjectStore>, StoreError> {
        self.0.purposes.lock().unwrap().push(purpose);

        Ok(self.client())
    }
}

pub struct FakeS3Client(Arc<FakeS3State>);

impl Drop for FakeS3Client {
    fn drop(&mut self) {
        self.0.destroyed.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl ObjectStore for FakeS3Client {
    async fn list_page(
        &self,
        _bucket: &str,
        prefix: &str,
        _max_keys: Option<usize>,
        token: Option<&str>,
        _cancel: Option<&CancellationToken>,
    ) -> Result<ListPage, StoreError> {
        let state = &self.0;

        if let Some(error) = state.options.fail_list.as_ref().and_then(|f| f()) {
            return Err(error);
        }

        let objects = state.objects.lock().unwrap().clone();
        let all: Vec<(String, u64)> = objects
            .into_iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .collect();
        let start: usize = token.map_or(0, |t| t.parse().unwrap());
        let size = state.options.list_page_size.unwrap_or(all.len()).max(1);
        let page: Vec<(String, u64)> = all.iter().skip(start).take(size).cloned().collect();
        let end = start + page.len();
        let truncated = end < all.len();

        state.requests.lock().unwrap().push(S3Request {
            kind: S3RequestKind::List,
            keys: page.iter().map(|(k, _)| k.clone()).collect(),
            content_type: None,
        });

        Ok(ListPage {
            objects: page
                .into_iter()
                .map(|(key, size)| ListedObject {
                    key,
                    size: Some(size),
                })
                .collect(),
            next_token: truncated.then(|| end.to_string()),
        })
    }

    async fn delete_keys(&self, _bucket: &str, keys: &[String]) -> Result<usize, StoreError> {
        let state = &self.0;

        state.requests.lock().unwrap().push(S3Request {
            kind: S3RequestKind::Delete,
            keys: keys.to_vec(),
            content_type: None,
        });

        let mut objects = state.objects.lock().unwrap();

        for key in keys {
            objects.remove(key);
        }

        Ok(0)
    }

    async fn put_file(
        &self,
        request: PutFileRequest<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), StoreError> {
        let state = &self.0;

        // A real request always yields to the runtime; so does the fake (the other concurrent
        // uploads get to run, like with the TS promises).
        tokio::task::yield_now().await;

        let attempt = {
            let mut attempts = state.attempts.lock().unwrap();
            let entry = attempts.entry(request.key.to_string()).or_insert(0);

            *entry += 1;
            *entry
        };

        state.requests.lock().unwrap().push(S3Request {
            kind: S3RequestKind::Put,
            keys: vec![request.key.to_string()],
            content_type: Some(request.content_type.to_string()),
        });

        if state
            .options
            .block_put
            .as_ref()
            .is_some_and(|f| f(request.key))
        {
            cancel.cancelled().await;

            return Err(StoreError::Cancelled);
        }

        if let Some(error) = state
            .options
            .fail_put
            .as_ref()
            .and_then(|f| f(request.key, attempt))
        {
            return Err(error);
        }

        state
            .objects
            .lock()
            .unwrap()
            .insert(request.key.to_string(), request.content_length);

        Ok(())
    }
}

pub fn net_error() -> StoreError {
    StoreError::Network("read ECONNRESET".into())
}

pub fn http_error(status: u16, code: &str) -> StoreError {
    StoreError::Http {
        status,
        code: Some(code.to_string()),
    }
}

// ---- register -------------------------------------------------------------------------------

pub type RegisterBehavior = Box<
    dyn Fn(&RegisterPayload, usize) -> Result<RegisteredVideo, RegisterRequestError> + Send + Sync,
>;

pub struct FakeRegister {
    pub payloads: Mutex<Vec<RegisterPayload>>,
    behavior: RegisterBehavior,
}

pub fn registered(payload: &RegisterPayload) -> RegisteredVideo {
    RegisteredVideo {
        id: 1,
        public_id: payload.public_id.clone(),
        embed_url: format!("https://site.example/embed/{}", payload.public_id),
    }
}

impl FakeRegister {
    pub fn ok() -> Arc<Self> {
        Self::with(Box::new(|payload, _| Ok(registered(payload))))
    }

    pub fn with(behavior: RegisterBehavior) -> Arc<Self> {
        Arc::new(Self {
            payloads: Mutex::new(Vec::new()),
            behavior,
        })
    }

    pub fn count(&self) -> usize {
        self.payloads.lock().unwrap().len()
    }
}

pub fn network_failure() -> RegisterRequestError {
    RegisterRequestError::new(RegisterFailure::Network)
}

pub fn http_failure(status: u16, error_code: Option<&str>) -> RegisterRequestError {
    RegisterRequestError::new(RegisterFailure::Http {
        status,
        error_code: error_code.map(str::to_string),
        retry_after_seconds: None,
    })
}

#[async_trait]
impl RegisterClient for FakeRegister {
    async fn register(
        &self,
        payload: &RegisterPayload,
    ) -> Result<RegisteredVideo, RegisterRequestError> {
        let attempt = {
            let mut payloads = self.payloads.lock().unwrap();

            payloads.push(payload.clone());
            payloads.len()
        };

        (self.behavior)(payload, attempt)
    }
}

// ---- time -----------------------------------------------------------------------------------

type OnSleep = Box<dyn Fn(u64, usize) + Send + Sync>;

/// Records every wait and returns at once (or blocks until cancelled). With a clock, a wait
/// moves the clock forward, so stall budgets are deterministic.
#[derive(Default)]
pub struct FakeSleeper {
    pub sleeps: Mutex<Vec<u64>>,
    pub clock: Option<Arc<AtomicI64>>,
    /// Called with (ms, 1-based count) before the wait returns (e.g. to cancel the job).
    pub on_sleep: Option<OnSleep>,
    /// Waits until the token is cancelled instead of returning at once.
    pub block: bool,
    pub waiting: tokio::sync::Notify,
}

impl FakeSleeper {
    pub fn with_clock() -> (Arc<Self>, Arc<AtomicI64>) {
        let clock = Arc::new(AtomicI64::new(START_MS));

        (
            Arc::new(Self {
                clock: Some(Arc::clone(&clock)),
                ..Self::default()
            }),
            clock,
        )
    }

    pub fn sleeps(&self) -> Vec<u64> {
        self.sleeps.lock().unwrap().clone()
    }
}

#[async_trait]
impl Sleeper for FakeSleeper {
    async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
        let count = {
            let mut sleeps = self.sleeps.lock().unwrap();

            sleeps.push(ms);
            sleeps.len()
        };

        if let Some(clock) = &self.clock {
            clock.fetch_add(ms as i64, Ordering::SeqCst);
        }

        if let Some(on_sleep) = &self.on_sleep {
            on_sleep(ms, count);
        }

        if self.block {
            self.waiting.notify_one();

            if let Some(token) = cancel {
                token.cancelled().await;
            }
        }
    }
}

/// Tuning that reads the fake clock and adds no jitter.
pub fn fake_tuning(clock: &Arc<AtomicI64>) -> UploadTuning {
    let clock = Arc::clone(clock);

    UploadTuning {
        now: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
        jitter: Some(Arc::new(|_| 0.0)),
        stall_budget_ms: None,
    }
}

pub struct FixedFreeSpace(pub u64);

impl FreeSpace for FixedFreeSpace {
    fn free_bytes(&self, _dir: &Path) -> io::Result<u64> {
        Ok(self.0)
    }
}

pub struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        use chrono::TimeZone;

        chrono::Utc.with_ymd_and_hms(2026, 3, 5, 10, 0, 0).unwrap()
    }
}

// ---- hooks ----------------------------------------------------------------------------------

type BeforeUpload = Box<dyn Fn(&BeforeUploadInfo) -> io::Result<()> + Send + Sync>;
type BeforeRegister = Box<dyn Fn() -> io::Result<()> + Send + Sync>;

#[derive(Default)]
pub struct RecordingHooks {
    pub stages: Mutex<Vec<JobState>>,
    pub percents: Mutex<Vec<u32>>,
    /// Ordered event log: `stage:<state>`, `before-upload`, `before-register`, `wait:<ms>`,
    /// `restored`, `prefix:<prefix>`.
    pub events: Mutex<Vec<String>>,
    pub before_upload_infos: Mutex<Vec<BeforeUploadInfo>>,
    pub waits: Mutex<Vec<NetworkWaitInfo>>,
    pub restored: AtomicUsize,
    pub before_upload: Option<BeforeUpload>,
    pub before_register: Option<BeforeRegister>,
}

impl RecordingHooks {
    pub fn stages(&self) -> Vec<JobState> {
        self.stages.lock().unwrap().clone()
    }

    pub fn percents(&self) -> Vec<u32> {
        self.percents.lock().unwrap().clone()
    }

    pub fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn event(&self, text: String) {
        self.events.lock().unwrap().push(text);
    }
}

fn state_name(state: JobState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[async_trait]
impl PipelineHooks for RecordingHooks {
    fn on_stage(&self, stage: JobState) {
        self.stages.lock().unwrap().push(stage);
        self.event(format!("stage:{}", state_name(stage)));
    }

    fn on_progress(&self, percent: u32) {
        self.percents.lock().unwrap().push(percent);
    }

    fn on_prefix(&self, prefix: &str) {
        self.event(format!("prefix:{prefix}"));
    }

    async fn on_before_upload(&self, info: &BeforeUploadInfo) -> io::Result<()> {
        self.before_upload_infos.lock().unwrap().push(info.clone());
        self.event("before-upload".into());

        match &self.before_upload {
            Some(f) => f(info),
            None => Ok(()),
        }
    }

    async fn on_before_register(&self) -> io::Result<()> {
        self.event("before-register".into());

        match &self.before_register {
            Some(f) => f(),
            None => Ok(()),
        }
    }

    fn on_network_wait(&self, info: &NetworkWaitInfo) {
        self.waits.lock().unwrap().push(*info);
        self.event(format!("wait:{}", info.next_retry_in_ms));
    }

    fn on_network_restored(&self) {
        self.restored.fetch_add(1, Ordering::SeqCst);
        self.event("restored".into());
    }
}

// ---- deps -----------------------------------------------------------------------------------

pub struct TestDepsInput {
    pub runner: Arc<dyn CommandRunner>,
    pub s3: Arc<dyn ObjectStoreFactory>,
    pub register: Arc<dyn RegisterClient>,
    pub tmp_root: PathBuf,
    pub sleeper: Arc<dyn Sleeper>,
    pub free_bytes: u64,
    pub logger: Arc<RecordingLogger>,
    pub tuning: UploadTuning,
}

pub fn make_test_deps(input: TestDepsInput) -> PipelineDeps {
    PipelineDeps {
        binaries: Binaries {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
        },
        run: input.runner,
        fs: Arc::new(RealFs),
        object_stores: input.s3,
        register: input.register,
        tmp_root: input.tmp_root,
        clock: Arc::new(FixedClock),
        sleeper: input.sleeper,
        free_space: Arc::new(FixedFreeSpace(input.free_bytes)),
        logger: input.logger,
        threads: None,
        upload_tuning: input.tuning,
    }
}

pub const PLENTY_OF_SPACE: u64 = 10 * 1024 * 1024 * 1024 * 1024;
