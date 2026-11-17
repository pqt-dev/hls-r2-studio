//! Integration tests against a real ffmpeg/ffprobe. They SKIP (pass with a note) when the tools
//! are not available: set `FFMPEG_PATH` / `FFPROBE_PATH`, or put them on `PATH`.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::args::*;
use super::binaries::{command_exists, resolve_binaries, Platform, ResolveBinariesInput};
use super::file_names::{PLAYLIST_FILE, THUMBNAIL_FILE};
use super::probe_parse::{
    parse_duration_output, parse_frame_rate_output, parse_output_info, ParseOutputInfoOptions,
};
use super::progress::{to_fraction, ProgressParser};
use super::runner::{ProcessRunner, RunProcessInput, RunResult};
use super::self_check::{check_ffmpeg, ProcessTextRunner};

struct Tools {
    ffmpeg: String,
    ffprobe: String,
}

/// The dev-mode resolution (env override, else PATH), `None` when a tool is missing.
fn tools() -> Option<Tools> {
    let env = |key: &str| std::env::var(key).ok();
    let found = resolve_binaries(&ResolveBinariesInput {
        platform: Platform::current(),
        resources_dir: "",
        env: &env,
        is_packaged: false,
    });

    if command_exists(&found.ffmpeg) && command_exists(&found.ffprobe) {
        Some(Tools {
            ffmpeg: found.ffmpeg,
            ffprobe: found.ffprobe,
        })
    } else {
        eprintln!("SKIPPED: ffmpeg/ffprobe not found (set FFMPEG_PATH / FFPROBE_PATH or use PATH)");
        None
    }
}

async fn run(tool: &str, cwd: &Path, args: Vec<String>, timeout: u64) -> RunResult {
    let mut input = RunProcessInput::new(tool, args, Duration::from_secs(timeout));
    input.cwd = Some(cwd.to_path_buf());
    input.collect_stdout = true;

    ProcessRunner::new().run(input).await.unwrap()
}

#[tokio::test]
async fn the_self_check_runs_against_the_real_ffmpeg() {
    let Some(tools) = tools() else { return };
    let runner = ProcessTextRunner::new(Arc::new(ProcessRunner::new()), &tools.ffmpeg);

    let result = check_ffmpeg(&runner).await;

    assert!(result.version.is_some(), "{result:?}");
    // `ok` depends on the build (libx264, filters); the missing list must then name them.
    assert_eq!(result.ok, result.missing.is_empty());
}

#[tokio::test]
async fn transcodes_probes_and_extracts_images_with_the_real_tools() {
    let Some(tools) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();

    // A 3 s, 25 fps, 320x240 source with audio.
    let make = run(
        &tools.ffmpeg,
        cwd,
        [
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3:size=320x240:rate=25",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=3",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            "in.mp4",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
        60,
    )
    .await;

    if make.exit_code != Some(0) {
        eprintln!("SKIPPED: this ffmpeg cannot encode libx264/aac");
        return;
    }

    // probe duration / fps
    let duration = run(
        &tools.ffprobe,
        cwd,
        probe_duration_args("in.mp4"),
        PROBE_TIMEOUT_SECONDS,
    )
    .await;
    let duration = parse_duration_output(duration.stdout()).expect("duration");
    assert!((duration - 3.0).abs() < 0.5, "{duration}");

    let fps = run(
        &tools.ffprobe,
        cwd,
        probe_fps_args("in.mp4"),
        PROBE_TIMEOUT_SECONDS,
    )
    .await;
    assert!((parse_frame_rate_output(fps.stdout()) - 25.0).abs() < 0.01);

    // transcode to HLS, streaming progress
    let parser = Arc::new(Mutex::new(ProgressParser::new()));
    let fraction = Arc::new(Mutex::new(0.0_f64));
    let ended = Arc::new(Mutex::new(false));
    let mut input = RunProcessInput::new(
        &tools.ffmpeg,
        transcode_args(&TranscodeArgsInput {
            input: "in.mp4".into(),
            resolution: "720".into(),
            segment_seconds: 2.0,
            fps: None,
            output_fps: 25.0,
            threads: None,
        }),
        Duration::from_secs(transcode_timeout_seconds(Some(duration))),
    );
    input.cwd = Some(cwd.to_path_buf());
    let (p, f, e) = (
        Arc::clone(&parser),
        Arc::clone(&fraction),
        Arc::clone(&ended),
    );
    input.on_stdout = Some(Box::new(move |chunk| {
        let update = p.lock().unwrap().feed(chunk);

        if let Some(out) = update.out_time_seconds {
            let mut current = f.lock().unwrap();

            *current = to_fraction(out, Some(duration), *current).unwrap_or(*current);
        }
        if update.ended {
            *e.lock().unwrap() = true;
        }
    }));

    let result = ProcessRunner::new().run(input).await.unwrap();

    assert_eq!(result.exit_code, Some(0), "{:?}", result.stderr_tail);
    assert!(*ended.lock().unwrap(), "progress=end was not seen");
    assert!(*fraction.lock().unwrap() > 0.9);
    assert!(cwd.join(PLAYLIST_FILE).is_file());
    assert!(cwd.join("segment_000.ts").is_file());

    // probe the first segment
    let info = run(
        &tools.ffprobe,
        cwd,
        probe_output_info_args("segment_000.ts"),
        PROBE_TIMEOUT_SECONDS,
    )
    .await;
    let segment_bytes = std::fs::metadata(cwd.join("segment_000.ts")).unwrap().len();
    let info = parse_output_info(
        info.stdout(),
        &ParseOutputInfoOptions {
            segment_bytes,
            segment_seconds: 2.0,
        },
    );

    assert_eq!((info.width, info.height), (Some(320), Some(240)));
    assert_eq!(info.codec.as_deref(), Some("h264"));
    assert!(info.bitrate_kbps.unwrap_or(0) > 0);

    // thumbnail + lavfi image probes
    let thumb = run(
        &tools.ffmpeg,
        cwd,
        short_video_thumbnail_args("in.mp4", Some(duration)),
        IMAGE_COMMAND_TIMEOUT_SECONDS,
    )
    .await;
    assert_eq!(thumb.exit_code, Some(0), "{:?}", thumb.stderr_tail);
    assert!(cwd.join(THUMBNAIL_FILE).is_file());

    for args in [
        saturation_probe_args(THUMBNAIL_FILE).unwrap(),
        detail_probe_args(THUMBNAIL_FILE).unwrap(),
    ] {
        let probe = run(&tools.ffprobe, cwd, args, PROBE_TIMEOUT_SECONDS).await;

        assert_eq!(probe.exit_code, Some(0), "{:?}", probe.stderr_tail);
        assert!(
            probe.stdout().trim().parse::<f64>().is_ok(),
            "{:?}",
            probe.stdout()
        );
    }

    // storyboard candidates
    let candidates = run(
        &tools.ffmpeg,
        cwd,
        storyboard_candidate_args(&StoryboardCandidateArgsInput::new("in.mp4", duration)),
        storyboard_timeout_seconds(duration),
    )
    .await;

    assert_eq!(
        candidates.exit_code,
        Some(0),
        "{:?}",
        candidates.stderr_tail
    );
    assert!(cwd.join("candidate_0000.jpg").is_file());
}
