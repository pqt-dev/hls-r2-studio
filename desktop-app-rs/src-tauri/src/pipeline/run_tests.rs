//! Port of runPipeline.test.ts: the orchestrator over the fake ffmpeg runner (real files in a
//! temp dir), the fake object store and the fake register client.

use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;
use crate::logger::testing::RecordingLogger;
use crate::pipeline::testing::fakes::{
    exit_code, fake_tuning, http_error, http_failure, make_test_deps, net_error, network_failure,
    registered, CallKind, FakeCall, FakePipelineRunner, FakeRegister, FakeRunnerOptions, FakeS3,
    FakeS3Options, FakeSleeper, RecordingHooks, RegisterBehavior, TestDepsInput, PLENTY_OF_SPACE,
    PUBLIC_ID,
};

const PREFIX: &str = "2026/03/05/video-mau-tieng-viet-1-ab12cd34ef56/";
const FILENAME: &str = "Video Mẫu Tiếng Việt (1).mp4";

#[derive(Default)]
struct Options {
    runner: FakeRunnerOptions,
    s3: FakeS3Options,
    register: Option<RegisterBehavior>,
    free_bytes: Option<u64>,
    fps: Option<f64>,
    sleeper: Option<FakeSleeper>,
    hooks: Option<RecordingHooks>,
    fake_clock: bool,
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    tmp_root: PathBuf,
    source: PathBuf,
    runner: Arc<FakePipelineRunner>,
    s3: FakeS3,
    register: Arc<FakeRegister>,
    sleeper: Arc<FakeSleeper>,
    hooks: Arc<RecordingHooks>,
    cancel: CancellationToken,
    deps: PipelineDeps,
    config: AppConfig,
}

fn harness(options: Options) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let tmp_root = root.join("tmp");

    std::fs::create_dir_all(&tmp_root).unwrap();

    let source = root.join(FILENAME);

    std::fs::write(&source, vec![0u8; 2048]).unwrap();

    let runner = FakePipelineRunner::new(options.runner);
    let s3 = FakeS3::new(options.s3);
    let register = match options.register {
        Some(behavior) => FakeRegister::with(behavior),
        None => FakeRegister::ok(),
    };
    let (sleeper, tuning) = if options.fake_clock {
        let (sleeper, clock) = FakeSleeper::with_clock();

        (sleeper, fake_tuning(&clock))
    } else {
        (
            Arc::new(options.sleeper.unwrap_or_default()),
            UploadTuning::default(),
        )
    };
    let deps = make_test_deps(TestDepsInput {
        runner: runner.clone(),
        s3: Arc::new(s3.clone()),
        register: register.clone(),
        tmp_root: tmp_root.clone(),
        sleeper: sleeper.clone(),
        free_bytes: options.free_bytes.unwrap_or(PLENTY_OF_SPACE),
        logger: Arc::new(RecordingLogger::default()),
        tuning,
    });
    let mut config = crate::pipeline::testing::fakes::test_config();

    config.transcode.fps = options.fps;

    Harness {
        _dir: dir,
        root,
        tmp_root,
        source,
        runner,
        s3,
        register,
        sleeper,
        hooks: Arc::new(options.hooks.unwrap_or_default()),
        cancel: CancellationToken::new(),
        deps,
        config,
    }
}

impl Harness {
    async fn run(&self) -> Result<PipelineResult, PipelineError> {
        self.run_with(FILENAME, &self.source.to_string_lossy())
            .await
    }

    async fn run_with(
        &self,
        filename: &str,
        source: &str,
    ) -> Result<PipelineResult, PipelineError> {
        let job = PipelineJob {
            id: "job-1".into(),
            source_path: source.to_string(),
            filename: filename.to_string(),
            public_id: PUBLIC_ID.into(),
        };

        run_pipeline(
            &job,
            &self.config,
            &self.deps,
            self.hooks.clone(),
            &self.cancel,
        )
        .await
    }

    async fn retry_register(
        &self,
        payload: &RegisterPayload,
    ) -> Result<PipelineResult, PipelineError> {
        retry_register(payload, &self.deps, self.hooks.clone(), &self.cancel).await
    }

    fn job_dir_exists(&self) -> bool {
        self.tmp_root.join(PUBLIC_ID).exists()
    }

    fn kinds(&self) -> Vec<CallKind> {
        self.runner.kinds()
    }
}

/// Polls until the condition holds (real time, 20 s at most).
async fn wait_for(condition: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);

    while !condition() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn behavior(
    f: impl Fn(&RegisterPayload, usize) -> Result<RegisteredVideo, RegisterRequestError>
        + Send
        + Sync
        + 'static,
) -> Option<RegisterBehavior> {
    Some(Box::new(f))
}

