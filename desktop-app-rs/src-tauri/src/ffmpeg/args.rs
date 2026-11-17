//! Pure argument builders for ffmpeg/ffprobe (no binary name in the result). Port of
//! desktop-app/src/main/ffmpeg/args.ts. Every builder mirrors the PHP pipeline
//! (TranscodeVideoJob, ThumbnailGenerator, StoryboardGenerator). Output files use simple relative
//! ASCII names because the process runs with `cwd` = the job temp directory.

use std::fmt;

use super::file_names::{
    storyboard_file_name, tile_sequence_pattern, CANDIDATE_PATTERN, PLAYLIST_FILE, SEGMENT_PATTERN,
    THUMBNAIL_FILE,
};

pub const PROBE_TIMEOUT_SECONDS: u64 = 60;
pub const IMAGE_COMMAND_TIMEOUT_SECONDS: u64 = 60;
pub const UNKNOWN_DURATION_TIMEOUT_SECONDS: u64 = 172_800;
pub const TRANSCODE_TIMEOUT_MULTIPLIER: f64 = 8.0;
pub const TRANSCODE_MIN_TIMEOUT_SECONDS: u64 = 600;
pub const STORYBOARD_TIMEOUT_MULTIPLIER: f64 = 2.0;
pub const STORYBOARD_MIN_TIMEOUT_SECONDS: u64 = 60;

pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const STORYBOARD_TILE_SIZE: u32 = 160;
pub const STORYBOARD_TOTAL_CANDIDATES: u32 = 75;

/// Demuxer allow-list (INPUT option) for every command that reads the user's source file. It
/// covers the five accepted containers (.mp4/.mov = `mov,mp4,m4a,3gp,3g2,mj2`, .mkv/.webm =
/// `matroska,webm`, .avi) and blocks network-capable demuxers such as `hls` or `concat`, so a
/// playlist renamed to `.mp4` cannot make ffmpeg fetch other files or URLs.
pub const SOURCE_FORMAT_WHITELIST: &str = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi";

fn source_format_args() -> Vec<String> {
    vec!["-format_whitelist".into(), SOURCE_FORMAT_WHITELIST.into()]
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

/// A file name that is not safe to embed in a lavfi filter graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsafeFileName(pub String);

impl fmt::Display for UnsafeFileName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Unsafe file name for a lavfi filter: {:?}", self.0)
    }
}

impl std::error::Error for UnsafeFileName {}

/// JS `String(number)` for the values used here (shortest round-trip form, never `e` notation
/// for the ranges that occur: timestamps and durations).
fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if value == 0.0 {
        // `String(-0)` is "0".
        "0".into()
    } else {
        format!("{value}")
    }
}

/// PHP casts floats to string with `precision=14`; mimic it so timestamps and durations render the
/// same way (12.0 -> "12", 1/3 -> "0.33333333333333").
pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return js_number(value);
    }

    // 14 significant digits, then back to a number (`Number(value.toPrecision(14))`).
    let rounded: f64 = format!("{value:.13e}").parse().unwrap_or(value);

    js_number(rounded)
}

pub fn max_width_for_resolution(resolution: &str) -> u32 {
    match resolution {
        "480" => 854,
        "720" => 1280,
        "1080" => 1920,
        _ => DEFAULT_MAX_WIDTH,
    }
}

/// `max(1, round(outputFps * segmentSeconds))`.
pub fn compute_gop(output_fps: f64, segment_seconds: f64) -> u64 {
    let gop = (output_fps * segment_seconds).round();

    if gop >= 1.0 {
        gop as u64
    } else {
        1
    }
}

pub fn transcode_timeout_seconds(duration: Option<f64>) -> u64 {
    match duration {
        None => UNKNOWN_DURATION_TIMEOUT_SECONDS,
        Some(d) => TRANSCODE_MIN_TIMEOUT_SECONDS
            .max((d * TRANSCODE_TIMEOUT_MULTIPLIER).ceil().max(0.0) as u64),
    }
}

pub fn storyboard_timeout_seconds(duration: f64) -> u64 {
    STORYBOARD_MIN_TIMEOUT_SECONDS
        .max((duration * STORYBOARD_TIMEOUT_MULTIPLIER).ceil().max(0.0) as u64)
}

