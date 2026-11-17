//! Port of runPipeline.integration.test.ts: the REAL pipeline (real ffmpeg/ffprobe, real
//! filesystem, the real R2 client with SigV4) against the loopback fake S3 server (which checks
//! every signature) and a fake register client. Every test SKIPS (passes with a note) when
//! ffmpeg/ffprobe are not available (`FFMPEG_PATH` / `FFPROBE_PATH` or PATH).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::api::{AppConfig, AppConfigTranscode, Resolution};
use crate::dto::JobState;
use crate::ffmpeg::args::SOURCE_FORMAT_WHITELIST;
use crate::ffmpeg::binaries::{command_exists, resolve_binaries, Platform, ResolveBinariesInput};
use crate::ffmpeg::errors::PipelineErrorKind;
use crate::ffmpeg::runner::{ProcessRunner, RunError, RunProcessInput, RunResult};
use crate::logger::testing::RecordingLogger;
use crate::pipeline::deps::{CommandRunner, RealFs, SystemFreeSpace};
use crate::pipeline::resume::{resume_upload, ResumeUploadInput};
use crate::pipeline::run::{retry_register, run_pipeline, PipelineDeps, PipelineJob};
use crate::pipeline::s3::{R2ClientFactory, R2ClientOptions, SOCKET_TIMEOUT};
use crate::pipeline::steps::env::StepEnv;
use crate::pipeline::steps::image_size::jpeg_size;
use crate::pipeline::steps::probe::{probe_duration, probe_fps};
use crate::pipeline::steps::transcode::{transcode_to_hls, TranscodeInput};
use crate::pipeline::testing::fake_s3_server::{
    options, Fail, FailWhen, FakeS3Server, RequestType,
};
use crate::pipeline::testing::fakes::{
    fake_tuning, network_failure, test_r2, FakeRegister, FakeSleeper, FixedClock, RecordingHooks,
    PUBLIC_ID,
};

const BUCKET: &str = "test-bucket";
const DATE_PREFIX: &str = "2026/03/05/";

fn tools() -> Option<(String, String)> {
    let env = |key: &str| std::env::var(key).ok();
    let found = resolve_binaries(&ResolveBinariesInput {
        platform: Platform::current(),
        resources_dir: "",
        env: &env,
        is_packaged: false,
    });

    if command_exists(&found.ffmpeg) && command_exists(&found.ffprobe) {
        Some((found.ffmpeg, found.ffprobe))
    } else {
        eprintln!(
            "[integration] SKIPPED: ffmpeg/ffprobe not found (set FFMPEG_PATH / FFPROBE_PATH or use PATH)"
        );
        None
    }
}

async fn ffmpeg(tool: &str, cwd: &Path, args: &[&str], collect: bool) -> RunResult {
    let mut input = RunProcessInput::new(
        tool,
        args.iter().map(|s| (*s).to_string()).collect(),
        Duration::from_secs(180),
    );

    input.cwd = Some(cwd.to_path_buf());
    input.collect_stdout = collect;

    ProcessRunner::new().run(input).await.unwrap()
}

/// A test video (`testsrc2` + optional sine audio, libx264 ultrafast). `None` when this ffmpeg
/// cannot encode it (the test then skips).
async fn generate(
    ffmpeg_path: &str,
    file: &Path,
    size: &str,
    seconds: u32,
    audio: bool,
) -> Option<()> {
    let video = format!("testsrc2=size={size}:rate=30:duration={seconds}");
    let sine = format!("sine=frequency=440:duration={seconds}");
    let mut args: Vec<&str> = vec!["-y", "-f", "lavfi", "-i", &video];

    if audio {
        args.extend(["-f", "lavfi", "-i", &sine]);
    }

    args.extend([
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
    ]);

    if audio {
        args.extend(["-c:a", "aac", "-shortest"]);
    }

    let target = file.to_string_lossy().into_owned();

    args.push(&target);

    let result = ffmpeg(ffmpeg_path, file.parent().unwrap(), &args, false).await;

    if result.exit_code == Some(0) {
        Some(())
    } else {
        eprintln!("[integration] SKIPPED: could not generate {target}");
        None
    }
}

