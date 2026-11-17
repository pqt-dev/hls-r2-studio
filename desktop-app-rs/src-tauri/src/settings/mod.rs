//! Persisted user settings (temp folder, parallel jobs; the site URL is read-only).

mod path_rules;
mod service;

pub use path_rules::{
    classify_tmp_root, is_absolute_native, normalize, normalize_posix, normalize_win32,
    TmpRootProblem,
};
pub use service::{
    ensure_dir_writable, store_has_paused_uploads, SettingsPatch, SettingsService,
    SettingsServiceOptions, MAX_CONCURRENT, MIN_CONCURRENT,
};

use crate::site_url;

/// Compile-time `HLS_SITE_URL` (set when building the release app); `None` otherwise.
pub const BUILT_IN_SITE_URL: Option<&str> = option_env!("HLS_SITE_URL");

/// The built-in site origin, or an empty string when this build has none (or it is invalid).
pub fn built_in_site_url(raw: Option<&str>) -> String {
    raw.and_then(|value| site_url::normalize(value).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_site_url_is_normalized_or_empty() {
        assert_eq!(built_in_site_url(None), "");
        assert_eq!(built_in_site_url(Some("http://a.example")), "");
        assert_eq!(
            built_in_site_url(Some("https://A.example/x")),
            "https://a.example"
        );
        assert_eq!(
            built_in_site_url(Some("https://a.example:443")),
            built_in_site_url(Some("https://a.example"))
        );
    }
}
