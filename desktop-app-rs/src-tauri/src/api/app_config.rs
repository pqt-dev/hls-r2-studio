//! Response of `GET /api/app/config` (`AppConfig` in src/shared/appConfig.ts), its strict parser
//! and the R2 location rules. Port of `parseAppConfig` / `r2LocationProblem` in siteClient.ts.
//!
//! The config lives in RAM only and is never sent to the renderer. The R2 credentials are
//! `Secret`s: no `Serialize`, and `Debug` is redacted.

use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

use crate::secure::Secret;

#[derive(Clone, PartialEq)]
pub struct AppConfigR2 {
    pub access_key_id: Secret,
    pub secret_access_key: Secret,
    pub bucket: String,
    pub endpoint: String,
    pub url: String,
}

impl fmt::Debug for AppConfigR2 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppConfigR2")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &self.secret_access_key)
            .field("bucket", &"[REDACTED]")
            .field("endpoint", &"[REDACTED]")
            .field("url", &self.url)
            .finish()
    }
}

/// `'480' | '720' | '1080'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    P480,
    P720,
    P1080,
}

impl Resolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P480 => "480",
            Self::P720 => "720",
            Self::P1080 => "1080",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "480" => Some(Self::P480),
            "720" => Some(Self::P720),
            "1080" => Some(Self::P1080),
            _ => None,
        }
    }
}

impl Serialize for Resolution {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Field names stay snake_case, as in the TS type and the site's JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppConfigTranscode {
    pub resolution: Resolution,
    pub segment_seconds: f64,
    /// `None` keeps the source frame rate.
    pub fps: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppConfig {
    pub r2: AppConfigR2,
    pub transcode: AppConfigTranscode,
}

/// Safe view for IPC (`PublicConfig` in src/shared/ipc.ts): no credentials, no bucket.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub r2_configured: bool,
    pub transcode: Option<AppConfigTranscode>,
}

/// A non-empty string (`str()` in the TS parser).
fn non_empty(value: &Value) -> bool {
    matches!(value, Value::String(s) if !s.is_empty())
}

/// Moves a string out of the map (no copy), so the secret buffer ends up in the `Secret`.
fn take_string(map: &mut Map<String, Value>, key: &str) -> String {
    match map.remove(key) {
        Some(Value::String(s)) => s,
        _ => String::new(),
    }
}

/// `String(value)` of a JSON number, as JS would print it (720 and 720.0 both give "720").
fn number_text(value: &Value) -> Option<String> {
    let n = value.as_f64()?;

    if n.fract() == 0.0 && n.abs() < 1e15 {
        Some(format!("{}", n as i64))
    } else {
        Some(n.to_string())
    }
}

fn finite_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// Strictly validates the config body; `None` when anything is missing or mistyped.
/// Takes the body by value so the credential strings are moved, not copied.
pub fn parse_app_config(body: Value) -> Option<AppConfig> {
    let Value::Object(mut body) = body else {
        return None;
    };
    let Some(Value::Object(mut r2)) = body.remove("r2") else {
        return None;
    };
    let Some(Value::Object(transcode)) = body.remove("transcode") else {
        return None;
    };

    let keys = [
        "access_key_id",
        "secret_access_key",
        "bucket",
        "endpoint",
        "url",
    ];

    if !keys.iter().all(|k| r2.get(*k).is_some_and(non_empty)) {
        return None;
    }

    let resolution = match transcode.get("resolution") {
        Some(Value::String(s)) => Resolution::parse(s),
        Some(n @ Value::Number(_)) => number_text(n).as_deref().and_then(Resolution::parse),
        _ => None,
    }?;
    let segment_seconds = transcode
        .get("segment_seconds")
        .and_then(finite_number)
        .filter(|n| *n >= 1.0)?;
    let fps = match transcode.get("fps") {
        None | Some(Value::Null) => None,
        Some(value) => Some(finite_number(value).filter(|n| *n > 0.0)?),
    };

    Some(AppConfig {
        r2: AppConfigR2 {
            access_key_id: Secret::new(take_string(&mut r2, "access_key_id")),
            secret_access_key: Secret::new(take_string(&mut r2, "secret_access_key")),
            bucket: take_string(&mut r2, "bucket"),
            endpoint: take_string(&mut r2, "endpoint"),
            url: take_string(&mut r2, "url"),
        },
        transcode: AppConfigTranscode {
            resolution,
            segment_seconds,
            fps,
        },
    })
}

const LOCAL_R2_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

fn location_problem(raw: &str, label: &str, allow_insecure_localhost: bool) -> Option<String> {
    let Ok(url) = Url::parse(raw) else {
        return Some(format!(
            "The R2 {label} sent by the site is not a valid URL."
        ));
    };

    if !url.username().is_empty() || url.password().is_some() {
        return Some(format!(
            "The R2 {label} sent by the site must not contain credentials."
        ));
    }

    if url.scheme() == "https" {
        return None;
    }

    if url.scheme() == "http"
        && allow_insecure_localhost
        && url.host_str().is_some_and(|h| LOCAL_R2_HOSTS.contains(&h))
    {
        return None;
    }

    Some(format!(
        "The R2 {label} sent by the site must use https://."
    ))
}

/// The R2 credentials are sent to `endpoint`, so it must be https; the public `url` must be https
/// too. `allow_insecure_localhost` (tests only) also accepts http://localhost / 127.0.0.1.
/// `None` = fine.
pub fn r2_location_problem(r2: &AppConfigR2, allow_insecure_localhost: bool) -> Option<String> {
    if r2.bucket.trim().is_empty() {
        return Some("The site did not provide an R2 bucket name.".to_string());
    }

    location_problem(&r2.endpoint, "endpoint", allow_insecure_localhost)
        .or_else(|| location_problem(&r2.url, "public URL", allow_insecure_localhost))
}