/// Counts every process the pipeline spawns, and the transcode runs among them.
struct CountingRunner {
    inner: ProcessRunner,
    all: AtomicUsize,
    transcodes: AtomicUsize,
    transcode_started: tokio::sync::Notify,
}

#[async_trait]
impl CommandRunner for CountingRunner {
    async fn run(&self, input: RunProcessInput) -> Result<RunResult, RunError> {
        self.all.fetch_add(1, Ordering::SeqCst);

        if input.args.last().map(String::as_str) == Some("playlist.m3u8") {
            self.transcodes.fetch_add(1, Ordering::SeqCst);
            self.transcode_started.notify_one();
        }

        self.inner.run(input).await
    }
}

struct Env {
    _dir: tempfile::TempDir,
    work: PathBuf,
    tmp_root: PathBuf,
    server: FakeS3Server,
    runner: Arc<CountingRunner>,
    register: Arc<FakeRegister>,
    sleeper: Arc<FakeSleeper>,
    hooks: Arc<RecordingHooks>,
    cancel: CancellationToken,
    deps: PipelineDeps,
    config: AppConfig,
}

async fn setup(
    fail_when: Option<FailWhen>,
    register: Option<Arc<FakeRegister>>,
    fake_clock: bool,
) -> Option<Env> {
    let (ffmpeg_path, ffprobe_path) = tools()?;
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().to_path_buf();
    let tmp_root = work.join("tmp");
    let mut server_options = options(BUCKET);

    server_options.fail_when = fail_when;

    let server = FakeS3Server::start(server_options).await;
    let runner = Arc::new(CountingRunner {
        inner: ProcessRunner::new(),
        all: AtomicUsize::new(0),
        transcodes: AtomicUsize::new(0),
        transcode_started: tokio::sync::Notify::new(),
    });
    let register = register.unwrap_or_else(FakeRegister::ok);
    let (sleeper, tuning) = if fake_clock {
        let (sleeper, clock) = FakeSleeper::with_clock();

        (sleeper, fake_tuning(&clock))
    } else {
        (Arc::new(FakeSleeper::default()), Default::default())
    };
    let deps = PipelineDeps {
        binaries: crate::ffmpeg::binaries::Binaries {
            ffmpeg: ffmpeg_path,
            ffprobe: ffprobe_path,
        },
        run: runner.clone(),
        fs: Arc::new(RealFs),
        object_stores: Arc::new(R2ClientFactory::with_options(
            R2ClientOptions::loopback_for_tests(SOCKET_TIMEOUT),
        )),
        register: register.clone(),
        tmp_root: tmp_root.clone(),
        clock: Arc::new(FixedClock),
        sleeper: sleeper.clone(),
        free_space: Arc::new(SystemFreeSpace),
        logger: Arc::new(RecordingLogger::default()),
        threads: None,
        upload_tuning: tuning,
    };
    let config = AppConfig {
        r2: test_r2(&server.endpoint),
        transcode: AppConfigTranscode {
            resolution: Resolution::P720,
            segment_seconds: 6.0,
            fps: None,
        },
    };

    Some(Env {
        _dir: dir,
        work,
        tmp_root,
        server,
        runner,
        register,
        sleeper,
        hooks: Arc::new(RecordingHooks::default()),
        cancel: CancellationToken::new(),
        deps,
        config,
    })
}

impl Env {
    async fn source(&self, name: &str, size: &str, seconds: u32, audio: bool) -> Option<PathBuf> {
        let file = self.work.join(name);

        generate(&self.deps.binaries.ffmpeg, &file, size, seconds, audio).await?;

        Some(file)
    }