fn override_call(
    f: impl Fn(&FakeCall) -> Option<RunResult> + Send + Sync + 'static,
) -> FakeRunnerOptions {
    FakeRunnerOptions {
        override_call: Some(Box::new(f)),
        ..FakeRunnerOptions::default()
    }
}

use crate::ffmpeg::runner::RunResult;
use crate::pipeline::deps::StoreError;

async fn build_payload() -> RegisterPayload {
    let h = harness(Options {
        register: behavior(|_, _| Err(network_failure())),
        ..Options::default()
    });

    h.run().await.unwrap_err().register_payload.unwrap()
}

// ---- happy path ---------------------------------------------------------------------------

#[tokio::test]
async fn runs_every_step_in_order_and_registers_the_payload() {
    let h = harness(Options::default());
    let result = h.run().await.unwrap();
    let order = h.kinds();
    let first = |kind: CallKind| order.iter().position(|k| *k == kind).unwrap();
    let last = |kind: CallKind| order.iter().rposition(|k| *k == kind).unwrap();

    assert_eq!(result.prefix, PREFIX);
    assert_eq!(result.registered.public_id, PUBLIC_ID);
    assert_eq!(
        h.hooks.stages(),
        [
            JobState::Transcoding,
            JobState::Thumbnail,
            JobState::Storyboard,
            JobState::Uploading,
            JobState::Registering
        ]
    );
    assert_eq!(first(CallKind::ProbeDuration), 0);
    assert_eq!(first(CallKind::ProbeFps), 1);
    assert_eq!(first(CallKind::Transcode), 2);
    assert_eq!(first(CallKind::ProbeOutput), 3);
    assert_eq!(last(CallKind::ProbeOutput), 3);
    assert!(first(CallKind::ThumbFrame) > first(CallKind::ProbeOutput));
    assert!(first(CallKind::SbCandidates) > last(CallKind::Crop));
    assert_eq!(last(CallKind::SbTile), order.len() - 1);
    assert_eq!(h.runner.count(CallKind::SbTile), 3);
    assert!(h.hooks.events().contains(&format!("prefix:{PREFIX}")));
}

#[tokio::test]
async fn uploads_under_the_prefix_with_the_playlist_last_and_registers_a_consistent_payload() {
    let h = harness(Options::default());

    h.run().await.unwrap();

    let keys = h.s3.put_keys();

    assert_eq!(keys.len(), 2 + 1 + 3 + 1);
    assert!(keys.iter().all(|k| k.starts_with(PREFIX)));
    assert_eq!(keys.last().unwrap(), &format!("{PREFIX}playlist.m3u8"));
    assert!(keys.contains(&format!("{PREFIX}thumbnail.jpg")));
    assert!(keys.contains(&format!("{PREFIX}storyboard_5x5.jpg")));
    assert!(h
        .s3
        .requests()
        .iter()
        .any(|r| r.content_type.as_deref() == Some("application/vnd.apple.mpegurl")));

    let payloads = h.register.payloads.lock().unwrap().clone();

    assert_eq!(payloads.len(), 1);

    let p = &payloads[0];

    assert_eq!(p.public_id, PUBLIC_ID);
    assert_eq!(p.title, "Video Mẫu Tiếng Việt (1)");
    assert_eq!(p.original_filename, FILENAME);
    assert_eq!(p.original_size_bytes, 2048);
    assert_eq!(p.disk_prefix, PREFIX);
    assert_eq!(p.playlist_path, format!("{PREFIX}playlist.m3u8"));
    assert_eq!(p.thumbnail_path, Some(format!("{PREFIX}thumbnail.jpg")));
    assert_eq!(p.duration, Some(12.0));
    assert_eq!(p.output_width, Some(1280));
    assert_eq!(p.output_height, Some(720));
    assert_eq!(p.output_fps, Some(30.0));
    assert_eq!(p.output_bitrate_kbps, Some(1500));
    assert_eq!(p.output_codec.as_deref(), Some("h264"));
    assert_eq!(
        p.storyboards.as_ref().unwrap().keys().collect::<Vec<_>>(),
        ["3x3", "4x4", "5x5"]
    );
}

#[tokio::test]
async fn reports_a_monotonic_progress_that_ends_at_100_and_removes_the_temp_dir() {
    let h = harness(Options::default());

    h.run().await.unwrap();

    let percents = h.hooks.percents();
    let mut sorted = percents.clone();

    sorted.sort_unstable();
    sorted.dedup();

    assert!(percents.len() > 3);
    assert_eq!(sorted, percents);
    assert_eq!(percents.last(), Some(&100));
    assert!(!h.job_dir_exists());
    assert!(h.s3.deletes().is_empty());
}

