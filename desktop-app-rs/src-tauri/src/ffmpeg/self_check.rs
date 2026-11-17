//! Startup self check of the ffmpeg build (spec 4.2): required encoders, muxers and filters.
//! Port of desktop-app/src/main/ffmpeg/selfCheck.ts.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use serde_json::json;

use super::runner::{ProcessRunner, RunProcessInput};
use crate::dto::FfmpegDiagnostics;
use crate::logger::Log;

pub const REQUIRED_ENCODERS: [&str; 2] = ["libx264", "aac"];
pub const REQUIRED_MUXERS: [&str; 1] = ["hls"];
pub const REQUIRED_FILTERS: [&str; 9] = [
    "scale",
    "thumbnail",
    "signalstats",
    "edgedetect",
    "hstack",
    "tile",
    "crop",
    "fps",
    "movie",
];

pub const DEFAULT_SELF_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegCheckResult {
    pub ok: bool,
    pub version: Option<String>,
    /// Entries like `encoder:libx264`, `muxer:hls`, `filter:movie`, or `ffmpeg:version`.
    pub missing: Vec<String>,
}

/// Runs ffmpeg with the given args; resolves to the stdout text, or `None` when it failed.
#[async_trait]
pub trait FfmpegTextRunner: Send + Sync {
    async fn run(&self, args: &[&str]) -> Option<String>;
}

/// [`FfmpegTextRunner`] backed by a real [`ProcessRunner`].
pub struct ProcessTextRunner {
    runner: Arc<ProcessRunner>,
    ffmpeg_path: String,
    timeout: Duration,
}

impl ProcessTextRunner {
    pub fn new(runner: Arc<ProcessRunner>, ffmpeg_path: &str) -> Self {
        Self::with_timeout(runner, ffmpeg_path, DEFAULT_SELF_CHECK_TIMEOUT)
    }

    pub fn with_timeout(runner: Arc<ProcessRunner>, ffmpeg_path: &str, timeout: Duration) -> Self {
        Self {
            runner,
            ffmpeg_path: ffmpeg_path.to_string(),
            timeout,
        }
    }
}

#[async_trait]
impl FfmpegTextRunner for ProcessTextRunner {
    async fn run(&self, args: &[&str]) -> Option<String> {
        let mut input = RunProcessInput::new(
            &self.ffmpeg_path,
            args.iter().map(|a| (*a).to_string()).collect(),
            self.timeout,
        );
        input.collect_stdout = true;

        match self.runner.run(input).await {
            Ok(result) if result.exit_code == Some(0) => {
                Some(result.stdout_text.unwrap_or_default())
            }
            _ => None,
        }
    }
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("self-check pattern"))
}

/// `ffmpeg version 9.0.1 Copyright ...` -> `9.0.1`.
pub fn parse_version(output: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();

    regex(&RE, r"(?m)^ffmpeg version (\S+)")
        .captures(output)
        .map(|c| c[1].to_string())
}

fn collect(output: &str, pattern: &Regex, split_commas: bool) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();

    for line in output.lines() {
        let Some(name) = pattern.captures(line).map(|c| c[1].to_string()) else {
            continue;
        };

        if split_commas {
            names.extend(name.split(',').map(str::to_string));
        } else {
            names.insert(name);
        }
    }

    names
}

/// Lines such as ` V....D libx264   libx264 H.264 ...` (flags: type + 5 capability chars).
pub fn parse_encoder_names(output: &str) -> std::collections::HashSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();

    collect(output, regex(&RE, r"^\s*[VAS][A-Z.]{5}\s+(\S+)"), false)
}

/// Lines such as ` T.C scale   V->V   Scale the input video ...` (3 flag chars, then `in->out`).
pub fn parse_filter_names(output: &str) -> std::collections::HashSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();

    collect(
        output,
        regex(&RE, r"^\s*[A-Z.]{2,3}\s+(\S+)\s+\S+->\S+"),
        false,
    )
}

/// Lines such as `  E hls    Apple HTTP Live Streaming muxer` (` E`, `D `, `DE`).
pub fn parse_muxer_names(output: &str) -> std::collections::HashSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();

    collect(output, regex(&RE, r"^\s*(?:D?E)\s+(\S+)"), true)
}

fn missing_from(
    kind: &str,
    required: &[&str],
    available: Option<&std::collections::HashSet<String>>,
) -> Vec<String> {
    required
        .iter()
        .filter(|name| match available {
            Some(set) => !set.contains(**name),
            None => true,
        })
        .map(|name| format!("{kind}:{name}"))
        .collect()
}