/// `^[A-Za-z0-9._-]+$`
fn assert_safe_file_name(name: &str) -> Result<&str, UnsafeFileName> {
    let safe = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));

    if safe {
        Ok(name)
    } else {
        Err(UnsafeFileName(name.to_string()))
    }
}

// ---- probes -------------------------------------------------------------------------------

pub fn probe_duration_args(input: &str) -> Vec<String> {
    let mut args = strings(&["-v", "error"]);
    args.extend(source_format_args());
    args.extend(strings(&[
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
    ]));

    args
}

pub fn probe_fps_args(input: &str) -> Vec<String> {
    let mut args = strings(&["-v", "error"]);
    args.extend(source_format_args());
    args.extend(strings(&[
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
    ]));

    args
}

/// Probes the first output segment (`segment_000.ts`) for the register payload.
pub fn probe_output_info_args(segment_file: &str) -> Vec<String> {
    strings(&[
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,bit_rate,codec_name",
        "-of",
        "json",
        segment_file,
    ])
}

// ---- transcode ----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct TranscodeArgsInput {
    pub input: String,
    /// Config resolution ("480" | "720" | "1080"); anything else maps to 1280 px.
    pub resolution: String,
    pub segment_seconds: f64,
    /// Config `transcode.fps`; `None` keeps the source frame rate (no `-r`).
    pub fps: Option<f64>,
    /// Frame rate used for the GOP: `fps` when set, otherwise the probed source fps.
    pub output_fps: f64,
    /// Optional encoder thread limit (PHP `FFMPEG_THREADS`); omitted when `None` or <= 0.
    pub threads: Option<i64>,
}

fn thread_args(threads: Option<i64>) -> Vec<String> {
    match threads {
        Some(t) if t > 0 => vec!["-threads".into(), t.to_string()],
        _ => vec![],
    }
}

pub fn transcode_args(options: &TranscodeArgsInput) -> Vec<String> {
    let max_width = max_width_for_resolution(&options.resolution);
    let gop = compute_gop(options.output_fps, options.segment_seconds).to_string();

    let mut args = strings(&["-y"]);
    args.extend(source_format_args());
    args.extend(strings(&[
        "-i",
        &options.input,
        "-vf",
        &format!("scale='min({max_width},iw)':-2"),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-g",
        &gop,
        "-keyint_min",
        &gop,
        "-sc_threshold",
        "0",
    ]));
    args.extend(thread_args(options.threads));

    if let Some(fps) = options.fps {
        args.extend(strings(&["-r", &format_number(fps)]));
    }

    args.extend(strings(&[
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-hls_time",
        &js_number(options.segment_seconds),
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        SEGMENT_PATTERN,
        "-progress",
        "pipe:1",
        "-nostats",
        PLAYLIST_FILE,
    ]));

    args
}

// ---- thumbnail ----------------------------------------------------------------------------

/// Extracts one candidate frame (`-ss` before `-i`, `thumbnail=24` filter).
pub fn thumbnail_frame_args(input: &str, timestamp: f64, output: &str) -> Vec<String> {
    let mut args = strings(&["-y", "-ss", &format_number(timestamp)]);
    args.extend(source_format_args());
    args.extend(strings(&[
        "-i",
        input,
        "-vf",
        "thumbnail=24",
        "-frames:v",
        "1",
        output,
    ]));

    args
}

/// Single-frame fallback for videos shorter than 3 s (or unknown duration): frame at duration/2.
pub fn short_video_thumbnail_args(input: &str, duration: Option<f64>) -> Vec<String> {
    thumbnail_frame_args(input, duration.unwrap_or(0.0) / 2.0, THUMBNAIL_FILE)
}

pub fn saturation_probe_args(image_file: &str) -> Result<Vec<String>, UnsafeFileName> {
    Ok(strings(&[
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        &format!("movie={},signalstats", assert_safe_file_name(image_file)?),
        "-show_entries",
        "frame_tags=lavfi.signalstats.SATAVG",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
    ]))
}

