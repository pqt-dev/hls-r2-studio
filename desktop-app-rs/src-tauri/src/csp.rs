//! Runtime part of the CSP: `frame-src` for the signed-in site only.
//!
//! The site origin is fixed at build time (`HLS_SITE_URL`, read with `option_env!`), but
//! `tauri.conf.json` is static JSON, so it carries `frame-src 'none'`. At startup (before the
//! window exists) `allow_site_frames` replaces that directive with `frame-src <site origin>` in
//! the config Tauri serves the CSP header from. Nothing else changes, and a build without a
//! valid https site URL keeps `frame-src 'none'`.

use crate::settings::BUILT_IN_SITE_URL;
use crate::site_url;

/// `policy` with its `frame-src` directive replaced by one that allows exactly `site_origin`.
/// The origin is normalized first and must be a plain `https://host[:port]`; anything else
/// leaves the policy unchanged (so frames stay blocked).
pub fn with_site_frame_src(policy: &str, site_origin: &str) -> String {
    let Ok(origin) = site_url::normalize(site_origin) else {
        return policy.to_string();
    };

    // Defence in depth: only characters of a plain origin can end up inside the policy.
    if !origin
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'/'))
    {
        return policy.to_string();
    }

    let mut directives: Vec<&str> = policy
        .split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty() && !directive.starts_with("frame-src"))
        .collect();
    let frame = format!("frame-src {origin}");

    directives.push(&frame);

    directives.join("; ")
}

/// Applies the built-in site origin to the production and dev CSP of the Tauri config.
pub fn allow_site_frames(config: &mut tauri::utils::config::Config) {
    let Some(site) = BUILT_IN_SITE_URL.filter(|site| !site.trim().is_empty()) else {
        return;
    };
    let security = &mut config.app.security;

    for csp in [&mut security.csp, &mut security.dev_csp] {
        if let Some(tauri::utils::config::Csp::Policy(policy)) = csp {
            *policy = with_site_frame_src(policy, site);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf_csp() -> String {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

        conf["app"]["security"]["csp"].as_str().unwrap().to_string()
    }

    #[test]
    fn replaces_frame_src_with_the_site_origin_only() {
        let csp = with_site_frame_src(&conf_csp(), "https://Admin.Example.com/some/path?q=1");

        assert!(csp.ends_with("; frame-src https://admin.example.com"));
        assert_eq!(csp.matches("frame-src").count(), 1);
        assert!(!csp.contains("frame-src 'none'"));
        assert!(!csp.contains("frame-src https: ") && !csp.ends_with("frame-src https:"));
        assert!(!csp.contains('*'));
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("img-src 'self' data: https:"));
    }

    #[test]
    fn keeps_the_port_of_the_site() {
        assert!(
            with_site_frame_src(&conf_csp(), "https://site.example.com:8443")
                .ends_with("frame-src https://site.example.com:8443")
        );
    }

    #[test]
    fn an_invalid_or_unsafe_origin_keeps_frames_blocked() {
        let csp = conf_csp();

        for bad in [
            "",
            "http://site.example.com",
            "https://user@site.example.com",
            "https://a.example.com; script-src *",
            "https://a.example.com;b",
            "https://*.example.com",
            "https:",
        ] {
            assert_eq!(with_site_frame_src(&csp, bad), csp, "{bad}");
        }
        assert!(csp.contains("frame-src 'none'"));
    }
}
