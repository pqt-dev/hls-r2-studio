//! Main window: 1100x720 (min 760x520), hidden until the page has loaded, locked to the app URL
//! (plus `/embed/` pages of the built-in site, for the preview iframe), and never opens new windows.

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::settings::{built_in_site_url, BUILT_IN_SITE_URL};
use crate::site_url;

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

/// True when `url` is an embed page of the built-in site: `https`, exactly the site's host and
/// port (default port 443 equals no port), no credentials, and a path under `/embed/`.
/// `site_origin` is the built-in site URL; `None` (or an invalid one) allows nothing.
pub fn is_site_embed_url(url: &Url, site_origin: Option<&str>) -> bool {
    let Some(site) = site_origin
        .and_then(|origin| site_url::normalize(origin).ok())
        .and_then(|origin| Url::parse(&origin).ok())
    else {
        return false;
    };

    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            site.host_str()
                .is_some_and(|site_host| host.eq_ignore_ascii_case(site_host))
        })
        && url.port() == site.port()
        && url.path().starts_with("/embed/")
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let allow_dev_server = cfg!(debug_assertions);
    let site_origin = Some(built_in_site_url(BUILT_IN_SITE_URL)).filter(|url| !url.is_empty());

    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
        .title(WINDOW_TITLE)
        .inner_size(1100.0, 720.0)
        .min_inner_size(760.0, 520.0)
        // Equivalent of Electron's `show: false` + `ready-to-show`.
        .visible(false)
        .on_navigation(move |url| {
            let allowed =
                is_app_url(url, allow_dev_server) || is_site_embed_url(url, site_origin.as_deref());

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

    fn embed(url: &str, site: Option<&str>) -> bool {
        is_site_embed_url(&Url::parse(url).unwrap(), site)
    }

    const SITE: Option<&str> = Some("https://playervl.online");

    #[test]
    fn allows_embed_pages_of_the_site() {
        for url in [
            "https://playervl.online/embed/abcdefghij12",
            "https://playervl.online/embed/abcdefghij12?t=5&x=1#frag",
            "https://playervl.online/embed/abcdefghij12/",
            "https://PLAYERVL.Online/embed/abcdefghij12",
            "https://playervl.online:443/embed/abcdefghij12",
        ] {
            assert!(embed(url, SITE), "{url}");
        }
        assert!(embed(
            "https://playervl.online/embed/x",
            Some("https://playervl.online:443/")
        ));
        assert!(embed(
            "https://www.playervl.online/embed/x",
            Some("https://www.playervl.online")
        ));
        assert!(embed(
            "https://playervl.online:8443/embed/x",
            Some("https://playervl.online:8443")
        ));
    }

    #[test]
    fn blocks_other_hosts_schemes_ports_and_credentials() {
        for url in [
            "https://evil.com/embed/x",
            "https://playervl.online.evil.com/embed/x",
            "https://xplayervl.online/embed/x",
            "https://www.playervl.online/embed/x",
            "http://playervl.online/embed/x",
            "https://user:pw@playervl.online/embed/x",
            "https://user@playervl.online/embed/x",
            "https://playervl.online@evil.com/embed/x",
            "https://playervl.online:8443/embed/x",
        ] {
            assert!(!embed(url, SITE), "{url}");
        }
        assert!(!embed(
            "https://playervl.online/embed/x",
            Some("https://playervl.online:8443")
        ));
    }

    #[test]
    fn blocks_non_embed_paths() {
        for url in [
            "https://playervl.online/",
            "https://playervl.online/embed",
            "https://playervl.online/embedded/x",
            "https://playervl.online/admin",
            "https://playervl.online/login",
            "https://playervl.online/api/app/videos",
            "https://playervl.online//embed/x",
            "https://playervl.online/x/embed/y",
            "https://playervl.online/embed/../admin",
            "https://playervl.online/embed/%2e%2e/admin",
        ] {
            assert!(!embed(url, SITE), "{url}");
        }
    }

    #[test]
    fn blocks_non_http_schemes() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///embed/x",
            "tauri://playervl.online/embed/x",
        ] {
            assert!(!embed(url, SITE), "{url}");
        }
    }

    #[test]
    fn no_site_allows_nothing() {
        assert!(!embed("https://playervl.online/embed/x", None));
        assert!(!embed("https://playervl.online/embed/x", Some("")));
        assert!(!embed(
            "https://playervl.online/embed/x",
            Some("http://playervl.online")
        ));
    }
}
