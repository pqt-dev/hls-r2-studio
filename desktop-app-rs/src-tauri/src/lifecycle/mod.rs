//! App lifecycle (port of desktop-app/src/main/lifecycle): the close/quit confirmation flow and
//! the fatal startup error path.

pub mod app_deps;
pub mod quit;
pub mod startup;

pub use app_deps::TauriQuitDeps;
pub use quit::{
    QuitCoordinator, QuitDeps, KEEP_WORKING_BUTTON, QUIT_BUTTON, QUIT_DIALOG_MESSAGE,
    QUIT_DIALOG_TITLE,
};
pub use startup::{
    handle_startup_failure, panic_text, show_native_error, STARTUP_ERROR_MESSAGE,
    STARTUP_ERROR_TITLE, STARTUP_EXIT_CODE,
};
