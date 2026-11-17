//! Main window: 1100x720 (min 760x520), hidden until the page has loaded, locked to the app URL,
//! and never opens new windows.

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const WINDOW_TITLE: &str = "HLS R2 Studio";

/// Origin of the Vite dev server (see `build.devUrl` in tauri.conf.json); only allowed in debug.
const DEV_SERVER_HOST: &str = "localhost";
const DEV_SERVER_PORT: u16 = 5173;

/// True when `url` is the app itself: the bundled frontend (`tauri://localhost`, or
/// `http(s)://tauri.localhost` on Windows/Android) or, in debug builds only, the Vite dev server.
pub fn is_app_url(url: &Url, allow_dev_server: bool) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some(DEV_SERVER_HOST)) => allow_dev_server && url.port() == Some(DEV_SERVER_PORT),
        _ => false,
    }
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let allow_dev_server = cfg!(debug_assertions);

    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
        .title(WINDOW_TITLE)
        .inner_size(1100.0, 720.0)
        .min_inner_size(760.0, 520.0)
        // Equivalent of Electron's `show: false` + `ready-to-show`.
        .visible(false)
        .on_navigation(move |url| {
            let allowed = is_app_url(url, allow_dev_server);

            if !allowed {
                eprintln!(
                    "Blocked navigation to {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                );
            }

            allowed
        })
        // Never open new windows (window.open, target=_blank).
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(window) = webview.app_handle().get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.show();
                }
            }
        })
        .build()?;

    let _ = window;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, dev: bool) -> bool {
        is_app_url(&Url::parse(url).unwrap(), dev)
    }

    #[test]
    fn allows_the_bundled_app() {
        assert!(allowed("tauri://localhost/index.html", false));
        assert!(allowed("http://tauri.localhost/", false));
        assert!(allowed("https://tauri.localhost/", false));
    }

    #[test]
    fn dev_server_only_in_debug() {
        assert!(allowed("http://localhost:5173/", true));
        assert!(!allowed("http://localhost:5173/", false));
        assert!(!allowed("http://localhost:8080/", true));
    }

    #[test]
    fn blocks_everything_else() {
        for url in [
            "https://example.com/",
            "http://example.com/",
            "file:///etc/passwd",
            "tauri://evil/",
            "https://tauri.localhost.evil.com/",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(url, true), "{url}");
        }
    }
}