pub async fn check_ffmpeg(runner: &dyn FfmpegTextRunner) -> FfmpegCheckResult {
    let (version_text, encoders, filters, muxers) = tokio::join!(
        runner.run(&["-hide_banner", "-version"]),
        runner.run(&["-hide_banner", "-encoders"]),
        runner.run(&["-hide_banner", "-filters"]),
        runner.run(&["-hide_banner", "-muxers"]),
    );

    let version = version_text.as_deref().and_then(parse_version);
    let encoder_names = encoders.as_deref().map(parse_encoder_names);
    let muxer_names = muxers.as_deref().map(parse_muxer_names);
    let filter_names = filters.as_deref().map(parse_filter_names);

    let mut missing = Vec::new();

    if version.is_none() {
        missing.push("ffmpeg:version".to_string());
    }

    missing.extend(missing_from(
        "encoder",
        &REQUIRED_ENCODERS,
        encoder_names.as_ref(),
    ));
    missing.extend(missing_from(
        "muxer",
        &REQUIRED_MUXERS,
        muxer_names.as_ref(),
    ));
    missing.extend(missing_from(
        "filter",
        &REQUIRED_FILTERS,
        filter_names.as_ref(),
    ));

    FfmpegCheckResult {
        ok: missing.is_empty(),
        version,
        missing,
    }
}

/// Result of the startup self check, as shown by `diagnostics_get`. Starts unchecked.
#[derive(Debug)]
pub struct FfmpegStatus {
    inner: std::sync::Mutex<FfmpegDiagnostics>,
}

impl Default for FfmpegStatus {
    fn default() -> Self {
        Self::new()
    }
}

impl FfmpegStatus {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(FfmpegDiagnostics {
                checked: false,
                ok: false,
                version: None,
                missing: vec![],
            }),
        }
    }

    pub fn get(&self) -> FfmpegDiagnostics {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn set(&self, value: FfmpegDiagnostics) {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
    }
}

