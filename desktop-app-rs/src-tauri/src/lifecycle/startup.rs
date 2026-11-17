//! Fatal startup errors (port of desktop-app/src/main/lifecycle/startupFailure.ts): log (the
//! logger redacts), show a native error dialog with a fixed English text (never the error
//! itself) and exit with a non-zero code, so no hidden process keeps the single-instance lock.

use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::json;

use crate::logger::Log;

pub const STARTUP_ERROR_TITLE: &str = "HLS R2 Studio could not start";
pub const STARTUP_ERROR_MESSAGE: &str = "An unexpected error stopped the app from starting. Details were written to the log file. Please start the app again; if this keeps happening, contact support.";
pub const STARTUP_EXIT_CODE: i32 = 1;

/// Never panics: a failing logger or dialog cannot stop the exit.
pub fn handle_startup_failure(
    error: &str,
    logger: Option<&dyn Log>,
    show_error: impl FnOnce(&str, &str),
    quit: impl FnOnce(),
) {
    if let Some(logger) = logger {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            logger.error("Startup failed", Some(json!({ "error": error })));
        }));
    }

    let _ = catch_unwind(AssertUnwindSafe(|| {
        show_error(STARTUP_ERROR_TITLE, STARTUP_ERROR_MESSAGE)
    }));

    quit();
}

/// The native error box (rfd on Windows/macOS, stderr elsewhere). Runs on the main thread.
pub fn show_native_error(title: &str, message: &str) {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let _ = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(title)
            .set_description(message)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    eprintln!("{title}: {message}");
}

/// A short description of a caught panic payload (for the log only).
pub fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::logger::testing::RecordingLogger;
    use crate::logger::LogLevel;

    #[test]
    fn logs_shows_an_english_dialog_without_the_error_text_and_quits() {
        let logger = RecordingLogger::default();
        let shown = RefCell::new(Vec::new());
        let quits = RefCell::new(0);

        handle_startup_failure(
            "Cannot read properties of undefined (reading jobs)",
            Some(&logger),
            |title, content| {
                shown
                    .borrow_mut()
                    .push((title.to_string(), content.to_string()))
            },
            || *quits.borrow_mut() += 1,
        );

        let entries = logger.entries.lock().unwrap();
        assert_eq!(entries[0].0, LogLevel::Error);
        assert_eq!(entries[0].1, "Startup failed");
        let shown = shown.borrow();
        assert_eq!(shown[0].0, STARTUP_ERROR_TITLE);
        assert!(!shown[0].1.contains("jobs"));
        assert_eq!(*quits.borrow(), 1);
    }

    struct PanickingLogger;

    impl Log for PanickingLogger {
        fn log(&self, _: LogLevel, _: &str, _: Option<serde_json::Value>) {
            panic!("log failed");
        }
    }

    #[test]
    fn still_quits_when_there_is_no_logger_or_the_dialog_and_logger_panic() {
        let quits = RefCell::new(0);

        handle_startup_failure(
            "x",
            Some(&PanickingLogger),
            |_, _| panic!("no dialog"),
            || *quits.borrow_mut() += 1,
        );
        handle_startup_failure("x", None, |_, _| (), || *quits.borrow_mut() += 1);

        assert_eq!(*quits.borrow(), 2);
    }

    #[test]
    fn panic_payloads_become_text() {
        let caught = std::panic::catch_unwind(|| panic!("boom {}", 1)).unwrap_err();
        assert_eq!(panic_text(&*caught), "boom 1");
        let caught = std::panic::catch_unwind(|| std::panic::panic_any(5u8)).unwrap_err();
        assert_eq!(panic_text(&*caught), "panic");
    }
}
