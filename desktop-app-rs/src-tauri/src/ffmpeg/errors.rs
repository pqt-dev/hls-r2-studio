//! Typed pipeline failure and the helpers that turn a [`RunResult`] into one. Port of
//! desktop-app/src/main/pipeline/errors.ts (all of it: the ffmpeg layer, the upload, the
//! register retry and the resume use the same type) and the run-result helpers of
//! pipeline/steps/env.ts.
//!
//! `message` is safe English text for the UI (no absolute user paths).

use std::fmt;
use std::path::PathBuf;

use super::runner::RunResult;
use crate::dto::JobState;
use crate::pipeline::register::RegisterPayload;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineErrorKind {
    Cancelled,
    Failed,
    RegisterFailed,
    NeedsSignIn,
    /// The network stayed down for the whole stall budget while uploading. The R2 objects and
    /// the temp dir are kept (`resumable`), so `resume_upload` can continue without transcoding
    /// again.
    UploadInterrupted,
}

impl PipelineErrorKind {
    /// The TS string (`'register_failed'`, ...), for logs and the queue.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::RegisterFailed => "register_failed",
            Self::NeedsSignIn => "needs_sign_in",
            Self::UploadInterrupted => "upload_interrupted",
        }
    }
}

/// `PipelineError.code` of a resume that cannot work because the kept temp files are gone.
pub const RESUME_UNAVAILABLE: &str = "resume_unavailable";

pub const UPLOAD_INTERRUPTED_MESSAGE: &str =
    "Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.";

pub const CANCELLED_MESSAGE: &str = "The job was cancelled.";

#[derive(Debug, Clone, PartialEq)]
pub struct PipelineError {
    pub kind: PipelineErrorKind,
    pub step: JobState,
    pub message: String,
    /// `None` when the process was killed by a signal or never produced an exit code.
    pub exit_code: Option<i32>,
    pub stderr_tail: Vec<String>,
    /// Set for register_failed / needs_sign_in / upload_interrupted so register can be retried
    /// without re-uploading.
    pub register_payload: Option<RegisterPayload>,
    pub prefix: Option<String>,
    /// True only when the site answered with a code that proves the video can never be
    /// registered (`playlist_not_found`, `public_id_conflict`). Only then may the R2 files be
    /// deleted.
    pub definitive: bool,
    /// Machine readable reason, e.g. [`RESUME_UNAVAILABLE`].
    pub code: Option<String>,
    /// True when the upload can be continued with `resume_upload` (kind `upload_interrupted`).
    pub resumable: bool,
    /// Kept temp directory of a resumable failure.
    pub tmp_dir: Option<PathBuf>,
    /// Diagnostic text of the underlying error (the TS `cause`). For the (redacting) log only,
    /// never shown in the UI.
    pub cause: Option<String>,
}

impl PipelineError {
    /// A bare error (the TS `new PipelineError({ kind, step, message })`).
    pub fn new(kind: PipelineErrorKind, step: JobState, message: impl Into<String>) -> Self {
        Self {
            kind,
            step,
            message: message.into(),
            exit_code: None,
            stderr_tail: vec![],
            register_payload: None,
            prefix: None,
            definitive: false,
            code: None,
            resumable: false,
            tmp_dir: None,
            cause: None,
        }
    }

    pub fn with_cause(mut self, cause: impl fmt::Display) -> Self {
        self.cause = Some(cause.to_string());
        self
    }

    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = Some(prefix.into());
        self
    }
}

impl fmt::Display for PipelineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PipelineError {}

pub fn is_cancelled(error: &PipelineError) -> bool {
    error.kind == PipelineErrorKind::Cancelled
}

pub fn cancelled_error(step: JobState) -> PipelineError {
    PipelineError::new(PipelineErrorKind::Cancelled, step, CANCELLED_MESSAGE)
}

/// `failed(env, message, result)` of the pipeline steps.
pub fn failed(step: JobState, message: &str, result: Option<&RunResult>) -> PipelineError {
    let mut error = PipelineError::new(PipelineErrorKind::Failed, step, message);

    error.exit_code = result.and_then(|r| r.exit_code);
    error.stderr_tail = result.map(|r| r.stderr_tail.clone()).unwrap_or_default();
    error
}

