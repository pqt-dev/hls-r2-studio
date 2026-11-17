//! Port of resumeUpload.test.ts.

use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;
use crate::ffmpeg::probe_parse::OutputInfo;
use crate::logger::testing::RecordingLogger;
use crate::pipeline::deps::StoreError;
use crate::pipeline::register::{build_register_payload, BuildRegisterPayloadInput};
use crate::pipeline::run::PipelineHooks;
use crate::pipeline::steps::upload::UploadTuning;
use crate::pipeline::testing::fakes::{
    fake_tuning, http_error, http_failure, make_test_deps, net_error, network_failure,
    FakePipelineRunner, FakeRegister, FakeRunnerOptions, FakeS3, FakeS3Options, FakeSleeper,
    RecordingHooks, RegisterBehavior, S3RequestKind, TestDepsInput, PLENTY_OF_SPACE, PUBLIC_ID,
};

const PREFIX: &str = "2026/03/05/clip-ab12cd34ef56/";
const SEGMENTS: [&str; 3] = ["segment_000.ts", "segment_001.ts", "segment_002.ts"];

fn playlist_text() -> String {
    let entries: Vec<String> = SEGMENTS
        .iter()
        .map(|s| format!("#EXTINF:6.0,\n{s}"))
        .collect();

    format!(
        "#EXTM3U\n#EXT-X-VERSION:3\n{}\n#EXT-X-ENDLIST\n",
        entries.join("\n")
    )
}

/// Every file of the video with its local size.
fn sizes() -> Vec<(&'static str, u64)> {
    vec![
        ("segment_000.ts", 100),
        ("segment_001.ts", 101),
        ("segment_002.ts", 102),
        ("thumbnail.jpg", 20),
        ("storyboard_3x3.jpg", 30),
        ("storyboard_5x5.jpg", 50),
        ("playlist.m3u8", playlist_text().len() as u64),
    ]
}

fn payload() -> RegisterPayload {
    build_register_payload(&BuildRegisterPayloadInput {
        public_id: PUBLIC_ID.into(),
        prefix: PREFIX.into(),
        original_filename: "clip.mp4".into(),
        original_size_bytes: 5000,
        duration: Some(12.0),
        has_thumbnail: true,
        storyboard_grids: vec![3, 5],
        output: Some(OutputInfo {
            width: Some(1280),
            height: Some(720),
            fps: Some(30.0),
            bitrate_kbps: Some(1500),
            codec: Some("h264".into()),
        }),
    })
}

#[derive(Default)]
struct Options {
    s3: FakeS3Options,
    register: Option<RegisterBehavior>,
    remote: Vec<(&'static str, u64)>,
    fake_clock: bool,
    hooks: Option<RecordingHooks>,
}

struct Rig {
    _dir: tempfile::TempDir,
    root: PathBuf,
    tmp_root: PathBuf,
    tmp_dir: PathBuf,
    s3: FakeS3,
    register: Arc<FakeRegister>,
    runner: Arc<FakePipelineRunner>,
    hooks: Arc<RecordingHooks>,
    cancel: CancellationToken,
    deps: PipelineDeps,
    config: AppConfig,
}

fn write_video_files(dir: &Path) {
    for (name, size) in sizes() {
        if name == PLAYLIST_FILE {
            std::fs::write(dir.join(name), playlist_text()).unwrap();
        } else {
            std::fs::write(dir.join(name), vec![0u8; size as usize]).unwrap();
        }
    }
}

fn rig(options: Options) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let tmp_root = root.join("tmp");
    let tmp_dir = tmp_root.join(PUBLIC_ID);

    std::fs::create_dir_all(&tmp_dir).unwrap();

    let runner = FakePipelineRunner::new(FakeRunnerOptions::default());
    let s3 = FakeS3::new(options.s3);

    for (name, size) in options.remote {
        s3.set_object(&format!("{PREFIX}{name}"), size);
    }

    let register = match options.register {
        Some(behavior) => FakeRegister::with(behavior),
        None => FakeRegister::ok(),
    };
    let (sleeper, tuning) = if options.fake_clock {
        let (sleeper, clock) = FakeSleeper::with_clock();

        (sleeper, fake_tuning(&clock))
    } else {
        (Arc::new(FakeSleeper::default()), UploadTuning::default())
    };
    let deps = make_test_deps(TestDepsInput {
        runner: runner.clone(),
        s3: Arc::new(s3.clone()),
        register: register.clone(),
        tmp_root: tmp_root.clone(),
        sleeper,
        free_bytes: PLENTY_OF_SPACE,
        logger: Arc::new(RecordingLogger::default()),
        tuning,
    });