    fn job(&self, file: &Path, name: &str) -> PipelineJob {
        PipelineJob {
            id: "job".into(),
            source_path: file.to_string_lossy().into_owned(),
            filename: name.into(),
            public_id: PUBLIC_ID.into(),
        }
    }

    async fn run(
        &self,
        file: &Path,
        name: &str,
    ) -> Result<crate::pipeline::run::PipelineResult, crate::ffmpeg::errors::PipelineError> {
        run_pipeline(
            &self.job(file, name),
            &self.config,
            &self.deps,
            self.hooks.clone(),
            &self.cancel,
        )
        .await
    }

    fn job_dir_exists(&self) -> bool {
        self.tmp_root.join(PUBLIC_ID).exists()
    }

    async fn image_size(&self, key: &str) -> (u32, u32) {
        let data = self.server.objects().get(key).cloned().expect(key);
        let size = jpeg_size(&data).expect("jpeg");

        (size.width, size.height)
    }

    fn deleted(&self) -> bool {
        self.server
            .requests()
            .iter()
            .any(|r| r.kind == RequestType::Delete)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn processes_a_landscape_video_end_to_end() {
    let Some(env) = setup(None, None, false).await else {
        return;
    };
    let name = "Video Mẫu Tiếng Việt (1).mp4";
    let Some(source) = env.source(name, "1280x720", 12, true).await else {
        return;
    };
    let result = env.run(&source, name).await.unwrap();
    let prefix = format!("{DATE_PREFIX}video-mau-tieng-viet-1-{PUBLIC_ID}/");

    assert_eq!(result.prefix, prefix);

    // Keys and order.
    let puts = env.server.puts();
    let keys: Vec<String> = puts.iter().map(|p| p.key.clone()).collect();

    assert!(keys.iter().all(|k| k.starts_with(&prefix)));
    assert_eq!(keys.last().unwrap(), &format!("{prefix}playlist.m3u8"));

    let mut names: Vec<String> = keys.iter().map(|k| k[prefix.len()..].to_string()).collect();

    names.sort();
    names.dedup();

    assert_eq!(names.len(), keys.len());

    let segments: Vec<&String> = names.iter().filter(|n| n.starts_with("segment_")).collect();

    assert_eq!(segments.len(), 2);
    assert_eq!(
        names
            .iter()
            .filter(|n| !n.starts_with("segment_"))
            .collect::<Vec<_>>(),
        [
            "playlist.m3u8",
            "storyboard_3x3.jpg",
            "storyboard_4x4.jpg",
            "storyboard_5x5.jpg",
            "thumbnail.jpg"
        ]
    );

    let objects = env.server.objects();

    assert_eq!(objects.len(), keys.len());

    // Headers.
    for put in &puts {
        let expected = if put.key.ends_with(".m3u8") {
            "application/vnd.apple.mpegurl"
        } else if put.key.ends_with(".ts") {
            "video/mp2t"
        } else {
            "image/jpeg"
        };

        assert_eq!(put.header("content-type"), Some(expected));
        assert_eq!(put.header("x-amz-acl"), None);
        assert_eq!(put.header("cache-control"), None);
        assert_eq!(put.header("transfer-encoding"), None);
        assert_eq!(put.header("x-amz-checksum-crc32"), None);
        assert_eq!(
            put.header("content-length").map(str::to_string),
            Some(objects[&put.key].len().to_string())
        );
        assert_eq!(put.signature_ok, Some(true));
        assert!(put.bytes > 0);
    }

    // Images.
    assert_eq!(
        env.image_size(&format!("{prefix}thumbnail.jpg")).await,
        (1080, 1080)
    );

    for (grid, size) in [("3x3", 480), ("4x4", 640), ("5x5", 800)] {
        assert_eq!(
            env.image_size(&format!("{prefix}storyboard_{grid}.jpg"))
                .await,
            (size, size)
        );
    }

    // Playlist content references the uploaded segments.
    let playlist =
        String::from_utf8_lossy(&objects[&format!("{prefix}playlist.m3u8")]).into_owned();

    for segment in &segments {
        assert!(playlist.contains(segment.as_str()));
    }

    // Register payload.
    let payloads = env.register.payloads.lock().unwrap().clone();

    assert_eq!(payloads.len(), 1);

    let p = &payloads[0];

    assert_eq!(p.title, "Video Mẫu Tiếng Việt (1)");
    assert_eq!(p.original_filename, name);
    assert_eq!(p.disk_prefix, prefix);
    assert_eq!(p.thumbnail_path, Some(format!("{prefix}thumbnail.jpg")));
    assert_eq!((p.output_width, p.output_height), (Some(1280), Some(720)));
    assert_eq!(p.output_fps, Some(30.0));
    assert_eq!(p.output_codec.as_deref(), Some("h264"));
    assert_eq!(p.storyboards.as_ref().unwrap().len(), 3);
    assert!(p.duration.unwrap() > 11.5 && p.duration.unwrap() < 12.5);
    assert!(p.output_bitrate_kbps.unwrap() > 0);

    // Progress, stages, cleanup.
    assert_eq!(
        env.hooks.stages(),
        [
            JobState::Transcoding,
            JobState::Thumbnail,
            JobState::Storyboard,
            JobState::Uploading,
            JobState::Registering
        ]
    );

    let percents = env.hooks.percents();
    let mut sorted = percents.clone();

    sorted.sort_unstable();

    assert_eq!(sorted, percents);
    assert_eq!(percents.last(), Some(&100));
    assert!(!env.job_dir_exists());
    assert!(!env.deleted());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn processes_a_portrait_video_with_a_vietnamese_file_name() {
    let Some(env) = setup(None, None, false).await else {
        return;
    };
    let name = "Video Dọc Mẫu (2).mp4";
    let Some(source) = env.source(name, "720x1280", 12, true).await else {
        return;
    };

    env.run(&source, name).await.unwrap();

    let prefix = format!("{DATE_PREFIX}video-doc-mau-2-{PUBLIC_ID}/");
    let payload = env.register.payloads.lock().unwrap()[0].clone();

    assert_eq!(
        env.image_size(&format!("{prefix}thumbnail.jpg")).await,
        (1080, 1080)
    );
    assert_eq!(
        (payload.output_width, payload.output_height),
        (Some(720), Some(1280))
    );
    assert_eq!(payload.disk_prefix, prefix);
    assert_eq!(
        env.server.puts().last().unwrap().key,
        format!("{prefix}playlist.m3u8")
    );
    assert!(!env.job_dir_exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handles_a_1_second_clip_and_a_video_without_audio() {
    let Some(env) = setup(None, None, false).await else {
        return;
    };
    let Some(short) = env.source("Clip ngắn.mov", "640x360", 1, true).await else {
        return;
    };

    env.run(&short, "Clip ngắn.mov").await.unwrap();

    let prefix = format!("{DATE_PREFIX}clip-ngan-{PUBLIC_ID}/");

    // Short path: the frame is written as is (no smart crop to 1080x1080).
    assert_eq!(
        env.image_size(&format!("{prefix}thumbnail.jpg")).await,
        (640, 360)
    );
    assert!(env.register.payloads.lock().unwrap()[0].duration.unwrap() < 1.5);
    assert!(!env.job_dir_exists());

    let Some(env) = setup(None, None, false).await else {
        return;
    };
    let Some(silent) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };

    env.run(&silent, "Không có tiếng.mkv").await.unwrap();

    let prefix = format!("{DATE_PREFIX}khong-co-tieng-{PUBLIC_ID}/");

    assert!(env
        .server
        .objects()
        .contains_key(&format!("{prefix}playlist.m3u8")));
    assert_eq!(
        env.register.payloads.lock().unwrap()[0]
            .output_codec
            .as_deref(),
        Some("h264")
    );
    assert!(!env.job_dir_exists());
}

#[cfg(unix)]
fn processes_matching(needle: &str) -> usize {
    std::process::Command::new("pgrep")
        .args(["-f", needle])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        })
        .unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn abort_during_the_transcode_kills_ffmpeg_and_cleans_the_temp_dir_and_r2() {
    let Some(mut env) = setup(None, None, false).await else {
        return;
    };
    let name = "long source for abort m5.mp4";
    let Some(source) = env.source(name, "1280x720", 40, false).await else {
        return;
    };

    env.config.transcode.resolution = Resolution::P1080;

    let runner = Arc::clone(&env.runner);
    let cancel = env.cancel.clone();
    let (result, ()) = tokio::join!(env.run(&source, name), async move {
        runner.transcode_started.notified().await;
        tokio::time::sleep(Duration::from_millis(800)).await;

        #[cfg(unix)]
        assert!(processes_matching(name) > 0);

        cancel.cancel();
    });
    let error = result.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Cancelled);
    assert!(!error.message.contains(&*env.work.to_string_lossy()));

    #[cfg(unix)]
    {
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(processes_matching(name), 0);
    }

    assert!(!env.job_dir_exists());
    assert_eq!(std::fs::read_dir(&env.tmp_root).unwrap().count(), 0);
    assert!(env.server.objects().is_empty());
    assert!(env.server.puts().is_empty());
    assert_eq!(env.register.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_persistent_http_403_on_the_3rd_uploaded_file_fails_the_job_and_cleans_the_prefix() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let order = Arc::clone(&seen);
    let Some(env) = setup(
        Some(Box::new(move |request, _| {
            if request.kind != RequestType::Put {
                return None;
            }

            let mut seen = order.lock().unwrap();

            if !seen.contains(&request.key) {
                seen.push(request.key.clone());
            }

            (seen.iter().position(|k| *k == request.key) == Some(2))
                .then_some(Fail::Status(403, "AccessDenied"))
        })),
        None,
        false,
    )
    .await
    else {
        return;
    };
    let Some(source) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };
    let error = env.run(&source, "Không có tiếng.mkv").await.unwrap_err();
    let failed_key = seen.lock().unwrap()[2].clone();

    assert_eq!(
        (error.kind, error.step),
        (PipelineErrorKind::Failed, JobState::Uploading)
    );
    // 3 attempts of ours (delays 1 s, 2 s). The client never retries streamed bodies itself.
    assert_eq!(env.sleeper.sleeps(), [1000, 2000]);
    assert_eq!(
        env.server
            .puts()
            .iter()
            .filter(|p| p.key == failed_key)
            .count(),
        3
    );
    assert!(!env
        .server
        .puts()
        .iter()
        .any(|p| p.key.ends_with("playlist.m3u8")));
    assert!(env.deleted());
    assert!(env.server.objects().is_empty());
    assert_eq!(env.register.count(), 0);
    assert!(!env.job_dir_exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recovers_when_an_upload_fails_a_few_times_and_then_succeeds() {
    let failures = Arc::new(Mutex::new(0usize));
    let counter = Arc::clone(&failures);
    let Some(env) = setup(
        Some(Box::new(move |request, _| {
            if request.kind != RequestType::Put || !request.key.ends_with("segment_000.ts") {
                return None;
            }

            let mut failed = counter.lock().unwrap();

            (*failed < 2).then(|| {
                *failed += 1;

                Fail::Status(500, "InternalError")
            })
        })),
        None,
        true,
    )
    .await
    else {
        return;
    };
    let Some(source) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };

    env.run(&source, "Không có tiếng.mkv").await.unwrap();

    assert_eq!(*failures.lock().unwrap(), 2);
    assert!(env.server.objects().len() > 5);
    assert_eq!(env.register.count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn register_failing_6_times_keeps_r2_and_retry_register_succeeds_without_a_new_upload() {
    let failing = FakeRegister::with(Box::new(|_, _| Err(network_failure())));
    let Some(mut env) = setup(None, Some(failing), false).await else {
        return;
    };
    let Some(source) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };
    let error = env.run(&source, "Không có tiếng.mkv").await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert_eq!(env.register.count(), 6);
    assert_eq!(env.sleeper.sleeps(), [1000, 2000, 4000, 8000, 16000]);
    assert!(!env.deleted());
    assert!(env.server.objects().len() > 5);
    assert!(!env.job_dir_exists());

    let payload = error.register_payload.unwrap();

    assert!(payload.playlist_path.ends_with("playlist.m3u8"));

    let puts_before = env.server.puts().len();
    let second = FakeRegister::ok();

    env.deps.register = second.clone();

    let result = retry_register(&payload, &env.deps, env.hooks.clone(), &env.cancel)
        .await
        .unwrap();

    assert_eq!(result.registered.public_id, PUBLIC_ID);
    assert_eq!(
        *second.payloads.lock().unwrap(),
        std::slice::from_ref(&payload)
    );
    assert_eq!(env.server.puts().len(), puts_before);
    assert!(env.server.objects().contains_key(&payload.playlist_path));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transient_outage_finishes_the_job_without_transcoding_again() {
    let puts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&puts);
    let Some(env) = setup(
        Some(Box::new(move |request, _| {
            if request.kind != RequestType::Put {
                return None;
            }

            match counter.fetch_add(1, Ordering::SeqCst) + 1 {
                1..=4 => Some(Fail::Destroy),
                5..=7 => Some(Fail::Status(503, "SlowDown")),
                _ => None,
            }
        })),
        None,
        true,
    )
    .await
    else {
        return;
    };
    let Some(source) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };
    let result = env.run(&source, "Không có tiếng.mkv").await.unwrap();

    assert_eq!(result.registered.public_id, PUBLIC_ID);
    assert_eq!(env.runner.transcodes.load(Ordering::SeqCst), 1);
    assert!(env.sleeper.sleeps().len() >= 7);
    assert!(env
        .sleeper
        .sleeps()
        .iter()
        .all(|ms| [2000, 5000, 10000, 20000, 30000, 60000].contains(ms)));
    assert!(!env.hooks.waits.lock().unwrap().is_empty());
    assert!(env.hooks.restored.load(Ordering::SeqCst) >= 1);
    assert!(!env.deleted());

    let names: Vec<String> = env
        .server
        .objects()
        .keys()
        .map(|k| k[result.prefix.len()..].to_string())
        .collect();

    for expected in ["playlist.m3u8", "thumbnail.jpg", "storyboard_3x3.jpg"] {
        assert!(names.iter().any(|n| n == expected), "{expected}");
    }

    assert_eq!(
        *env.register.payloads.lock().unwrap(),
        std::slice::from_ref(&result.payload)
    );
    assert!(!env.job_dir_exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_permanent_outage_is_upload_interrupted_and_resume_finishes_with_zero_ffmpeg_runs() {
    let outage = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let puts = Arc::new(AtomicUsize::new(0));
    let (flag, counter) = (Arc::clone(&outage), Arc::clone(&puts));
    let Some(env) = setup(
        Some(Box::new(move |request, _| {
            if request.kind != RequestType::Put || !flag.load(Ordering::SeqCst) {
                return None;
            }

            // The first 3 files get through, then the connection dies for good.
            (counter.fetch_add(1, Ordering::SeqCst) + 1 > 3).then_some(Fail::Destroy)
        })),
        None,
        true,
    )
    .await
    else {
        return;
    };
    let Some(source) = env.source("Không có tiếng.mkv", "640x360", 6, false).await else {
        return;
    };
    let error = env.run(&source, "Không có tiếng.mkv").await.unwrap_err();
    let tmp_dir = env.tmp_root.join(PUBLIC_ID);
    let before_upload = env.hooks.before_upload_infos.lock().unwrap()[0].clone();

    assert_eq!(error.kind, PipelineErrorKind::UploadInterrupted);
    assert!(error.resumable);
    assert_eq!(error.tmp_dir.as_deref(), Some(tmp_dir.as_path()));
    assert_eq!(
        error.register_payload.as_ref(),
        Some(&before_upload.register_payload)
    );
    assert_eq!(env.runner.transcodes.load(Ordering::SeqCst), 1);
    assert_eq!(env.server.objects().len(), 3);
    assert!(!env.deleted());
    assert!(tmp_dir.join("playlist.m3u8").is_file());
    assert_eq!(env.register.count(), 0);

    // The network is back.
    outage.store(false, Ordering::SeqCst);

    let runs_before = env.runner.all.load(Ordering::SeqCst);
    let uploaded: Vec<String> = env.server.objects().keys().cloned().collect();
    let puts_before = env.server.puts().len();
    let payload = error.register_payload.unwrap();
    let hooks = Arc::new(RecordingHooks::default());
    let result = resume_upload(
        &ResumeUploadInput {
            job_id: "job".into(),
            public_id: PUBLIC_ID.into(),
            payload: payload.clone(),
            tmp_dir: tmp_dir.clone(),
        },
        &env.config,
        &env.deps,
        hooks.clone(),
        &env.cancel,
    )
    .await
    .unwrap();
    // Only PUTs the server accepted count as uploads. A connection the outage killed can be
    // recorded late by the server (after the snapshot above) as a truncated, unsigned request
    // that stores nothing.
    let resumed: Vec<String> = env.server.puts()[puts_before..]
        .iter()
        .filter(|p| p.signature_ok == Some(true))
        .map(|p| p.key.clone())
        .collect();

    assert_eq!(env.runner.all.load(Ordering::SeqCst), runs_before);
    assert!(resumed.iter().all(|k| !uploaded.contains(k)));
    assert_eq!(resumed.last(), Some(&payload.playlist_path));

    let mut all: Vec<String> = uploaded.iter().chain(&resumed).cloned().collect();

    all.sort();

    assert_eq!(
        all,
        env.server.objects().keys().cloned().collect::<Vec<_>>()
    );
    assert!(env
        .server
        .objects()
        .contains_key(payload.thumbnail_path.as_ref().unwrap()));
    assert_eq!(hooks.stages(), [JobState::Uploading, JobState::Registering]);
    assert_eq!(result.registered.public_id, PUBLIC_ID);
    assert_eq!(*env.register.payloads.lock().unwrap(), [payload]);
    assert!(!tmp_dir.exists());
}

// ---- the demuxer allow-list (-format_whitelist) must not break any accepted container --------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn probes_and_transcodes_every_allowed_container_with_the_whitelist_active() {
    let Some((ffmpeg_path, ffprobe_path)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();

    for extension in ["mp4", "mov", "mkv", "avi", "webm"] {
        let file = dir.path().join(format!("sample.{extension}"));
        let target = file.to_string_lossy().into_owned();
        let codecs: &[&str] = if extension == "webm" {
            &["-c:v", "libvpx", "-c:a", "libopus"]
        } else {
            &["-c:v", "libx264", "-c:a", "aac"]
        };
        let mut args = vec![
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=15:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-pix_fmt",
            "yuv420p",
        ];

        args.extend(codecs);
        args.extend(["-shortest", &target]);

        let mut made = ffmpeg(&ffmpeg_path, dir.path(), &args, false).await;

        if made.exit_code != Some(0) && extension == "webm" {
            // A video-only VP8 file when the Opus encoder is not built in.
            made = ffmpeg(
                &ffmpeg_path,
                dir.path(),
                &[
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=160x90:rate=15:duration=2",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:v",
                    "libvpx",
                    &target,
                ],
                false,
            )
            .await;
        }

        if made.exit_code != Some(0) {
            eprintln!("[integration] SKIPPED .{extension}: this ffmpeg cannot encode it");
            continue;
        }

        let cwd = dir.path().join(format!("out-{extension}"));

        std::fs::create_dir_all(&cwd).unwrap();

        let env = StepEnv {
            run: Arc::new(ProcessRunner::new()),
            fs: Arc::new(RealFs),
            ffmpeg: ffmpeg_path.clone(),
            ffprobe: ffprobe_path.clone(),
            cwd: cwd.clone(),
            cancel: CancellationToken::new(),
            logger: Arc::new(RecordingLogger::default()),
            step: JobState::Transcoding,
        };
        let duration = probe_duration(&env, &target).await.unwrap().unwrap();
        let fps = probe_fps(&env, &target).await.unwrap();

        assert!(duration > 0.5, "{extension}");
        assert!(fps > 0.0, "{extension}");

        transcode_to_hls(
            &env,
            TranscodeInput {
                input: target.clone(),
                transcode: AppConfigTranscode {
                    resolution: Resolution::P480,
                    segment_seconds: 2.0,
                    fps: None,
                },
                duration: Some(duration),
                output_fps: fps,
                threads: None,
                on_fraction: Arc::new(|_| ()),
            },
        )
        .await
        .unwrap();

        assert!(cwd.join("playlist.m3u8").is_file(), "{extension}");
        assert!(cwd.join("segment_000.ts").is_file(), "{extension}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fails_to_probe_an_hls_playlist_disguised_as_evil_mp4_and_the_whitelist_is_why() {
    let Some((ffmpeg_path, ffprobe_path)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let evil = dir.path().join("evil.mp4");

    std::fs::write(
        &evil,
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n",
    )
    .unwrap();

    let env = StepEnv {
        run: Arc::new(ProcessRunner::new()),
        fs: Arc::new(RealFs),
        ffmpeg: ffmpeg_path.clone(),
        ffprobe: ffprobe_path.clone(),
        cwd: dir.path().to_path_buf(),
        cancel: CancellationToken::new(),
        logger: Arc::new(RecordingLogger::default()),
        step: JobState::Transcoding,
    };

    assert!(probe_duration(&env, &evil.to_string_lossy()).await.is_err());
    drop(env);

    // A real HLS output is rejected with the allow-list and accepted without it.
    let sample = dir.path().join("sample.mp4");
    let made = ffmpeg(
        &ffmpeg_path,
        dir.path(),
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=15:duration=2",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            &sample.to_string_lossy(),
        ],
        false,
    )
    .await;

    if made.exit_code != Some(0) {
        eprintln!("[integration] SKIPPED: this ffmpeg cannot encode libx264");
        return;
    }

    let hls = dir.path().join("real-hls");

    std::fs::create_dir_all(&hls).unwrap();

    let playlist = hls.join("p.m3u8").to_string_lossy().into_owned();
    let made = ffmpeg(
        &ffmpeg_path,
        dir.path(),
        &[
            "-y",
            "-i",
            &sample.to_string_lossy(),
            "-c",
            "copy",
            "-f",
            "hls",
            &playlist,
        ],
        false,
    )
    .await;

    assert_eq!(made.exit_code, Some(0));

    let with_list = ffmpeg(
        &ffprobe_path,
        dir.path(),
        &[
            "-v",
            "error",
            "-format_whitelist",
            SOURCE_FORMAT_WHITELIST,
            &playlist,
        ],
        true,
    )
    .await;
    let without = ffmpeg(&ffprobe_path, dir.path(), &["-v", "error", &playlist], true).await;

    assert_ne!(with_list.exit_code, Some(0));
    assert_eq!(without.exit_code, Some(0));
}