#[tokio::test]
async fn skips_the_source_fps_probe_when_the_config_forces_an_fps() {
    let h = harness(Options {
        fps: Some(24.0),
        ..Options::default()
    });

    h.run().await.unwrap();

    assert!(!h.kinds().contains(&CallKind::ProbeFps));

    let calls = h.runner.calls.lock().unwrap();
    let transcode = calls
        .iter()
        .find(|c| c.kind == CallKind::Transcode)
        .unwrap();

    assert!(transcode.args.contains(&"-r".to_string()));
}

#[tokio::test]
async fn uses_the_single_frame_path_for_videos_shorter_than_3_seconds() {
    let h = harness(Options {
        runner: FakeRunnerOptions {
            duration: "1.2".into(),
            ..FakeRunnerOptions::default()
        },
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.runner.count(CallKind::ThumbFrame), 1);
    assert_eq!(
        h.register.payloads.lock().unwrap()[0].thumbnail_path,
        Some(format!("{PREFIX}thumbnail.jpg"))
    );
}

#[tokio::test]
async fn builds_a_triple_column_thumbnail_for_portrait_output() {
    let h = harness(Options {
        runner: FakeRunnerOptions {
            output_width: 720,
            output_height: 1280,
            ..FakeRunnerOptions::default()
        },
        ..Options::default()
    });

    h.run().await.unwrap();

    assert!(h.kinds().contains(&CallKind::Hstack));
    assert_eq!(h.runner.count(CallKind::CropScale), 3);
}

#[tokio::test]
async fn skips_storyboards_when_the_duration_is_unknown() {
    let h = harness(Options {
        runner: FakeRunnerOptions {
            duration: "N/A".into(),
            ..FakeRunnerOptions::default()
        },
        ..Options::default()
    });

    h.run().await.unwrap();

    let payload = h.register.payloads.lock().unwrap()[0].clone();

    assert!(!h.kinds().contains(&CallKind::SbCandidates));
    assert_eq!(payload.storyboards, None);
    assert_eq!(payload.duration, None);
}

// ---- step 0 checks ------------------------------------------------------------------------

#[tokio::test]
async fn rejects_an_unsupported_extension_before_touching_anything() {
    let h = harness(Options::default());
    let bad = h.root.join("notes.txt");

    std::fs::write(&bad, "x").unwrap();

    let error = h
        .run_with("notes.txt", &bad.to_string_lossy())
        .await
        .unwrap_err();

    assert_eq!(
        (error.kind, error.step),
        (PipelineErrorKind::Failed, JobState::Waiting)
    );
    assert_eq!(
        error.message,
        "Unsupported file type. Supported: mp4, mov, mkv, avi, webm."
    );
    assert!(h.runner.calls.lock().unwrap().is_empty());
    assert!(!h.job_dir_exists());
}

#[tokio::test]
async fn accepts_every_allowed_extension_case_insensitively() {
    for ext in ["mp4", "MOV", "mkv", "avi", "webm"] {
        let h = harness(Options::default());
        let file = h.root.join(format!("clip.{ext}"));

        std::fs::write(&file, [0u8; 10]).unwrap();

        assert!(
            h.run_with(&format!("clip.{ext}"), &file.to_string_lossy())
                .await
                .is_ok(),
            "{ext}"
        );
    }
}

#[tokio::test]
async fn fails_when_the_source_file_does_not_exist_without_leaking_its_path() {
    let h = harness(Options::default());
    let missing = h.root.join("missing.mp4");
    let error = h
        .run_with("missing.mp4", &missing.to_string_lossy())
        .await
        .unwrap_err();

    assert_eq!(error.message, "The source file was not found.");
    assert!(!error.message.contains(&*h.root.to_string_lossy()));

    // A directory named like a video is not a source file either.
    let folder = h.root.join("folder.mp4");

    std::fs::create_dir(&folder).unwrap();

    assert_eq!(
        h.run_with("folder.mp4", &folder.to_string_lossy())
            .await
            .unwrap_err()
            .message,
        "The source file was not found."
    );
}

#[tokio::test]
async fn an_empty_source_and_an_invalid_public_id_fail_early() {
    let h = harness(Options::default());
    let empty = h.root.join("empty.mp4");

    std::fs::write(&empty, b"").unwrap();

    assert_eq!(
        h.run_with("empty.mp4", &empty.to_string_lossy())
            .await
            .unwrap_err()
            .message,
        "The source file is empty."
    );

    let job = PipelineJob {
        id: "j".into(),
        source_path: h.source.to_string_lossy().into_owned(),
        filename: FILENAME.into(),
        public_id: "../../etc".into(),
    };
    let error = run_pipeline(&job, &h.config, &h.deps, h.hooks.clone(), &h.cancel)
        .await
        .unwrap_err();

    assert_eq!(error.message, "The job has an invalid video ID.");
    assert!(h.runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn fails_early_when_there_is_not_enough_free_disk_space() {
    let h = harness(Options {
        free_bytes: Some(1024 * 1024 * 1024),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(
        (error.kind, error.step),
        (PipelineErrorKind::Failed, JobState::Waiting)
    );
    assert_eq!(
        error.message,
        "Not enough free disk space for temporary files (about 1.0 GB needed)."
    );
    assert!(h.runner.calls.lock().unwrap().is_empty());
    assert!(h.s3.requests().is_empty());
}

#[tokio::test]
async fn needs_size_times_1_5_plus_1_gib_of_free_space() {
    let needed = (2048.0f64 * 1.5 + 1024.0 * 1024.0 * 1024.0).ceil() as u64;

    assert!(harness(Options {
        free_bytes: Some(needed - 1),
        ..Options::default()
    })
    .run()
    .await
    .is_err());
    assert!(harness(Options {
        free_bytes: Some(needed),
        ..Options::default()
    })
    .run()
    .await
    .is_ok());
}

// ---- failures -----------------------------------------------------------------------------

#[tokio::test]
async fn fails_the_job_when_the_transcode_exits_non_zero_and_scrubs_paths_from_stderr() {
    let dir_holder = tempfile::tempdir().unwrap();
    let source = dir_holder.path().join(FILENAME);

    std::fs::write(&source, [0u8; 2048]).unwrap();

    let source_text = source.to_string_lossy().into_owned();
    let line = format!("{source_text}: Invalid data found");
    let h = harness(Options {
        runner: override_call(move |call| {
            (call.kind == CallKind::Transcode)
                .then(|| exit_code(1, &[line.as_str(), "second line"]))
        }),
        ..Options::default()
    });
    let error = h.run_with(FILENAME, &source_text).await.unwrap_err();

    assert_eq!(
        (error.kind, error.step, error.exit_code),
        (PipelineErrorKind::Failed, JobState::Transcoding, Some(1))
    );
    assert_eq!(
        error.stderr_tail,
        ["<source>: Invalid data found", "second line"]
    );
    assert!(!error.message.contains(&*h.root.to_string_lossy()));
    assert!(h.s3.requests().is_empty());
    assert!(!h.job_dir_exists());
    assert_eq!(error.prefix.as_deref(), Some(PREFIX));
}

#[tokio::test]
async fn fails_when_ffprobe_cannot_read_the_source() {
    let h = harness(Options {
        runner: override_call(|c| (c.kind == CallKind::ProbeDuration).then(|| exit_code(1, &[]))),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(
        (error.kind, error.step),
        (PipelineErrorKind::Failed, JobState::Transcoding)
    );
}

#[tokio::test]
async fn treats_a_thumbnail_failure_as_no_thumbnail() {
    let h = harness(Options {
        runner: override_call(|c| (c.kind == CallKind::ThumbFrame).then(|| exit_code(1, &[]))),
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.register.payloads.lock().unwrap()[0].thumbnail_path, None);
    assert!(!h.s3.put_keys().contains(&format!("{PREFIX}thumbnail.jpg")));
}

#[tokio::test]
async fn treats_a_storyboard_failure_as_no_storyboards() {
    let h = harness(Options {
        runner: override_call(|c| (c.kind == CallKind::SbCandidates).then(|| exit_code(1, &[]))),
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.register.payloads.lock().unwrap()[0].storyboards, None);
    assert!(!h.s3.put_keys().iter().any(|k| k.contains("storyboard_")));
}

#[tokio::test]
async fn keeps_the_other_grids_when_one_storyboard_grid_fails() {
    let h = harness(Options {
        runner: override_call(|c| {
            (c.kind == CallKind::SbTile && c.args.iter().any(|a| a == "tile=4x4"))
                .then(|| exit_code(1, &[]))
        }),
        ..Options::default()
    });

    h.run().await.unwrap();

    let payload = h.register.payloads.lock().unwrap()[0].clone();

    assert_eq!(
        payload.storyboards.unwrap().keys().collect::<Vec<_>>(),
        ["3x3", "5x5"]
    );
}

#[tokio::test]
async fn deletes_the_r2_prefix_when_the_upload_fails_after_it_started() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, _| {
                key.ends_with("segment_001.ts")
                    .then(|| StoreError::Local("HTTP 500".into()))
            })),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(
        (error.kind, error.step),
        (PipelineErrorKind::Failed, JobState::Uploading)
    );
    assert_eq!(
        h.s3.put_keys()
            .iter()
            .filter(|k| k.ends_with("segment_001.ts"))
            .count(),
        3
    );
    assert_eq!(h.sleeper.sleeps(), [1000, 2000]);
    assert!(!h.s3.put_keys().contains(&format!("{PREFIX}playlist.m3u8")));
    assert!(h
        .s3
        .deletes()
        .concat()
        .iter()
        .all(|k| k.starts_with(PREFIX)));
    assert!(!h.s3.deletes().is_empty());
    assert!(h.s3.objects().is_empty());
    assert!(!h.job_dir_exists());
    assert_eq!(h.register.count(), 0);
}

#[tokio::test]
async fn retries_a_transient_upload_failure_and_finishes() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, attempt| {
                (key.ends_with("segment_000.ts") && attempt < 3)
                    .then(|| StoreError::Local("reset".into()))
            })),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.sleeper.sleeps(), [1000, 2000]);
}

// ---- cancellation -------------------------------------------------------------------------

#[tokio::test]
async fn aborting_during_a_processing_step_cancels_without_touching_r2() {
    for kind in [
        CallKind::ProbeDuration,
        CallKind::Transcode,
        CallKind::ThumbFrame,
        CallKind::SbCandidates,
    ] {
        let h = harness(Options {
            runner: FakeRunnerOptions {
                block_on: Some(Box::new(move |c| c.kind == kind)),
                ..FakeRunnerOptions::default()
            },
            ..Options::default()
        });
        let (result, ()) = tokio::join!(h.run(), async {
            wait_for(|| h.runner.kinds().contains(&kind)).await;
            h.cancel.cancel();
        });
        let error = result.unwrap_err();

        assert_eq!(error.kind, PipelineErrorKind::Cancelled, "{kind:?}");
        assert!(h.s3.requests().is_empty());
        assert_eq!(h.register.count(), 0);
        assert!(!h.job_dir_exists());
    }
}

#[tokio::test]
async fn aborting_before_the_pipeline_starts_cancels_immediately() {
    let h = harness(Options::default());

    h.cancel.cancel();

    assert_eq!(
        h.run().await.unwrap_err().kind,
        PipelineErrorKind::Cancelled
    );
    assert!(h.runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn aborting_during_the_upload_deletes_the_prefix_and_keeps_nothing() {
    let h = harness(Options {
        s3: FakeS3Options {
            block_put: Some(Box::new(|key| key.ends_with("segment_001.ts"))),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });
    let (result, ()) = tokio::join!(h.run(), async {
        wait_for(|| {
            h.s3.put_keys()
                .iter()
                .any(|k| k.ends_with("segment_001.ts"))
        })
        .await;
        h.cancel.cancel();
    });
    let error = result.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Cancelled);
    assert_eq!(error.prefix.as_deref(), Some(PREFIX));
    assert!(h.s3.objects().is_empty());
    assert!(!h.s3.deletes().is_empty());
    assert!(!h.s3.put_keys().contains(&format!("{PREFIX}playlist.m3u8")));
    assert!(!h.job_dir_exists());
}

// ---- register -----------------------------------------------------------------------------

#[tokio::test]
async fn retries_register_with_the_backoff_and_succeeds_on_a_later_attempt() {
    let h = harness(Options {
        register: behavior(|payload, attempt| {
            if attempt < 4 {
                Err(network_failure())
            } else {
                Ok(RegisteredVideo {
                    id: 7,
                    public_id: payload.public_id.clone(),
                    embed_url: "https://x/embed/y".into(),
                })
            }
        }),
        ..Options::default()
    });
    let result = h.run().await.unwrap();

    assert_eq!(result.registered.id, 7);
    assert_eq!(h.register.count(), 4);
    assert_eq!(h.sleeper.sleeps(), [1000, 2000, 4000]);
}

#[tokio::test]
async fn after_6_network_failures_keeps_r2_and_returns_register_failed_with_the_payload() {
    let h = harness(Options {
        register: behavior(|_, _| Err(network_failure())),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert_eq!(error.step, JobState::Registering);
    assert_eq!(h.register.count(), 6);
    assert_eq!(h.sleeper.sleeps(), REGISTER_RETRY_DELAYS_MS);
    assert_eq!(error.register_payload.unwrap().disk_prefix, PREFIX);
    assert_eq!(
        error.message,
        "Could not reach the site. Check your internet connection. The video is uploaded; use Retry to finish registering."
    );
    assert!(h.s3.deletes().is_empty());
    assert_eq!(h.s3.objects().len(), 7);
    assert!(!h.job_dir_exists());
}

#[tokio::test]
async fn retry_register_finishes_the_registration_without_any_new_upload() {
    let payload = build_payload().await;
    let second = harness(Options::default());
    let result = second.retry_register(&payload).await.unwrap();

    assert_eq!(result.registered.public_id, PUBLIC_ID);
    assert!(second.s3.requests().is_empty());
    assert!(second.runner.calls.lock().unwrap().is_empty());
    assert_eq!(second.hooks.stages(), [JobState::Registering]);
    assert_eq!(second.hooks.percents().last(), Some(&100));
}

#[tokio::test]
async fn retry_register_can_fail_again_with_needs_sign_in_and_keeps_the_payload() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(401, None))),
        ..Options::default()
    });
    let error = h.retry_register(&build_payload().await).await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::NeedsSignIn);
    assert!(error.register_payload.is_some());
}