    Rig {
        _dir: dir,
        root,
        tmp_root,
        tmp_dir,
        s3,
        register,
        runner,
        hooks: Arc::new(options.hooks.unwrap_or_default()),
        cancel: CancellationToken::new(),
        deps,
        config: crate::pipeline::testing::fakes::test_config(),
    }
}

impl Rig {
    async fn run(&self) -> Result<PipelineResult, PipelineError> {
        self.run_with(payload(), self.tmp_dir.clone()).await
    }

    async fn run_with(
        &self,
        payload: RegisterPayload,
        tmp_dir: PathBuf,
    ) -> Result<PipelineResult, PipelineError> {
        resume_upload(
            &ResumeUploadInput {
                job_id: "job-1".into(),
                public_id: PUBLIC_ID.into(),
                payload,
                tmp_dir,
            },
            &self.config,
            &self.deps,
            self.hooks.clone() as Arc<dyn PipelineHooks>,
            &self.cancel,
        )
        .await
    }

    fn put_names(&self) -> Vec<String> {
        self.s3
            .put_keys()
            .iter()
            .map(|k| k[PREFIX.len()..].to_string())
            .collect()
    }

    fn deleted_anything(&self) -> bool {
        !self.s3.requests_of(S3RequestKind::Delete).is_empty()
    }
}

#[test]
fn parse_playlist_segments_returns_the_ts_lines() {
    assert_eq!(parse_playlist_segments(&playlist_text()), SEGMENTS);
    assert_eq!(
        parse_playlist_segments("#EXTM3U\r\nsegment_000.ts\r\n\r\n"),
        ["segment_000.ts"]
    );
    assert!(parse_playlist_segments("#EXTM3U\n#EXT-X-ENDLIST\n").is_empty());
    assert_eq!(
        parse_playlist_segments("a.ts\n  a.ts  \nb.ts"),
        ["a.ts", "b.ts"]
    );
}

// ---- local files are gone ------------------------------------------------------------------

