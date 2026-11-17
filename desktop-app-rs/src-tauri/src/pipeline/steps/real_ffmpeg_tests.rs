//! The steps against a real ffmpeg/ffprobe (real filesystem, real runner). They SKIP (pass with
//! a note) when the tools are not available: set `FFMPEG_PATH` / `FFPROBE_PATH` or use `PATH`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::env::StepEnv;
use super::probe::{probe_duration, probe_fps, probe_output_info};
use super::storyboard::{generate_storyboards, StoryboardInput};
use super::thumbnail::{generate_thumbnail, ThumbnailInput};
use super::transcode::{transcode_to_hls, TranscodeInput};
use crate::api::{AppConfigTranscode, Resolution};
use crate::dto::JobState;
use crate::ffmpeg::binaries::{command_exists, resolve_binaries, Platform, ResolveBinariesInput};
use crate::ffmpeg::runner::{ProcessRunner, RunProcessInput};
use crate::logger::testing::RecordingLogger;
use crate::pipeline::deps::RealFs;

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
        eprintln!("SKIPPED: ffmpeg/ffprobe not found (set FFMPEG_PATH / FFPROBE_PATH or use PATH)");
        None
    }
}

#[tokio::test]
async fn probe_transcode_thumbnail_and_storyboard_run_on_a_real_video() {
    let Some((ffmpeg, ffprobe)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_path_buf();
    let runner = Arc::new(ProcessRunner::new());
    let mut make = RunProcessInput::new(
        &ffmpeg,
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=6:size=320x240:rate=25",
            "-c:v",
            "libx264",
            "in.mp4",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
        Duration::from_secs(60),
    );

    make.cwd = Some(cwd.clone());

    let made = runner.run(make).await.unwrap();

    if made.exit_code != Some(0) {
        eprintln!("SKIPPED: this ffmpeg cannot encode libx264");
        return;
    }

    let logger = Arc::new(RecordingLogger::default());
    let env = StepEnv {
        run: runner,
        fs: Arc::new(RealFs),
        ffmpeg,
        ffprobe,
        cwd: cwd.clone(),
        cancel: CancellationToken::new(),
        logger: logger.clone(),
        step: JobState::Transcoding,
    };
    let source = cwd.join("in.mp4").to_string_lossy().to_string();

    let duration = probe_duration(&env, &source)
        .await
        .unwrap()
        .expect("duration");

    assert!((duration - 6.0).abs() < 0.5, "{duration}");
    assert!((probe_fps(&env, &source).await.unwrap() - 25.0).abs() < 0.01);

    let fractions = Arc::new(Mutex::new(Vec::<f64>::new()));
    let sink = Arc::clone(&fractions);

    transcode_to_hls(
        &env,
        TranscodeInput {
            input: source.clone(),
            transcode: AppConfigTranscode {
                resolution: Resolution::P480,
                segment_seconds: 2.0,
                fps: None,
            },
            duration: Some(duration),
            output_fps: 25.0,
            threads: None,
            on_fraction: Arc::new(move |f| sink.lock().unwrap().push(f)),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("{e} {:?}", e.stderr_tail));

    {
        let fractions = fractions.lock().unwrap();

        assert_eq!(fractions.last(), Some(&1.0));
        assert!(fractions.windows(2).all(|w| w[0] < w[1]));
    }

    let info = probe_output_info(&env, 2.0).await.unwrap();

    assert_eq!((info.width, info.height), (Some(320), Some(240)));
    assert_eq!(info.codec.as_deref(), Some("h264"));

    let mut thumb_env = env.clone();

    thumb_env.step = JobState::Thumbnail;

    let thumbnail = ThumbnailInput {
        input: source.clone(),
        duration: Some(duration),
        width: info.width,
        height: info.height,
    };

    assert!(generate_thumbnail(&thumb_env, &thumbnail).await.unwrap());
    assert!(cwd.join("thumbnail.jpg").is_file());
    // Landscape: a single 1080x1080 frame.
    let bytes = std::fs::read(cwd.join("thumbnail.jpg")).unwrap();
    let size = super::image_size::jpeg_size(&bytes).expect("jpeg size");

    assert_eq!((size.width, size.height), (1080, 1080));

    let mut board_env = env.clone();

    board_env.step = JobState::Storyboard;

    let boards = generate_storyboards(
        &board_env,
        &StoryboardInput {
            input: source,
            duration: Some(duration),
            prefix: "2026/01/02/clip-ab12cd34ef56/".into(),
            threads: None,
        },
    )
    .await
    .unwrap()
    .expect("storyboards");

    assert_eq!(boards.keys().collect::<Vec<_>>(), ["3x3", "4x4", "5x5"]);

    for (size, pixels) in [(3, 480), (4, 640), (5, 800)] {
        let bytes = std::fs::read(cwd.join(format!("storyboard_{size}x{size}.jpg"))).unwrap();
        let got = super::image_size::jpeg_size(&bytes).expect("jpeg size");

        assert_eq!((got.width, got.height), (pixels, pixels));
    }

    // Only the outputs remain: scratch candidates and tiles are gone.
    let mut left: Vec<String> = std::fs::read_dir(&cwd)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| {
            n.starts_with("candidate_")
                || n.starts_with("tile_")
                || n.starts_with("sc")
                || n.starts_with("thumb_candidate")
        })
        .collect();

    left.sort();

    assert!(left.is_empty(), "{left:?}");
}