#[tokio::test]
async fn retry_register_refuses_an_invalid_stored_payload() {
    let h = harness(Options::default());
    let mut payload = build_payload().await;

    payload.title = String::new();

    let error = h.retry_register(&payload).await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert_eq!(
        error.message,
        "The stored video data is invalid, so it cannot be registered."
    );
    assert_eq!(h.register.count(), 0);
}

#[tokio::test]
async fn http_401_surfaces_needs_sign_in_without_retries_and_without_touching_r2() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(401, None))),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::NeedsSignIn);
    assert_eq!(error.register_payload.unwrap().public_id, PUBLIC_ID);
    assert_eq!(
        error.message,
        "Your session has expired. Sign in again to finish registering the video."
    );
    assert_eq!(h.register.count(), 1);
    assert!(h.sleeper.sleeps().is_empty());
    assert!(h.s3.deletes().is_empty());
    assert_eq!(h.s3.objects().len(), 7);
}

#[tokio::test]
async fn honors_retry_after_on_http_429_and_otherwise_uses_the_normal_backoff() {
    let h = harness(Options {
        register: behavior(|payload, attempt| match attempt {
            1 => Err(RegisterRequestError::new(RegisterFailure::Http {
                status: 429,
                error_code: None,
                retry_after_seconds: Some(3.0),
            })),
            2 => Err(http_failure(429, None)),
            _ => Ok(registered(payload)),
        }),
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.sleeper.sleeps(), [3000, 2000]);
}

#[tokio::test]
async fn other_4xx_keep_r2_and_yield_register_failed_without_backoff() {
    for status in [400, 403, 404, 405] {
        let h = harness(Options {
            register: behavior(move |_, _| Err(http_failure(status, None))),
            ..Options::default()
        });
        let error = h.run().await.unwrap_err();

        assert_eq!(error.kind, PipelineErrorKind::RegisterFailed, "{status}");
        assert_eq!(error.register_payload.unwrap().disk_prefix, PREFIX);
        assert_eq!(h.register.count(), 1);
        assert!(h.sleeper.sleeps().is_empty());
        assert!(h.s3.deletes().is_empty());
        assert_eq!(h.s3.objects().len(), 7);
    }
}

#[tokio::test]
async fn retry_register_after_http_403_keeps_the_payload() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(403, None))),
        ..Options::default()
    });
    let error = h.retry_register(&build_payload().await).await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert!(error.register_payload.is_some());
}