async fn expect_unavailable(r: &Rig, tmp_dir: Option<PathBuf>) {
    let error = r
        .run_with(payload(), tmp_dir.unwrap_or_else(|| r.tmp_dir.clone()))
        .await
        .unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert_eq!(error.code.as_deref(), Some("resume_unavailable"));
    assert_eq!(
        error.message,
        "The temporary files for this video are gone, so it cannot be resumed. Retry to process it again."
    );
    // Nothing was touched: no S3 client at all, no register call, no process.
    assert_eq!(r.s3.created(), 0);
    assert!(r.s3.requests().is_empty());
    assert_eq!(r.register.count(), 0);
    assert!(r.runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reports_resume_unavailable_when_a_file_is_missing_and_deletes_nothing() {
    for name in [
        "segment_001.ts",
        "thumbnail.jpg",
        "storyboard_5x5.jpg",
        "playlist.m3u8",
    ] {
        let r = rig(Options {
            remote: vec![("segment_000.ts", 100)],
            ..Options::default()
        });

        write_video_files(&r.tmp_dir);
        std::fs::remove_file(r.tmp_dir.join(name)).unwrap();
        expect_unavailable(&r, None).await;

        assert!(r.tmp_dir.is_dir(), "{name}");
        assert!(r.tmp_dir.join("segment_000.ts").is_file());
        assert_eq!(r.s3.objects().len(), 1);
    }
}

#[tokio::test]
async fn reports_resume_unavailable_when_the_temp_dir_does_not_exist() {
    let r = rig(Options::default());

    std::fs::remove_dir_all(&r.tmp_dir).unwrap();
    expect_unavailable(&r, None).await;
}

#[tokio::test]
async fn reports_resume_unavailable_when_a_segment_is_a_directory() {
    let r = rig(Options::default());

    write_video_files(&r.tmp_dir);
    std::fs::remove_file(r.tmp_dir.join("segment_002.ts")).unwrap();
    std::fs::create_dir(r.tmp_dir.join("segment_002.ts")).unwrap();
    expect_unavailable(&r, None).await;
}

#[tokio::test]
async fn reports_resume_unavailable_when_the_playlist_lists_no_segment_or_a_path() {
    for text in [
        "#EXTM3U\n#EXT-X-ENDLIST\n",
        "#EXTM3U\n../outside.ts\n",
        "#EXTM3U\nsub\\a.ts\n",
    ] {
        let r = rig(Options::default());

        write_video_files(&r.tmp_dir);
        std::fs::write(r.tmp_dir.join("playlist.m3u8"), text).unwrap();
        expect_unavailable(&r, None).await;
    }
}

#[tokio::test]
async fn refuses_a_temp_dir_that_is_not_tmp_root_slash_public_id() {
    let r = rig(Options::default());
    let elsewhere = r.root.join("elsewhere");

    std::fs::create_dir_all(&elsewhere).unwrap();
    write_video_files(&elsewhere);
    expect_unavailable(&r, Some(elsewhere.clone())).await;

    assert!(elsewhere.join("playlist.m3u8").is_file());

    // `..` games resolve to somewhere else too.
    let sneaky = r
        .tmp_root
        .join(PUBLIC_ID)
        .join("..")
        .join("..")
        .join("elsewhere");

    expect_unavailable(&r, Some(sneaky)).await;
    assert!(elsewhere.join("playlist.m3u8").is_file());
}

#[tokio::test]
async fn accepts_the_same_temp_dir_written_differently() {
    let r = rig(Options::default());

    write_video_files(&r.tmp_dir);

    let same = r.tmp_root.join("x").join("..").join(PUBLIC_ID);

    r.run_with(payload(), same).await.unwrap();

    assert!(!r.tmp_dir.exists());
}

#[tokio::test]
async fn rejects_an_invalid_stored_payload_without_touching_anything() {
    let r = rig(Options::default());

    write_video_files(&r.tmp_dir);

    let mut bad = payload();

    bad.title = String::new();

    let error = r.run_with(bad, r.tmp_dir.clone()).await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert_eq!(error.code, None);
    assert_eq!(
        error.message,
        "The stored video data is invalid, so the upload cannot be resumed."
    );
    assert!(r.s3.requests().is_empty());
    assert!(r.tmp_dir.is_dir());

    // A payload of another video is refused the same way.
    let mut other = payload();

    other.public_id = "zz12cd34ef56".into();
    other.disk_prefix = "2026/03/05/clip-zz12cd34ef56/".into();
    other.playlist_path = format!("{}playlist.m3u8", other.disk_prefix);
    other.thumbnail_path = Some(format!("{}thumbnail.jpg", other.disk_prefix));
    other.storyboards = None;

    assert_eq!(
        r.run_with(other, r.tmp_dir.clone())
            .await
            .unwrap_err()
            .message,
        "The stored video data is invalid, so the upload cannot be resumed."
    );
    assert!(r.tmp_dir.is_dir());
}

// ---- uploading the rest --------------------------------------------------------------------

#[tokio::test]
async fn skips_same_size_objects_reuploads_mismatches_uploads_the_playlist_last_and_registers() {
    let playlist_size = playlist_text().len() as u64;
    let r = rig(Options {
        remote: vec![
            ("segment_000.ts", 100),          // same size: skipped
            ("segment_001.ts", 7),            // different size: re-uploaded
            ("thumbnail.jpg", 20),            // skipped
            ("playlist.m3u8", playlist_size), // same size, but still re-uploaded last
        ],
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let result = r.run().await.unwrap();
    let mut names = r.put_names();

    assert_eq!(names.last().map(String::as_str), Some("playlist.m3u8"));

    names.sort();

    assert_eq!(
        names,
        [
            "playlist.m3u8",
            "segment_001.ts",
            "segment_002.ts",
            "storyboard_3x3.jpg",
            "storyboard_5x5.jpg"
        ]
    );
    assert_eq!(r.s3.objects()[&format!("{PREFIX}segment_001.ts")], 101);
    assert_eq!(result.prefix, PREFIX);
    assert_eq!(result.payload, payload());
    assert_eq!(*r.register.payloads.lock().unwrap(), [payload()]);
    // No ffmpeg / ffprobe.
    assert!(r.runner.calls.lock().unwrap().is_empty());
    // Listing uses the cleanup client settings.
    assert_eq!(r.s3.0.purposes.lock().unwrap()[0], ClientPurpose::Cleanup);
    assert_eq!(
        r.hooks.stages(),
        [JobState::Uploading, JobState::Registering]
    );

    let percents = r.hooks.percents();
    let mut sorted = percents.clone();

    sorted.sort_unstable();

    assert_eq!(percents.last(), Some(&100));
    assert_eq!(sorted, percents);
    // Temp dir removed on success; R2 untouched.
    assert!(!r.tmp_dir.exists());
    assert!(!r.deleted_anything());
    assert_eq!(r.s3.destroyed(), r.s3.created());
}

#[tokio::test]
async fn uploads_only_the_playlist_when_everything_else_is_already_on_r2() {
    let r = rig(Options {
        remote: sizes(),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);
    r.run().await.unwrap();

    assert_eq!(r.put_names(), ["playlist.m3u8"]);
    assert_eq!(r.register.count(), 1);
}

#[tokio::test]
async fn reads_every_page_of_the_remote_listing() {
    let r = rig(Options {
        s3: FakeS3Options {
            list_page_size: Some(2),
            ..FakeS3Options::default()
        },
        remote: sizes(),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);
    r.run().await.unwrap();

    assert_eq!(r.s3.requests_of(S3RequestKind::List).len(), 4);
    assert_eq!(r.put_names(), ["playlist.m3u8"]);
}

#[tokio::test]
async fn uploads_everything_when_nothing_is_on_r2_yet() {
    let r = rig(Options::default());

    write_video_files(&r.tmp_dir);
    r.run().await.unwrap();

    assert_eq!(r.put_names().len(), sizes().len());
    assert_eq!(
        r.put_names().last().map(String::as_str),
        Some("playlist.m3u8")
    );
}

#[tokio::test]
async fn does_not_upload_leftovers_the_playlist_does_not_reference() {
    let r = rig(Options {
        remote: sizes(),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);
    std::fs::write(r.tmp_dir.join("segment_009.ts"), [0u8; 5]).unwrap();
    r.run().await.unwrap();

    assert_eq!(r.put_names(), ["playlist.m3u8"]);
}

// ---- failures ------------------------------------------------------------------------------

#[tokio::test]
async fn a_second_network_outage_keeps_the_temp_dir_and_the_r2_objects() {
    let r = rig(Options {
        remote: vec![("segment_000.ts", 100)],
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, _| {
                key.ends_with("segment_002.ts").then(net_error)
            })),
            ..FakeS3Options::default()
        },
        fake_clock: true,
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::UploadInterrupted);
    assert!(error.resumable);
    assert_eq!(error.tmp_dir.as_deref(), Some(r.tmp_dir.as_path()));
    assert_eq!(error.register_payload, Some(payload()));
    assert_eq!(error.prefix.as_deref(), Some(PREFIX));
    assert!(r.tmp_dir.join("playlist.m3u8").is_file());
    assert!(!r.deleted_anything());
    assert!(r.s3.has(&format!("{PREFIX}segment_000.ts")));
    assert_eq!(r.register.count(), 0);
    assert!(r.runner.calls.lock().unwrap().is_empty());
    assert_eq!(r.s3.destroyed(), r.s3.created());
}

#[tokio::test]
async fn still_being_offline_while_listing_is_upload_interrupted_and_keeps_everything() {
    let r = rig(Options {
        s3: FakeS3Options {
            fail_list: Some(Box::new(|| Some(net_error()))),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::UploadInterrupted);
    assert!(error.resumable);
    assert!(r.tmp_dir.is_dir());
    assert!(!r.deleted_anything());
}

#[tokio::test]
async fn a_non_network_listing_error_fails_and_cleans_up() {
    let r = rig(Options {
        s3: FakeS3Options {
            fail_list: Some(Box::new(|| Some(http_error(403, "AccessDenied")))),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert_eq!(
        error.message,
        "Could not read the uploaded files from R2. Check the R2 settings and your connection."
    );
    assert!(!r.tmp_dir.exists());
}

#[tokio::test]
async fn a_non_network_upload_error_deletes_the_r2_prefix_and_the_temp_dir() {
    let r = rig(Options {
        remote: vec![("segment_000.ts", 100)],
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, _| {
                key.ends_with("segment_001.ts")
                    .then(|| http_error(403, "AccessDenied"))
            })),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(!error.resumable);
    assert_eq!(
        r.s3.put_keys()
            .iter()
            .filter(|k| k.ends_with("segment_001.ts"))
            .count(),
        3
    );
    assert!(r.s3.objects().is_empty());
    assert!(!r.tmp_dir.exists());
}

#[tokio::test]
async fn a_cancel_deletes_the_r2_prefix_and_the_temp_dir() {
    let r = rig(Options {
        remote: vec![("segment_000.ts", 100)],
        s3: FakeS3Options {
            block_put: Some(Box::new(|_| true)),
            ..FakeS3Options::default()
        },
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let (result, ()) = tokio::join!(r.run(), async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        r.cancel.cancel();
    });
    let error = result.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Cancelled);
    assert!(r.s3.objects().is_empty());
    assert!(!r.tmp_dir.exists());
    assert_eq!(r.register.count(), 0);
}

#[tokio::test]
async fn http_401_at_register_gives_needs_sign_in_keeping_the_payload_and_r2() {
    let r = rig(Options {
        register: Some(Box::new(|_, _| Err(http_failure(401, None)))),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::NeedsSignIn);
    assert_eq!(error.register_payload, Some(payload()));
    assert_eq!(r.register.count(), 1);
    assert_eq!(r.s3.objects().len(), sizes().len());
    assert!(!r.deleted_anything());
    assert!(!r.tmp_dir.exists());
    assert_eq!(
        r.hooks.stages(),
        [JobState::Uploading, JobState::Registering]
    );
}

#[tokio::test]
async fn a_definitive_register_rejection_deletes_the_r2_prefix() {
    let r = rig(Options {
        remote: vec![("segment_000.ts", 100)],
        register: Some(Box::new(|_, _| {
            Err(http_failure(409, Some("public_id_conflict")))
        })),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Failed);
    assert!(error.definitive);
    assert!(r.s3.objects().is_empty());
    assert!(!r.tmp_dir.exists());
}

#[tokio::test]
async fn register_failing_repeatedly_keeps_r2_and_the_payload() {
    let r = rig(Options {
        register: Some(Box::new(|_, _| Err(network_failure()))),
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::RegisterFailed);
    assert_eq!(error.register_payload, Some(payload()));
    assert_eq!(r.register.count(), 6);
    assert_eq!(r.s3.objects().len(), sizes().len());
}

#[tokio::test]
async fn awaits_on_before_register_after_the_registering_stage_and_before_the_first_request() {
    let register = FakeRegister::ok();
    let seen = register.clone();
    let mut r = rig(Options {
        hooks: Some(RecordingHooks {
            before_register: Some(Box::new(move || {
                assert_eq!(seen.count(), 0);

                Ok(())
            })),
            ..RecordingHooks::default()
        }),
        ..Options::default()
    });

    r.deps.register = register;
    write_video_files(&r.tmp_dir);
    r.run().await.unwrap();

    assert_eq!(
        r.hooks.events(),
        ["stage:uploading", "stage:registering", "before-register"]
    );
}

#[tokio::test]
async fn fires_the_network_hooks_while_waiting() {
    let r = rig(Options {
        s3: FakeS3Options {
            fail_put: Some(Box::new(|key, attempt| {
                (key.ends_with("segment_000.ts") && attempt <= 2).then(net_error)
            })),
            ..FakeS3Options::default()
        },
        fake_clock: true,
        ..Options::default()
    });

    write_video_files(&r.tmp_dir);
    r.run().await.unwrap();

    let events = r.hooks.events();
    let first_wait = events.iter().find(|e| e.starts_with("wait:")).unwrap();

    assert_eq!(first_wait, "wait:2000");
    assert!(events.contains(&"restored".to_string()));
    assert_eq!(r.hooks.restored.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_cancel_before_the_start_is_a_plain_cancel_that_cleans_up() {
    let r = rig(Options::default());

    write_video_files(&r.tmp_dir);
    r.cancel.cancel();

    let error = r.run().await.unwrap_err();

    assert_eq!(error.kind, PipelineErrorKind::Cancelled);
    assert!(!r.tmp_dir.exists());
    assert_eq!(r.register.count(), 0);
}

#[test]
fn a_store_error_listing_classifies_like_the_ts() {
    // Local sanity check of the listing error mapping used above.
    assert_eq!(
        classify_upload_error(&StoreError::Network("x".into()), None),
        UploadErrorClass::Network
    );
}