#[cfg(test)]
pub mod testing {
    use serde_json::{json, Value};

    use super::*;

    pub fn config_body() -> Value {
        json!({
            "r2": {
                "access_key_id": "AKIA-SECRET-ID",
                "secret_access_key": "super-secret-value",
                "bucket": "bucket",
                "endpoint": "https://acct.r2.cloudflarestorage.com",
                "url": "https://cdn.example.com",
            },
            "transcode": { "resolution": "720", "segment_seconds": 6, "fps": 30 },
        })
    }

    pub fn config() -> AppConfig {
        parse_app_config(config_body()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::testing::{config, config_body};
    use super::*;

    #[test]
    fn parses_a_valid_body() {
        let c = config();

        assert_eq!(c.r2.secret_access_key.expose(), "super-secret-value");
        assert_eq!(c.r2.bucket, "bucket");
        assert_eq!(
            c.transcode,
            AppConfigTranscode {
                resolution: Resolution::P720,
                segment_seconds: 6.0,
                fps: Some(30.0)
            }
        );
    }

    #[test]
    fn accepts_a_numeric_resolution_and_a_missing_or_null_fps() {
        let mut body = config_body();
        body["transcode"] = json!({ "resolution": 1080, "segment_seconds": 2.5 });
        let c = parse_app_config(body).unwrap();
        assert_eq!(c.transcode.resolution, Resolution::P1080);
        assert_eq!(c.transcode.fps, None);

        let mut body = config_body();
        body["transcode"]["fps"] = Value::Null;
        assert_eq!(parse_app_config(body).unwrap().transcode.fps, None);
    }

    #[test]
    fn rejects_malformed_bodies() {
        let bad = |edit: &dyn Fn(&mut Value)| {
            let mut body = config_body();
            edit(&mut body);
            parse_app_config(body).is_none()
        };

        assert!(parse_app_config(json!({})).is_none());
        assert!(parse_app_config(json!([])).is_none());
        assert!(parse_app_config(json!({ "r2": {}, "transcode": {} })).is_none());
        assert!(bad(&|b| b["transcode"]["resolution"] = json!("999")));
        assert!(bad(&|b| b["transcode"]["resolution"] = json!(true)));
        assert!(bad(&|b| b["transcode"]["segment_seconds"] = json!(0.5)));
        assert!(bad(&|b| b["transcode"]["segment_seconds"] = json!("6")));
        assert!(bad(&|b| b["transcode"]["fps"] = json!(0)));
        assert!(bad(&|b| b["transcode"]["fps"] = json!("30")));
        assert!(bad(&|b| b["r2"]["bucket"] = json!("")));
        assert!(bad(&|b| b["r2"]["secret_access_key"] = json!(5)));
        assert!(bad(&|b| b["r2"] = json!("x")));
    }

    #[test]
    fn the_public_view_and_debug_output_never_contain_credentials() {
        let c = config();
        let public = PublicConfig {
            r2_configured: true,
            transcode: Some(c.transcode.clone()),
        };

        for text in [
            serde_json::to_string(&public).unwrap(),
            format!("{c:?}"),
            format!("{public:?}"),
        ] {
            assert!(!text.contains("super-secret-value"), "{text}");
            assert!(!text.contains("AKIA-SECRET-ID"), "{text}");
            assert!(!text.contains("cloudflarestorage"), "{text}");
        }

        assert_eq!(
            serde_json::to_value(&public).unwrap(),
            json!({ "r2Configured": true, "transcode": { "resolution": "720", "segment_seconds": 6.0, "fps": 30.0 } })
        );
    }

    fn r2_with(edit: impl FnOnce(&mut AppConfigR2)) -> AppConfigR2 {
        let mut r2 = config().r2;
        edit(&mut r2);
        r2
    }

    #[test]
    fn r2_location_rules() {
        let cases: [(&str, AppConfigR2); 6] = [
            (
                "http endpoint",
                r2_with(|r| r.endpoint = "http://acct.r2.cloudflarestorage.com".into()),
            ),
            (
                "http public url",
                r2_with(|r| r.url = "http://cdn.example.com".into()),
            ),
            (
                "http localhost when not allowed",
                r2_with(|r| r.endpoint = "http://localhost:9000".into()),
            ),
            (
                "endpoint with credentials",
                r2_with(|r| r.endpoint = "https://u:p@acct.example.com".into()),
            ),
            (
                "non-url endpoint",
                r2_with(|r| r.endpoint = "not a url".into()),
            ),
            ("blank bucket", r2_with(|r| r.bucket = "   ".into())),
        ];

        for (name, r2) in cases {
            assert!(r2_location_problem(&r2, false).is_some(), "{name}");
        }

        assert_eq!(r2_location_problem(&config().r2, false), None);
        assert_eq!(
            r2_location_problem(
                &r2_with(|r| r.endpoint = "http://acct.example.com".into()),
                false
            )
            .as_deref(),
            Some("The R2 endpoint sent by the site must use https://.")
        );

        let local = r2_with(|r| {
            r.endpoint = "http://127.0.0.1:9000".into();
            r.url = "http://localhost/x".into();
        });
        assert_eq!(r2_location_problem(&local, true), None);
        assert!(r2_location_problem(&local, false).is_some());
    }
}