#[tokio::test]
async fn fails_the_job_and_deletes_the_r2_prefix_on_a_definitive_409() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(409, Some("public_id_conflict")))),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(error.definitive);
    assert!(error.register_payload.is_none());
    assert!(h.s3.objects().is_empty());
}

#[tokio::test]
async fn fails_the_job_and_deletes_the_r2_prefix_on_a_definitive_422() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(422, Some("playlist_not_found")))),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(error.message.contains("playlist was not found"));
    assert_eq!(h.register.count(), 1);
    assert!(h.s3.objects().is_empty());
}

#[tokio::test]
async fn a_cancel_between_register_retries_keeps_r2_and_yields_register_failed() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut h = harness(Options {
        register: behavior(|_, _| Err(network_failure())),
        sleeper: Some(FakeSleeper {
            on_sleep: Some(Box::new(move |_, _| trigger.cancel())),
            ..FakeSleeper::default()
        }),
        ..Options::default()
    });

    h.cancel = cancel;

    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert_eq!(
        error.message,
        "Registering was interrupted. The video is uploaded; use Retry to finish."
    );
    // The abort happened during the backoff sleep: no further request may be sent.
    assert_eq!(h.register.count(), 1);
    assert!(h.s3.deletes().is_empty());
}

#[tokio::test]
async fn a_cancel_during_the_3rd_backoff_sleep_stops_after_exactly_3_requests() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut h = harness(Options {
        register: behavior(|_, _| Err(network_failure())),
        sleeper: Some(FakeSleeper {
            on_sleep: Some(Box::new(move |_, count| {
                if count == 3 {
                    trigger.cancel();
                }
            })),
            ..FakeSleeper::default()
        }),
        ..Options::default()
    });

    h.cancel = cancel;

    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert_eq!(h.register.count(), 3);
}