pub fn upload_interrupted_error() -> PipelineError {
    let mut error = PipelineError::new(
        PipelineErrorKind::UploadInterrupted,
        JobState::Uploading,
        UPLOAD_INTERRUPTED_MESSAGE,
    );

    error.resumable = true;
    error
}

/// JS `string.length` (UTF-16 code units), used to order the replacements like the TS.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Replaces the given absolute paths in each line with placeholders (longest path first). Each
/// path is also matched with `/` and backslash swapped, so a Windows path written either way is
/// caught. Paths of 2 characters or fewer are ignored (they would match too much).
pub fn scrub_paths(lines: &[String], replacements: &[(String, &str)]) -> Vec<String> {
    let mut sorted: Vec<&(String, &str)> = replacements
        .iter()
        .filter(|(path, _)| js_length(path) > 2)
        .collect();

    // Stable sort, longest first (like `Array.prototype.sort` with `b.length - a.length`).
    sorted.sort_by_key(|(path, _)| std::cmp::Reverse(js_length(path)));

    lines
        .iter()
        .map(|line| {
            let mut out = line.clone();

            for (path, label) in &sorted {
                let mut variants: Vec<String> = Vec::with_capacity(3);

                for variant in [
                    path.clone(),
                    path.replace('\\', "/"),
                    path.replace('/', "\\"),
                ] {
                    if !variants.contains(&variant) {
                        variants.push(variant);
                    }
                }

                for variant in variants {
                    out = out.split(variant.as_str()).collect::<Vec<_>>().join(label);
                }
            }

            out
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Tool::Ffmpeg => "ffmpeg",
            Tool::Ffprobe => "ffprobe",
        }
    }
}

pub fn succeeded(result: &RunResult) -> bool {
    result.exit_code == Some(0) && !result.timed_out
}

/// Short, path-free description of a failed run, for logs and error messages. A process killed
/// by a signal has no exit code and is reported as "unknown", like the TS.
pub fn describe_failure(tool: Tool, result: &RunResult) -> String {
    if result.timed_out {
        return format!("{} timed out", tool.name());
    }

    match result.exit_code {
        Some(code) => format!("{} exited with code {code}", tool.name()),
        None => format!("{} exited with code unknown", tool.name()),
    }
}

/// The `exit code` text used inside step messages (`result.exitCode ?? 'unknown'`).
pub fn exit_code_text(result: &RunResult) -> String {
    result
        .exit_code
        .map_or_else(|| "unknown".to_string(), |c| c.to_string())
}

