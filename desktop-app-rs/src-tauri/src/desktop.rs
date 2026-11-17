//! OS integration used by the IPC commands (port of desktop-app/src/main/security/external.ts
//! and the clipboard / shell parts of ipc/electronAdapters.ts). The renderer never reaches any
//! of this directly: it can only ask a command, which validates first.
//!
//! - Opening a URL or a file: Windows calls `ShellExecuteW` (the same API Electron's
//!   `shell.openExternal` / `openPath` use) on a short-lived COM thread; no shell, no command
//!   line is ever built from the URL. Other platforms (development on macOS) use
//!   `tauri_plugin_opener::open_url` / `open_path` as plain Rust functions (the plugin itself is
//!   NOT registered, so the webview gets no opener command or permission).
//! - Clipboard: written from Rust with `arboard` (text only); the webview has no clipboard API.

use std::path::Path;

use url::Url;

/// True when `embed_url` is https and served by the same host (and port) as the site.
pub fn is_embed_url_of_site(embed_url: &str, site_url: Option<&str>) -> bool {
    let Some(site_url) = site_url.filter(|s| !s.is_empty()) else {
        return false;
    };
    let (Ok(embed), Ok(site)) = (Url::parse(embed_url), Url::parse(site_url)) else {
        return false;
    };

    embed.scheme() == "https"
        && site.scheme() == "https"
        && embed.host_str().is_some()
        && embed.host_str() == site.host_str()
        && embed.port() == site.port()
}

/// The URL to hand to the OS when it is a plain https URL without credentials, else `None`
/// (`openExternalHttps`).
pub fn safe_https_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;

    (parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.host_str().is_some())
    .then(|| parsed.to_string())
}

/// Opens `url` in the default browser when `safe_https_url` accepts it. `Ok(false)` = refused.
pub fn open_external_https(
    url: &str,
    opener: impl FnOnce(&str) -> Result<(), String>,
) -> Result<bool, String> {
    match safe_https_url(url) {
        None => Ok(false),
        Some(safe) => opener(&safe).map(|()| true),
    }
}

/// Opens an already validated https URL with the system handler.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        shell_execute_open(std::ffi::OsStr::new(url))
    }

    #[cfg(not(windows))]
    {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
}

/// Opens a local file with the system viewer (`shell.openPath`).
pub fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        shell_execute_open(path.as_os_str())
    }

    #[cfg(not(windows))]
    {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
    }
}

/// `ShellExecuteW(NULL, "open", target, NULL, NULL, SW_SHOWNORMAL)` on its own thread with COM
/// initialized (as Microsoft recommends for ShellExecute).
#[cfg(windows)]
fn shell_execute_open(target: &std::ffi::OsStr) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = target.encode_wide().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();

    let opened = std::thread::spawn(move || {
        // SAFETY: plain Win32 calls with NUL-terminated UTF-16 buffers that outlive the calls.
        unsafe {
            let initialized = CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            );
            let result = ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );

            if initialized >= 0 {
                CoUninitialize();
            }

            // Values above 32 mean success.
            result as isize > 32
        }
    })
    .join()
    .unwrap_or(false);

    if opened {
        Ok(())
    } else {
        Err("ShellExecuteW failed".into())
    }
}

/// Writes text to the system clipboard.
pub fn write_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;

    clipboard
        .set_text(text.to_string())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn embed_urls_must_be_https_on_the_site_host_and_port() {
        let site = Some("https://a.com");

        assert!(is_embed_url_of_site("https://a.com/x", site));
        assert!(is_embed_url_of_site(
            "https://a.com:8443/x",
            Some("https://a.com:8443")
        ));
        assert!(!is_embed_url_of_site("https://a.com:8443/x", site));
        assert!(!is_embed_url_of_site("https://a.com.evil.com/x", site));
        // Accepted here, refused later by `safe_https_url` (credentials).
        assert!(is_embed_url_of_site("https://user@a.com/x", site));
        assert!(!is_embed_url_of_site("not a url", site));
        assert!(!is_embed_url_of_site(
            "https://a.com/x",
            Some("http://a.com")
        ));
        assert!(!is_embed_url_of_site("http://a.com/x", site));
        assert!(!is_embed_url_of_site("https://a.com/x", None));
        assert!(!is_embed_url_of_site("https://a.com/x", Some("")));
        assert!(is_embed_url_of_site("https://A.COM/x", site));
    }

    #[test]
    fn only_plain_https_urls_reach_the_opener() {
        let opened = RefCell::new(Vec::new());
        let opener = |url: &str| {
            opened.borrow_mut().push(url.to_string());
            Ok(())
        };

        assert_eq!(
            open_external_https("https://a.com/embed/x?y=1", opener),
            Ok(true)
        );

        for bad in [
            "http://a.com/",
            "javascript:alert(1)",
            "file:///C:/Windows/system32/calc.exe",
            "https://user:pw@a.com/",
            "https://user@a.com/",
            "ms-settings:",
            "not a url",
        ] {
            assert_eq!(open_external_https(bad, |_| Ok(())), Ok(false), "{bad}");
        }

        assert_eq!(*opened.borrow(), ["https://a.com/embed/x?y=1"]);
        assert_eq!(
            open_external_https("https://a.com/", |_| Err("no handler".into())),
            Err("no handler".into())
        );
    }
}