#[tokio::test]
async fn a_generic_409_or_422_keeps_r2_and_the_payload() {
    for (status, code) in [
        (409, None),
        (409, Some("something_else")),
        (422, None),
        (422, Some("validation_failed")),
    ] {
        let h = harness(Options {
            register: behavior(move |_, _| Err(http_failure(status, code))),
            ..Options::default()
        });
        let error = h.run().await.unwrap_err();

        assert_eq!(
            error.kind,
            PipelineErrorKind::RegisterFailed,
            "{status} {code:?}"
        );
        assert_eq!(error.register_payload.unwrap().disk_prefix, PREFIX);
        assert!(h.s3.deletes().is_empty());
        assert_eq!(h.s3.objects().len(), 7);
    }
}

#[tokio::test]
async fn retry_register_with_a_generic_422_keeps_the_payload() {
    let h = harness(Options {
        register: behavior(|_, _| Err(http_failure(422, None))),
        ..Options::default()
    });
    let error = h.retry_register(&build_payload().await).await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert!(error.register_payload.is_some());
}

// ---- durable registering transition -------------------------------------------------------

#[tokio::test]
async fn awaits_on_before_register_after_the_registering_stage_and_before_the_first_request() {
    let register = FakeRegister::ok();
    let seen = register.clone();
    let mut h = harness(Options {
        hooks: Some(RecordingHooks {
            before_register: Some(Box::new(move || {
                assert_eq!(seen.count(), 0);

                Ok(())
            })),
            ..RecordingHooks::default()
        }),
        ..Options::default()
    });

    h.deps.register = register.clone();
    h.run().await.unwrap();

    let events = h.hooks.events();

    assert_eq!(
        events[events.len() - 2..],
        ["stage:registering", "before-register"]
    );
    assert_eq!(register.count(), 1);
}

