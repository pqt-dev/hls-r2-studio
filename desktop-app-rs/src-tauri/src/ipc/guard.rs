//! Sender guard (port of desktop-app/src/main/ipc/senderGuard.ts): an invoke is accepted only
//! when it comes from the app's main window showing the app's own page. Applied to EVERY app
//! command by the handler in `ipc/mod.rs`, before any command code runs.
//!
//! Checks:
//! - the window and the webview are both the main window (`main`);
//! - the webview's current URL is the app (`window::is_app_url`; the Vite dev server only in
//!   debug builds);
//! - when the request carries an `Origin` header (Tauri's custom-protocol IPC always does), that
//!   origin is the app too, so a frame from another origin inside the page is refused.
//!
//! Tauri itself already rejects calls from remote origins for app commands and checks the
//! per-launch invoke key; this guard is the app-level equivalent of the Electron sender check.

use tauri::ipc::Invoke;
use tauri::{Manager, Runtime};
use url::Url;

use crate::logger::Log;
use crate::state::AppState;
use crate::window::{is_app_url, MAIN_WINDOW_LABEL};

/// Rejection value seen by the renderer (same text as the Electron app).
pub const FORBIDDEN: &str = "Forbidden";

/// Pure decision, so it can be tested without a webview.
pub fn is_trusted_sender(
    window_label: &str,
    webview_label: &str,
    webview_url: Option<&Url>,
    origin_header: Option<&str>,
    allow_dev_server: bool,
) -> bool {
    if window_label != MAIN_WINDOW_LABEL || webview_label != MAIN_WINDOW_LABEL {
        return false;
    }

    let Some(url) = webview_url else {
        return false;
    };

    if !is_app_url(url, allow_dev_server) {
        return false;
    }

    match origin_header {
        None => true,
        Some(origin) => Url::parse(origin).is_ok_and(|o| is_app_url(&o, allow_dev_server)),
    }
}

/// Applies the guard to a raw invoke.
pub fn is_trusted_invoke<R: Runtime>(invoke: &Invoke<R>) -> bool {
    let webview = invoke.message.webview_ref();
    let window = webview.window();
    let url = webview.url().ok();
    let headers = invoke.message.headers();
    let origin = match headers.get("origin") {
        None => None,
        // A header that is not text can never be the app's origin.
        Some(value) => match value.to_str() {
            Ok(text) => Some(text),
            Err(_) => return false,
        },
    };

    is_trusted_sender(
        window.label(),
        webview.label(),
        url.as_ref(),
        origin,
        cfg!(debug_assertions),
    )
}

/// Logs and rejects an invoke that failed the guard.
pub fn reject_untrusted<R: Runtime>(invoke: Invoke<R>) {
    if let Some(state) = invoke.message.webview_ref().try_state::<AppState>() {
        state.logger.warn(
            "Rejected IPC call from untrusted sender",
            Some(serde_json::json!({ "channel": invoke.message.command() })),
        );
    }

    invoke.resolver.reject(FORBIDDEN);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn trusted(window: &str, webview: &str, page: &str, origin: Option<&str>, dev: bool) -> bool {
        is_trusted_sender(window, webview, Some(&url(page)), origin, dev)
    }

    #[test]
    fn accepts_only_the_main_window_showing_the_app_page() {
        assert!(trusted(
            "main",
            "main",
            "tauri://localhost/",
            Some("tauri://localhost"),
            false
        ));
        assert!(trusted(
            "main",
            "main",
            "http://tauri.localhost/",
            Some("http://tauri.localhost"),
            false
        ));
        assert!(trusted(
            "main",
            "main",
            "tauri://localhost/index.html",
            None,
            false
        ));
        assert!(trusted(
            "main",
            "main",
            "http://localhost:5173/",
            Some("http://localhost:5173"),
            true
        ));
    }

    #[test]
    fn rejects_other_windows_and_webviews() {
        assert!(!trusted("other", "main", "tauri://localhost/", None, false));
        assert!(!trusted("main", "other", "tauri://localhost/", None, false));
    }

    #[test]
    fn rejects_foreign_pages_and_foreign_frames() {
        assert!(!trusted(
            "main",
            "main",
            "https://evil.example.com/",
            None,
            false
        ));
        assert!(!trusted(
            "main",
            "main",
            "tauri://localhost/",
            Some("https://evil.example.com"),
            false
        ));
        assert!(!trusted(
            "main",
            "main",
            "tauri://localhost/",
            Some("null"),
            false
        ));
        assert!(!trusted(
            "main",
            "main",
            "tauri://localhost/",
            Some(""),
            false
        ));
    }

    #[test]
    fn the_dev_server_is_trusted_only_in_debug_builds() {
        assert!(!trusted(
            "main",
            "main",
            "http://localhost:5173/",
            None,
            false
        ));
        assert!(!trusted(
            "main",
            "main",
            "tauri://localhost/",
            Some("http://localhost:5173"),
            false
        ));
    }

    #[test]
    fn rejects_a_webview_without_a_url() {
        assert!(!is_trusted_sender("main", "main", None, None, false));
    }
}