pub fn detail_probe_args(image_file: &str) -> Result<Vec<String>, UnsafeFileName> {
    Ok(strings(&[
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        &format!(
            "movie={},edgedetect,signalstats",
            assert_safe_file_name(image_file)?
        ),
        "-show_entries",
        "frame_tags=lavfi.signalstats.YAVG",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
    ]))
}

/// Smart-crop step 1: scale so the image covers the canvas (aspect ratio kept).
pub fn smart_crop_scale_args(
    input: &str,
    output: &str,
    canvas_width: u32,
    canvas_height: u32,
) -> Vec<String> {
    strings(&[
        "-y",
        "-i",
        input,
        "-vf",
        &format!("scale={canvas_width}:{canvas_height}:force_original_aspect_ratio=increase"),
        "-frames:v",
        "1",
        output,
    ])
}

/// Smart-crop steps 2 (trial crops) and 3 (final crop).
pub fn smart_crop_crop_args(
    input: &str,
    output: &str,
    canvas_width: u32,
    canvas_height: u32,
    x: i64,
    y: i64,
) -> Vec<String> {
    strings(&[
        "-y",
        "-i",
        input,
        "-vf",
        &format!("crop={canvas_width}:{canvas_height}:{x}:{y}"),
        "-frames:v",
        "1",
        output,
    ])
}

/// Joins three 360x1080 columns into the 1080x1080 grid thumbnail.
pub fn hstack_args(columns: [&str; 3], output: &str) -> Vec<String> {
    strings(&[
        "-y",
        "-i",
        columns[0],
        "-i",
        columns[1],
        "-i",
        columns[2],
        "-filter_complex",
        "[0:v][1:v][2:v]hstack=inputs=3[v]",
        "-map",
        "[v]",
        "-frames:v",
        "1",
        output,
    ])
}

// ---- storyboard ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct StoryboardCandidateArgsInput {
    pub input: String,
    pub duration: f64,
    /// Defaults to [`STORYBOARD_TOTAL_CANDIDATES`].
    pub total_candidates: Option<u32>,
    /// Defaults to [`STORYBOARD_TILE_SIZE`].
    pub tile_size: Option<u32>,
    pub threads: Option<i64>,
}

impl StoryboardCandidateArgsInput {
    pub fn new(input: &str, duration: f64) -> Self {
        Self {
            input: input.to_string(),
            duration,
            total_candidates: None,
            tile_size: None,
            threads: None,
        }
    }
}

/// Single decode pass extracting the evenly spaced, square-cropped candidate frames.
pub fn storyboard_candidate_args(options: &StoryboardCandidateArgsInput) -> Vec<String> {
    let total = options
        .total_candidates
        .unwrap_or(STORYBOARD_TOTAL_CANDIDATES);
    let tile = options.tile_size.unwrap_or(STORYBOARD_TILE_SIZE);

    let mut args = strings(&["-y"]);
    args.extend(source_format_args());
    args.extend(strings(&[
        "-i",
        &options.input,
        "-vf",
        &format!(
            "fps={total}/{},crop='min(iw\\,ih)':'min(iw\\,ih)',scale={tile}:{tile}",
            format_number(options.duration)
        ),
        "-frames:v",
        &total.to_string(),
    ]));
    args.extend(thread_args(options.threads));
    args.extend(strings(&["-start_number", "0", CANDIDATE_PATTERN]));

    args
}