/// Runs the self check and stores the outcome in `status` (index.ts: `checkFfmpeg(...).then/catch`).
/// The check runs in its own task so that a crash of it still ends as `checked: true, ok: false`.
pub async fn run_startup_self_check(
    runner: Arc<dyn FfmpegTextRunner>,
    status: Arc<FfmpegStatus>,
    logger: Arc<dyn Log>,
) {
    let task = tokio::spawn(async move { check_ffmpeg(runner.as_ref()).await });

    match task.await {
        Ok(result) => {
            status.set(FfmpegDiagnostics {
                checked: true,
                ok: result.ok,
                version: result.version.clone(),
                missing: result.missing.clone(),
            });

            if result.ok {
                logger.info(
                    "ffmpeg self-check passed",
                    Some(json!({ "version": result.version })),
                );
            } else {
                logger.error(
                    "ffmpeg self-check failed",
                    Some(json!({ "missing": result.missing })),
                );
            }
        }
        Err(error) => {
            status.set(FfmpegDiagnostics {
                checked: true,
                ok: false,
                version: None,
                missing: vec!["ffmpeg:run".into()],
            });
            logger.error(
                "ffmpeg self-check crashed",
                Some(json!({ "error": error.to_string() })),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const VERSION: &str = "ffmpeg version 7.1.1-essentials_build Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 14";

    const ENCODERS: &str = "Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
";

    const MUXERS: &str = "File formats:
 D. = Demuxing supported
 .E = Muxing supported
 --
 D  aac             raw ADTS AAC
  E hls             Apple HTTP Live Streaming
 DE mov             QuickTime / MOV
  E mp4             MP4 (MPEG-4 Part 14)
";

    fn filters(names: &[&str]) -> String {
        let lines: Vec<String> = names
            .iter()
            .map(|n| format!(" ... {n:<16} V->V       Some filter."))
            .collect();

        format!(
            "Filters:\n  T.. = Timeline support\n ------\n{}\n .. movie            |->N       Read from a movie source.\n",
            lines.join("\n")
        )
    }

    /// Answers by the second argument (`-version`, `-encoders`, ...).
    struct FakeRunner(HashMap<String, Option<String>>);

    #[async_trait]
    impl FfmpegTextRunner for FakeRunner {
        async fn run(&self, args: &[&str]) -> Option<String> {
            self.0.get(args[1]).cloned().flatten()
        }
    }

    fn runner_for(outputs: &[(&str, Option<String>)]) -> FakeRunner {
        FakeRunner(
            outputs
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.clone()))
                .collect(),
        )
    }

    fn full() -> Vec<(&'static str, Option<String>)> {
        let names: Vec<&str> = REQUIRED_FILTERS
            .iter()
            .copied()
            .filter(|f| *f != "movie")
            .collect();

        vec![
            ("-version", Some(VERSION.to_string())),
            ("-encoders", Some(ENCODERS.to_string())),
            ("-muxers", Some(MUXERS.to_string())),
            ("-filters", Some(filters(&names))),
        ]
    }

    #[test]
    fn parses_the_version() {
        assert_eq!(
            parse_version(VERSION).as_deref(),
            Some("7.1.1-essentials_build")
        );
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn parses_encoder_muxer_and_filter_names() {
        assert!(parse_encoder_names(ENCODERS).contains("libx264"));
        assert!(parse_encoder_names(ENCODERS).contains("aac"));
        assert_eq!(
            parse_muxer_names(MUXERS),
            ["hls", "mov", "mp4"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        );
        assert!(parse_filter_names(&filters(&["scale", "tile"])).contains("movie"));
    }

    #[tokio::test]
    async fn accepts_a_complete_build() {
        assert_eq!(
            check_ffmpeg(&runner_for(&full())).await,
            FfmpegCheckResult {
                ok: true,
                version: Some("7.1.1-essentials_build".into()),
                missing: vec![],
            }
        );
    }

    #[tokio::test]
    async fn lists_every_missing_feature() {
        let mut outputs = full();
        outputs.retain(|(k, _)| !["-encoders", "-filters", "-muxers"].contains(k));
        outputs.push(("-encoders", Some(" A....D aac   AAC\n".into())));
        outputs.push(("-filters", Some(filters(&["scale", "crop"]))));
        outputs.push(("-muxers", Some(" DE mov  QuickTime\n".into())));

        let result = check_ffmpeg(&runner_for(&outputs)).await;

        assert!(!result.ok);
        for expected in [
            "encoder:libx264",
            "muxer:hls",
            "filter:thumbnail",
            "filter:signalstats",
            "filter:edgedetect",
            "filter:hstack",
            "filter:tile",
            "filter:fps",
        ] {
            assert!(result.missing.contains(&expected.to_string()), "{expected}");
        }
        for unexpected in ["filter:scale", "filter:movie", "encoder:aac"] {
            assert!(
                !result.missing.contains(&unexpected.to_string()),
                "{unexpected}"
            );
        }
    }

    #[tokio::test]
    async fn fails_when_ffmpeg_cannot_be_run_at_all() {
        let result = check_ffmpeg(&runner_for(&[])).await;

        assert!(!result.ok);
        assert_eq!(result.version, None);
        assert!(result.missing.contains(&"ffmpeg:version".to_string()));
        assert!(result.missing.contains(&"encoder:libx264".to_string()));
    }

    #[tokio::test]
    async fn startup_check_stores_the_result_for_diagnostics() {
        let status = Arc::new(FfmpegStatus::new());

        assert!(!status.get().checked);

        let logger = Arc::new(crate::logger::testing::RecordingLogger::default());
        run_startup_self_check(Arc::new(runner_for(&full())), status.clone(), logger).await;

        assert_eq!(
            status.get(),
            FfmpegDiagnostics {
                checked: true,
                ok: true,
                version: Some("7.1.1-essentials_build".into()),
                missing: vec![],
            }
        );
    }

    #[tokio::test]
    async fn startup_check_reports_missing_binaries_without_failing() {
        let status = Arc::new(FfmpegStatus::new());
        let logger = Arc::new(crate::logger::testing::RecordingLogger::default());

        run_startup_self_check(Arc::new(runner_for(&[])), status.clone(), logger).await;

        let got = status.get();

        assert!(got.checked && !got.ok);
        assert!(got.missing.contains(&"ffmpeg:version".to_string()));
    }

    struct PanicRunner;

    #[async_trait]
    impl FfmpegTextRunner for PanicRunner {
        async fn run(&self, _args: &[&str]) -> Option<String> {
            panic!("boom");
        }
    }

    #[tokio::test]
    async fn a_crashing_check_ends_as_checked_and_not_ok() {
        let status = Arc::new(FfmpegStatus::new());
        let logger = Arc::new(crate::logger::testing::RecordingLogger::default());

        run_startup_self_check(Arc::new(PanicRunner), status.clone(), logger).await;

        assert_eq!(
            status.get(),
            FfmpegDiagnostics {
                checked: true,
                ok: false,
                version: None,
                missing: vec!["ffmpeg:run".into()],
            }
        );
    }
}