#[tokio::test]
async fn on_before_register_also_runs_before_the_register_only_retry() {
    let payload = build_payload().await;
    let h = harness(Options::default());

    h.retry_register(&payload).await.unwrap();

    assert_eq!(h.hooks.events(), ["stage:registering", "before-register"]);
}

#[tokio::test]
async fn a_failing_on_before_register_stops_before_any_request() {
    let h = harness(Options {
        hooks: Some(RecordingHooks {
            before_register: Some(Box::new(|| Err(std::io::Error::other("flush failed")))),
            ..RecordingHooks::default()
        }),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert_eq!(error.message, "An unexpected error occurred.");
    assert_eq!(h.register.count(), 0);
}

// ---- S3 client lifecycle and key length ---------------------------------------------------

#[tokio::test]
async fn drops_every_s3_client_after_a_successful_run() {
    let h = harness(Options::default());

    h.run().await.unwrap();

    assert_eq!(h.s3.created(), 1);
    assert_eq!(h.s3.destroyed(), 1);
}

#[tokio::test]
async fn drops_the_upload_client_and_the_cleanup_client_after_a_failed_upload() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|_, _| Some(StoreError::Local("boom".into())))),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    h.run().await.unwrap_err();

    assert_eq!(h.s3.created(), 2);
    assert_eq!(h.s3.destroyed(), 2);
    assert_eq!(
        *h.s3.0.purposes.lock().unwrap(),
        [ClientPurpose::Upload, ClientPurpose::Cleanup]
    );
}

#[tokio::test]
async fn caps_a_240_character_file_name_so_every_registered_path_fits_255_characters() {
    let h = harness(Options::default());
    let filename = format!("{}.mp4", "a".repeat(236));
    let result = h
        .run_with(&filename, &h.source.to_string_lossy())
        .await
        .unwrap();
    let payload = result.payload;
    let mut paths = vec![
        payload.disk_prefix.clone(),
        payload.playlist_path.clone(),
        payload.thumbnail_path.clone().unwrap(),
    ];

    paths.extend(
        payload
            .storyboards
            .unwrap()
            .values()
            .map(|e| e.path.clone()),
    );

    assert!(paths.len() > 3);
    assert!(paths.iter().all(|p| p.len() <= 255));
    assert_eq!(
        payload.disk_prefix,
        format!("2026/03/05/{}-{PUBLIC_ID}/", "a".repeat(100))
    );
}

// ---- network drops during the upload ------------------------------------------------------

#[tokio::test]
async fn survives_a_long_outage_without_failing_re_transcoding_or_deleting_anything() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, attempt| {
                (key.ends_with("segment_000.ts") && attempt <= 6).then(net_error)
            })),
            ..FakeS3Options::default()
        },
        fake_clock: true,
        ..Options::default()
    });

    h.run().await.unwrap();

    assert_eq!(h.sleeper.sleeps(), [2000, 5000, 10000, 20000, 30000, 60000]);
    assert!(!h.hooks.waits.lock().unwrap().is_empty());
    assert!(h.hooks.restored.load(Ordering::SeqCst) >= 1);
    assert!(h.s3.deletes().is_empty());
    assert_eq!(h.runner.count(CallKind::Transcode), 1);
}

