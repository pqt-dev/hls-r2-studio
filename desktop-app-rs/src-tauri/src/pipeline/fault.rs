//! Anything a pipeline run can fail with before it is mapped to a [`PipelineError`] (the TS
//! `catch (error: unknown)` + `classify()` of runPipeline.ts).

use std::io;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::dto::JobState;
use crate::ffmpeg::errors::{cancelled_error, PipelineError, PipelineErrorKind};
use crate::logger::Log;

#[derive(Debug)]
pub enum Fault {
    /// Already typed (steps, upload, register).
    Pipeline(PipelineError),
    /// A filesystem error (mapped to a safe message by its kind).
    Io(io::Error),
    /// Anything else (client setup, a refused temp folder, ...). Logged, never shown.
    Other(String),
}

impl From<PipelineError> for Fault {
    fn from(error: PipelineError) -> Self {
        Self::Pipeline(error)
    }
}

impl From<io::Error> for Fault {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pipeline(error) => write!(f, "{error}"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// `ENOSPC` (Unix) / `ERROR_DISK_FULL`, `ERROR_HANDLE_DISK_FULL` (Windows).
fn is_disk_full(error: &io::Error) -> bool {
    let code = error.raw_os_error();

    if cfg!(windows) {
        matches!(code, Some(112 | 39))
    } else {
        code == Some(28)
    }
}

/// The TS `safeMessage`: a short English text without paths.
pub fn safe_message(fault: &Fault) -> &'static str {
    let Fault::Io(error) = fault else {
        return "An unexpected error occurred.";
    };

    if is_disk_full(error) {
        return "The disk is full.";
    }

    match error.kind() {
        io::ErrorKind::NotFound => "A required file was not found.",
        io::ErrorKind::PermissionDenied => "Permission denied while accessing files.",
        _ => "An unexpected error occurred.",
    }
}

/// Maps any fault to a [`PipelineError`] with a safe message. A cancelled job always ends as
/// `cancelled`, except for the kinds that must keep their meaning (`register_failed`,
/// `needs_sign_in`: the site may already have the video).
pub fn classify(
    fault: Fault,
    step: JobState,
    cancel: &CancellationToken,
    logger: &dyn Log,
) -> PipelineError {
    if let Fault::Pipeline(error) = fault {
        let keeps_kind = matches!(
            error.kind,
            PipelineErrorKind::RegisterFailed | PipelineErrorKind::NeedsSignIn
        );

        if cancel.is_cancelled() && !keeps_kind && error.kind != PipelineErrorKind::Cancelled {
            return cancelled_error(error.step);
        }

        return error;
    }

    if cancel.is_cancelled() {
        return cancelled_error(step);
    }

    logger.error(
        "Pipeline step failed unexpectedly.",
        Some(json!({ "step": step, "error": fault.to_string() })),
    );

    PipelineError::new(PipelineErrorKind::Failed, step, safe_message(&fault)).with_cause(&fault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::errors::{is_cancelled, upload_interrupted_error};
    use crate::logger::testing::RecordingLogger;

    fn io(kind: io::ErrorKind) -> Fault {
        Fault::Io(io::Error::from(kind))
    }

    #[test]
    fn safe_messages_never_contain_paths() {
        assert_eq!(
            safe_message(&io(io::ErrorKind::NotFound)),
            "A required file was not found."
        );
        assert_eq!(
            safe_message(&io(io::ErrorKind::PermissionDenied)),
            "Permission denied while accessing files."
        );
        assert_eq!(
            safe_message(&Fault::Io(io::Error::from_raw_os_error(if cfg!(windows) {
                112
            } else {
                28
            }))),
            "The disk is full."
        );
        assert_eq!(
            safe_message(&Fault::Other("C:\\Users\\bob\\secret".into())),
            "An unexpected error occurred."
        );
    }

    #[test]
    fn classify_keeps_typed_errors_and_logs_the_rest() {
        let logger = RecordingLogger::default();
        let token = CancellationToken::new();
        let typed = classify(
            Fault::Pipeline(upload_interrupted_error()),
            JobState::Transcoding,
            &token,
            &logger,
        );

        assert_eq!(typed.kind, PipelineErrorKind::UploadInterrupted);

        let other = classify(
            io(io::ErrorKind::NotFound),
            JobState::Thumbnail,
            &token,
            &logger,
        );

        assert_eq!(other.kind, PipelineErrorKind::Failed);
        assert_eq!(other.step, JobState::Thumbnail);
        assert_eq!(other.message, "A required file was not found.");
        assert!(logger.text().contains("failed unexpectedly"));
    }

    #[test]
    fn a_cancelled_job_is_cancelled_unless_register_may_have_happened() {
        let logger = RecordingLogger::default();
        let token = CancellationToken::new();

        token.cancel();

        assert!(is_cancelled(&classify(
            Fault::Pipeline(upload_interrupted_error()),
            JobState::Uploading,
            &token,
            &logger
        )));
        assert!(is_cancelled(&classify(
            Fault::Other("x".into()),
            JobState::Uploading,
            &token,
            &logger
        )));

        for kind in [
            PipelineErrorKind::RegisterFailed,
            PipelineErrorKind::NeedsSignIn,
        ] {
            let error = PipelineError::new(kind, JobState::Registering, "m");

            assert_eq!(
                classify(
                    Fault::Pipeline(error),
                    JobState::Registering,
                    &token,
                    &logger
                )
                .kind,
                kind
            );
        }
    }
}