pub fn storyboard_tile_args(grid_size: u32) -> Vec<String> {
    strings(&[
        "-y",
        "-start_number",
        "0",
        "-i",
        &tile_sequence_pattern(grid_size),
        "-vf",
        &format!("tile={grid_size}x{grid_size}"),
        "-frames:v",
        "1",
        &storyboard_file_name(grid_size),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl() -> String {
        SOURCE_FORMAT_WHITELIST.to_string()
    }

    fn v(items: &[&str]) -> Vec<String> {
        strings(items)
    }

    fn base_transcode(
        resolution: &str,
        seconds: f64,
        fps: Option<f64>,
        out: f64,
    ) -> TranscodeArgsInput {
        TranscodeArgsInput {
            input: "a.mp4".into(),
            resolution: resolution.into(),
            segment_seconds: seconds,
            fps,
            output_fps: out,
            threads: None,
        }
    }

    fn pos(args: &[String], needle: &str) -> usize {
        args.iter().position(|a| a == needle).unwrap()
    }

    // ---- probe builders ----

    #[test]
    fn probes_duration() {
        assert_eq!(
            probe_duration_args("in.mp4"),
            v(&[
                "-v",
                "error",
                "-format_whitelist",
                &wl(),
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                "in.mp4",
            ])
        );
    }

    #[test]
    fn probes_fps() {
        assert_eq!(
            probe_fps_args("in.mp4"),
            v(&[
                "-v",
                "error",
                "-format_whitelist",
                &wl(),
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=r_frame_rate",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                "in.mp4",
            ])
        );
    }

    #[test]
    fn probes_the_output_info_of_a_segment() {
        assert_eq!(
            probe_output_info_args("segment_000.ts"),
            v(&[
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,r_frame_rate,bit_rate,codec_name",
                "-of",
                "json",
                "segment_000.ts",
            ])
        );
    }

    // ---- source demuxer allow-list ----

    #[test]
    fn whitelist_lists_exactly_the_demuxers_of_the_five_accepted_containers() {
        let mut got: Vec<&str> = SOURCE_FORMAT_WHITELIST.split(',').collect();
        got.sort_unstable();
        let mut want = vec![
            "3g2", "3gp", "avi", "m4a", "matroska", "mj2", "mov", "mp4", "webm",
        ];
        want.sort_unstable();

        assert_eq!(got, want);
        for banned in ["hls", "concat", "http", "file"] {
            assert!(!SOURCE_FORMAT_WHITELIST.contains(banned));
        }
    }

    #[test]
    fn whitelist_is_an_input_option_on_every_command_reading_the_source() {
        let commands = vec![
            transcode_args(&base_transcode("720", 6.0, None, 25.0)),
            thumbnail_frame_args("in.mp4", 1.0, "o.jpg"),
            short_video_thumbnail_args("in.mp4", Some(2.0)),
            storyboard_candidate_args(&StoryboardCandidateArgsInput::new("in.mp4", 10.0)),
        ];

        for args in commands {
            let flag = pos(&args, "-format_whitelist");

            assert_eq!(args[flag + 1], SOURCE_FORMAT_WHITELIST);
            assert!(flag < pos(&args, "-i"));
        }

        for args in [probe_duration_args("in.mp4"), probe_fps_args("in.mp4")] {
            let flag = pos(&args, "-format_whitelist");

            assert!(flag < args.len() - 1);
            assert_eq!(args.last().unwrap(), "in.mp4");
        }
    }

    #[test]
    fn whitelist_is_not_added_to_commands_reading_only_our_own_files() {
        let own = [
            probe_output_info_args("segment_000.ts"),
            storyboard_tile_args(3),
            saturation_probe_args("a.jpg").unwrap(),
        ];

        for args in own {
            assert!(!args.contains(&"-format_whitelist".to_string()));
        }
    }

    // ---- transcodeArgs ----

    #[test]
    fn builds_the_default_transcode_command() {
        let args = transcode_args(&TranscodeArgsInput {
            input: "C:\\v\\in.mp4".into(),
            resolution: "720".into(),
            segment_seconds: 6.0,
            fps: None,
            output_fps: 29.97,
            threads: None,
        });

        assert_eq!(
            args,
            v(&[
                "-y",
                "-format_whitelist",
                &wl(),
                "-i",
                "C:\\v\\in.mp4",
                "-vf",
                "scale='min(1280,iw)':-2",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-g",
                "180",
                "-keyint_min",
                "180",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-hls_time",
                "6",
                "-hls_playlist_type",
                "vod",
                "-hls_segment_filename",
                "segment_%03d.ts",
                "-progress",
                "pipe:1",
                "-nostats",
                "playlist.m3u8",
            ])
        );
    }

    #[test]
    fn adds_r_only_when_fps_is_configured_before_the_audio_options() {
        let args = transcode_args(&base_transcode("480", 4.0, Some(24.0), 24.0));
        let r = pos(&args, "-r");

        assert_eq!(args[r..r + 3], v(&["-r", "24", "-c:a"])[..]);
        assert!(args.contains(&"scale='min(854,iw)':-2".to_string()));
        let g = pos(&args, "-g");
        assert_eq!(args[g..g + 2], v(&["-g", "96"])[..]);
    }

    #[test]
    fn adds_optional_thread_limits_right_after_sc_threshold() {
        let mut input = base_transcode("1080", 6.0, Some(30.0), 30.0);
        input.threads = Some(4);
        let args = transcode_args(&input);
        let i = pos(&args, "-sc_threshold");

        assert_eq!(
            args[i..i + 5],
            v(&["-sc_threshold", "0", "-threads", "4", "-r"])[..]
        );
        assert!(args.contains(&"scale='min(1920,iw)':-2".to_string()));
    }

    #[test]
    fn ignores_a_zero_or_negative_thread_count() {
        for threads in [Some(0), Some(-2), None] {
            let mut input = base_transcode("720", 6.0, None, 30.0);
            input.threads = threads;

            assert!(!transcode_args(&input).contains(&"-threads".to_string()));
        }
    }

    // ---- transcode helpers ----

    #[test]
    fn maps_resolutions_to_widths() {
        for (resolution, width) in [
            ("480", 854),
            ("720", 1280),
            ("1080", 1920),
            ("360", 1280),
            ("", 1280),
            ("abc", 1280),
        ] {
            assert_eq!(max_width_for_resolution(resolution), width, "{resolution}");
        }
    }

    #[test]
    fn computes_the_gop() {
        for (fps, seconds, gop) in [
            (30.0, 6.0, 180),
            (29.97, 6.0, 180),
            (23.976, 6.0, 144),
            (25.0, 4.0, 100),
            (0.0, 6.0, 1),
            (0.01, 2.0, 1),
            (59.94, 2.5, 150),
        ] {
            assert_eq!(compute_gop(fps, seconds), gop, "gop({fps}, {seconds})");
        }
    }

    #[test]
    fn rounds_half_away_from_zero_like_php_for_positive_values() {
        assert_eq!(compute_gop(2.5, 1.0), 3);
        assert_eq!(compute_gop(0.5, 1.0), 1);
    }

    #[test]
    fn transcode_timeout() {
        for (duration, seconds) in [
            (None, 172_800),
            (Some(0.0), 600),
            (Some(10.0), 600),
            (Some(75.0), 600),
            (Some(75.1), 601),
            (Some(3600.0), 28_800),
            (Some(3600.2), 28_802),
        ] {
            assert_eq!(transcode_timeout_seconds(duration), seconds, "{duration:?}");
        }
    }

    #[test]
    fn storyboard_timeout() {
        for (duration, seconds) in [
            (1.0, 60),
            (30.0, 60),
            (31.0, 62),
            (100.2, 201),
            (3600.0, 7200),
        ] {
            assert_eq!(storyboard_timeout_seconds(duration), seconds, "{duration}");
        }
    }

    #[test]
    fn formats_numbers_like_php_precision_14() {
        assert_eq!(format_number(12.0), "12");
        assert_eq!(format_number(12.5), "12.5");
        assert_eq!(format_number(1.0 / 3.0), "0.33333333333333");
        assert_eq!(format_number(0.1 + 0.2), "0.3");
        assert_eq!(format_number(0.0), "0");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(format_number(120.5), "120.5");
        assert_eq!(format_number(f64::NAN), "NaN");
    }

    // ---- thumbnail builders ----

    #[test]
    fn extracts_a_candidate_frame() {
        assert_eq!(
            thumbnail_frame_args("in.mp4", 12.5, "thumb_candidate_0.jpg"),
            v(&[
                "-y",
                "-ss",
                "12.5",
                "-format_whitelist",
                &wl(),
                "-i",
                "in.mp4",
                "-vf",
                "thumbnail=24",
                "-frames:v",
                "1",
                "thumb_candidate_0.jpg",
            ])
        );
    }

    #[test]
    fn extracts_the_single_frame_for_short_videos_at_half_the_duration() {
        assert_eq!(
            short_video_thumbnail_args("in.mp4", Some(2.0)),
            v(&[
                "-y",
                "-ss",
                "1",
                "-format_whitelist",
                &wl(),
                "-i",
                "in.mp4",
                "-vf",
                "thumbnail=24",
                "-frames:v",
                "1",
                "thumbnail.jpg",
            ])
        );
        assert_eq!(short_video_thumbnail_args("in.mp4", None)[2], "0");
    }

    #[test]
    fn measures_saturation_and_detail_through_lavfi_movie() {
        assert_eq!(
            saturation_probe_args("thumb_candidate_0.jpg").unwrap(),
            v(&[
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "movie=thumb_candidate_0.jpg,signalstats",
                "-show_entries",
                "frame_tags=lavfi.signalstats.SATAVG",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
        );
        assert_eq!(
            detail_probe_args("candidate_0001.jpg").unwrap(),
            v(&[
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "movie=candidate_0001.jpg,edgedetect,signalstats",
                "-show_entries",
                "frame_tags=lavfi.signalstats.YAVG",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
        );
    }

    #[test]
    fn refuses_an_unsafe_lavfi_file_name() {
        for name in [
            "C:\\tmp\\a.jpg",
            "dir/a.jpg",
            "a'b.jpg",
            "a b.jpg",
            "a,b.jpg",
            "a:b.jpg",
            "",
            "\u{e9}.jpg",
            "a;b.jpg",
        ] {
            for result in [saturation_probe_args(name), detail_probe_args(name)] {
                let error = result.unwrap_err();

                assert!(
                    error.to_string().contains("Unsafe file name"),
                    "{name:?} -> {error}"
                );
            }
        }
    }

    #[test]
    fn builds_the_smart_crop_scale_and_crop_steps() {
        assert_eq!(
            smart_crop_scale_args("a.jpg", "b.jpg", 360, 1080),
            v(&[
                "-y",
                "-i",
                "a.jpg",
                "-vf",
                "scale=360:1080:force_original_aspect_ratio=increase",
                "-frames:v",
                "1",
                "b.jpg",
            ])
        );
        assert_eq!(
            smart_crop_crop_args("b.jpg", "c.jpg", 360, 1080, 12, 0),
            v(&[
                "-y",
                "-i",
                "b.jpg",
                "-vf",
                "crop=360:1080:12:0",
                "-frames:v",
                "1",
                "c.jpg",
            ])
        );
    }

    #[test]
    fn joins_three_columns_with_hstack() {
        assert_eq!(
            hstack_args(["c0.jpg", "c1.jpg", "c2.jpg"], "thumbnail.jpg"),
            v(&[
                "-y",
                "-i",
                "c0.jpg",
                "-i",
                "c1.jpg",
                "-i",
                "c2.jpg",
                "-filter_complex",
                "[0:v][1:v][2:v]hstack=inputs=3[v]",
                "-map",
                "[v]",
                "-frames:v",
                "1",
                "thumbnail.jpg",
            ])
        );
    }

    // ---- storyboard builders ----

    #[test]
    fn extracts_the_75_candidates_in_one_pass() {
        assert_eq!(
            storyboard_candidate_args(&StoryboardCandidateArgsInput::new("in.mp4", 120.5)),
            v(&[
                "-y",
                "-format_whitelist",
                &wl(),
                "-i",
                "in.mp4",
                "-vf",
                "fps=75/120.5,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=160:160",
                "-frames:v",
                "75",
                "-start_number",
                "0",
                "candidate_%04d.jpg",
            ])
        );
    }

    #[test]
    fn puts_the_optional_thread_limit_before_start_number() {
        let mut input = StoryboardCandidateArgsInput::new("in.mp4", 60.0);
        input.threads = Some(2);
        let args = storyboard_candidate_args(&input);
        let i = pos(&args, "-threads");

        assert_eq!(args[i..i + 3], v(&["-threads", "2", "-start_number"])[..]);
    }

    #[test]
    fn tiles_a_grid() {
        assert_eq!(
            storyboard_tile_args(4),
            v(&[
                "-y",
                "-start_number",
                "0",
                "-i",
                "tile_4x4_%04d.jpg",
                "-vf",
                "tile=4x4",
                "-frames:v",
                "1",
                "storyboard_4x4.jpg",
            ])
        );
    }
}