#[tokio::test]
async fn calls_on_before_upload_once_before_the_first_put_with_the_final_payload() {
    let s3 = FakeS3::new(FakeS3Options::default());
    let seen = s3.clone();
    let mut h = harness(Options {
        hooks: Some(RecordingHooks {
            before_upload: Some(Box::new(move |_| {
                assert!(seen.put_keys().is_empty());

                Ok(())
            })),
            ..RecordingHooks::default()
        }),
        ..Options::default()
    });

    h.deps.object_stores = Arc::new(s3.clone());
    h.s3 = s3;

    let result = h.run().await.unwrap();
    let infos = h.hooks.before_upload_infos.lock().unwrap().clone();

    assert_eq!(infos.len(), 1);
    assert_eq!(
        infos[0],
        BeforeUploadInfo {
            prefix: PREFIX.into(),
            public_id: PUBLIC_ID.into(),
            tmp_dir: h.tmp_root.join(PUBLIC_ID),
            register_payload: result.payload.clone(),
        }
    );
    assert_eq!(
        infos[0].register_payload,
        h.register.payloads.lock().unwrap()[0]
    );

    let events = h.hooks.events();
    let uploading = events.iter().position(|e| e == "stage:uploading").unwrap();
    let before = events.iter().position(|e| e == "before-upload").unwrap();

    assert!(uploading < before);
}

#[tokio::test]
async fn a_failing_on_before_upload_stops_the_job_before_anything_is_uploaded() {
    let h = harness(Options {
        hooks: Some(RecordingHooks {
            before_upload: Some(Box::new(|_| Err(std::io::Error::other("disk full")))),
            ..RecordingHooks::default()
        }),
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(h.s3.put_keys().is_empty());
    assert_eq!(h.s3.created(), 0);
    assert!(!h.job_dir_exists());
}

#[tokio::test]
async fn upload_interrupted_keeps_the_temp_dir_and_the_r2_objects_and_carries_the_resume_data() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, _| {
                key.ends_with("segment_001.ts").then(net_error)
            })),
            ..FakeS3Options::default()
        },
        fake_clock: true,
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();
    let before_upload = h.hooks.before_upload_infos.lock().unwrap()[0].clone();

    assert_eq!(error.kind, PipelineErrorKind::UploadInterrupted);
    assert_eq!(error.step, JobState::Uploading);
    assert!(error.resumable);
    assert_eq!(error.prefix.as_deref(), Some(PREFIX));
    assert_eq!(error.tmp_dir, Some(h.tmp_root.join(PUBLIC_ID)));
    assert_eq!(error.register_payload, Some(before_upload.register_payload));
    assert_eq!(
        error.message,
        "Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online."
    );

    // Nothing deleted on R2 (segment_000 stays), and the temp dir is intact.
    assert!(h.s3.deletes().is_empty());
    assert!(h.s3.has(&format!("{PREFIX}segment_000.ts")));
    assert!(h.tmp_root.join(PUBLIC_ID).join("playlist.m3u8").is_file());
    assert!(h.tmp_root.join(PUBLIC_ID).join("segment_001.ts").is_file());
    assert_eq!(h.register.count(), 0);

    // The upload client is dropped, no cleanup client was created.
    assert_eq!(h.s3.created(), 1);
    assert_eq!(h.s3.destroyed(), 1);
}

#[tokio::test]
async fn cancelling_while_waiting_for_the_network_is_a_plain_cancel() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let mut h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|_, _| Some(net_error()))),
            ..FakeS3Options::default()
        },
        sleeper: Some(FakeSleeper {
            on_sleep: Some(Box::new(move |_, _| trigger.cancel())),
            ..FakeSleeper::default()
        }),
        ..Options::default()
    });

    h.cancel = cancel;

    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Cancelled);
    assert!(!error.resumable);
    assert!(!h.job_dir_exists());
    assert!(h.s3.objects().is_empty());
}

#[tokio::test]
async fn a_non_network_failure_keeps_cleaning_up() {
    let h = harness(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, _| {
                key.ends_with("segment_000.ts")
                    .then(|| http_error(403, "AccessDenied"))
            })),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });
    let error = h.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(!error.resumable);
    assert_eq!(h.sleeper.sleeps(), [1000, 2000]);
    assert!(!h.job_dir_exists());
    assert!(!h.s3.deletes().is_empty());
}

#[tokio::test]
async fn never_touches_anything_outside_its_own_temp_dir() {
    let h = harness(Options::default());
    let sibling = h.tmp_root.join("zz12cd34ef56");

    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(sibling.join("keep.ts"), b"k").unwrap();
    std::fs::write(h.tmp_root.join("note.txt"), b"k").unwrap();

    h.run().await.unwrap();

    assert!(sibling.join("keep.ts").is_file());
    assert!(h.tmp_root.join("note.txt").is_file());
    assert!(h.source.is_file());
}