/// `throwIfAborted`/`exec` of the steps: a run that was aborted maps to a `cancelled` error;
/// anything else is returned to the caller, who decides what a non-zero exit or a timeout means.
pub fn check_not_aborted(step: JobState, result: &RunResult) -> Result<(), PipelineError> {
    if result.aborted {
        Err(cancelled_error(step))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(exit_code: Option<i32>, timed_out: bool) -> RunResult {
        RunResult {
            exit_code,
            signal: None,
            timed_out,
            aborted: false,
            stdout_text: None,
            stderr_tail: vec!["boom".into()],
        }
    }

    #[test]
    fn cancelled_error_has_the_ts_message() {
        let e = cancelled_error(JobState::Transcoding);

        assert!(is_cancelled(&e));
        assert_eq!(e.message, "The job was cancelled.");
        assert_eq!(e.step, JobState::Transcoding);
    }

    #[test]
    fn failed_carries_exit_code_and_stderr_tail() {
        let e = failed(JobState::Thumbnail, "nope", Some(&result(Some(3), false)));

        assert_eq!(e.kind, PipelineErrorKind::Failed);
        assert_eq!(e.exit_code, Some(3));
        assert_eq!(e.stderr_tail, vec!["boom".to_string()]);
        assert!(!is_cancelled(&e));

        let bare = failed(JobState::Thumbnail, "nope", None);

        assert_eq!(bare.exit_code, None);
        assert!(bare.stderr_tail.is_empty());
    }

    #[test]
    fn success_needs_exit_code_0_and_no_timeout() {
        assert!(succeeded(&result(Some(0), false)));
        assert!(!succeeded(&result(Some(1), false)));
        assert!(!succeeded(&result(Some(0), true)));
        assert!(!succeeded(&result(None, false)));
    }

    #[test]
    fn describes_failures_without_paths() {
        assert_eq!(
            describe_failure(Tool::Ffmpeg, &result(Some(1), true)),
            "ffmpeg timed out"
        );
        assert_eq!(
            describe_failure(Tool::Ffprobe, &result(Some(2), false)),
            "ffprobe exited with code 2"
        );
        assert_eq!(
            describe_failure(Tool::Ffmpeg, &result(None, false)),
            "ffmpeg exited with code unknown"
        );
        assert_eq!(exit_code_text(&result(None, false)), "unknown");
        assert_eq!(exit_code_text(&result(Some(9), false)), "9");
    }

    #[test]
    fn upload_interrupted_is_resumable_with_the_ts_message() {
        let e = upload_interrupted_error();

        assert_eq!(e.kind, PipelineErrorKind::UploadInterrupted);
        assert_eq!(e.kind.as_str(), "upload_interrupted");
        assert_eq!(e.step, JobState::Uploading);
        assert!(e.resumable);
        assert!(!e.definitive);
        assert_eq!(
            e.message,
            "Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online."
        );
    }

    #[test]
    fn a_new_error_has_the_ts_defaults() {
        let e = PipelineError::new(PipelineErrorKind::Failed, JobState::Waiting, "x");

        assert_eq!(e.exit_code, None);
        assert!(e.stderr_tail.is_empty());
        assert!(e.register_payload.is_none());
        assert_eq!(e.prefix, None);
        assert!(!e.definitive);
        assert_eq!(e.code, None);
        assert!(!e.resumable);
        assert_eq!(e.tmp_dir, None);
        assert_eq!(e.to_string(), "x");
        assert_eq!(RESUME_UNAVAILABLE, "resume_unavailable");

        for (kind, text) in [
            (PipelineErrorKind::Cancelled, "cancelled"),
            (PipelineErrorKind::Failed, "failed"),
            (PipelineErrorKind::RegisterFailed, "register_failed"),
            (PipelineErrorKind::NeedsSignIn, "needs_sign_in"),
        ] {
            assert_eq!(kind.as_str(), text);
        }
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn scrub_paths_replaces_the_longest_path_first() {
        let out = scrub_paths(
            &lines(&[
                "/home/bob/tmp/abc/segment.ts failed",
                "in /home/bob/tmp",
                "/home/bob/x",
            ]),
            &[
                ("/home/bob/tmp".to_string(), "<tmp-root>"),
                ("/home/bob/tmp/abc".to_string(), "<job-dir>"),
            ],
        );

        assert_eq!(
            out,
            lines(&[
                "<job-dir>/segment.ts failed",
                "in <tmp-root>",
                "/home/bob/x"
            ])
        );
    }

    #[test]
    fn scrub_paths_matches_both_slash_styles_and_ignores_tiny_paths() {
        let out = scrub_paths(
            &lines(&[
                "C:\\Users\\bob\\v.mp4: bad",
                "C:/Users/bob/v.mp4: bad",
                "a/b c",
            ]),
            &[
                ("C:\\Users\\bob\\v.mp4".to_string(), "<source>"),
                ("a/".to_string(), "<x>"),
            ],
        );

        assert_eq!(out, lines(&["<source>: bad", "<source>: bad", "a/b c"]));
        assert!(scrub_paths(&[], &[("abc".into(), "<x>")]).is_empty());
    }

    #[test]
    fn an_aborted_run_maps_to_cancelled() {
        let mut r = result(None, false);

        assert!(check_not_aborted(JobState::Storyboard, &r).is_ok());

        r.aborted = true;

        assert!(is_cancelled(
            &check_not_aborted(JobState::Storyboard, &r).unwrap_err()
        ));
    }
}
