//! R2 storage settings of the site (`/api/app/r2`): types and parsing.
//!
//! The site never returns the access key id or the secret: only the last four characters of the
//! key and a `has_secret` flag. The values typed by the user (`R2Input`) are wrapped in
//! zeroizing `Secret`s, are never logged and never appear in an error message.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::error::SiteApiError;
use crate::secure::Secret;

pub const MAX_ENDPOINT_CHARS: usize = 2048;
pub const MAX_PUBLIC_URL_CHARS: usize = 2048;
pub const MAX_BUCKET_CHARS: usize = 255;
pub const MAX_KEY_CHARS: usize = 1024;
/// Longest text taken from the site (a connection test error); longer text is cut.
const MAX_SITE_TEXT_CHARS: usize = 300;
const MAX_LAST4_CHARS: usize = 8;

/// Field names the renderer sees (camelCase) in `field_errors`.
pub const FIELD_ENDPOINT: &str = "endpoint";
pub const FIELD_BUCKET: &str = "bucket";
pub const FIELD_URL: &str = "url";
pub const FIELD_ACCESS_KEY_ID: &str = "accessKeyId";
pub const FIELD_SECRET_ACCESS_KEY: &str = "secretAccessKey";

const FIELD_NAMES: [(&str, &str); 5] = [
    ("endpoint", FIELD_ENDPOINT),
    ("bucket", FIELD_BUCKET),
    ("url", FIELD_URL),
    ("access_key_id", FIELD_ACCESS_KEY_ID),
    ("secret_access_key", FIELD_SECRET_ACCESS_KEY),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum R2Source {
    Database,
    None,
}

/// What the site reports about its R2 configuration (no secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Status {
    pub configured: bool,
    pub source: R2Source,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub url: Option<String>,
    pub access_key_last4: Option<String>,
    pub has_secret: bool,
}

/// The values to save. `access_key_id` / `secret_access_key` are `None` = keep the stored value.
#[derive(Debug)]
pub struct R2Input {
    pub endpoint: String,
    pub bucket: String,
    pub url: String,
    pub access_key_id: Option<Secret>,
    pub secret_access_key: Option<Secret>,
}

/// Result of `POST /api/app/r2/test`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct R2TestOutcome {
    pub ok: bool,
    /// Safe, length-capped text; only set when `ok` is false.
    pub error: Option<String>,
}

/// A failed save: a safe error, plus the per-field messages of a 422.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct R2SaveError {
    pub error: SiteApiError,
    pub field_errors: BTreeMap<String, String>,
}

impl From<SiteApiError> for R2SaveError {
    fn from(error: SiteApiError) -> Self {
        Self {
            error,
            field_errors: BTreeMap::new(),
        }
    }
}

/// Removes control characters, trims and cuts to `max` characters. `None` when nothing is left.
fn clean_text(text: &str, max: usize) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn optional_text(body: &Value, key: &str, max: usize) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .and_then(|text| clean_text(text, max))
}

/// Parses `{ configured, source, endpoint, bucket, url, access_key_last4, has_secret }`.
/// `None` when `configured` / `source` are missing; an unknown `source` maps to `R2Source::None`.
pub fn parse_r2_status(body: &Value) -> Option<R2Status> {
    let configured = body.get("configured")?.as_bool()?;
    // Any value other than "database" (e.g. "env" from an older site) is shown as "none".
    let source = match body.get("source")?.as_str()? {
        "database" => R2Source::Database,
        _ => R2Source::None,
    };

    Some(R2Status {
        configured,
        source,
        endpoint: optional_text(body, "endpoint", MAX_ENDPOINT_CHARS),
        bucket: optional_text(body, "bucket", MAX_BUCKET_CHARS),
        url: optional_text(body, "url", MAX_PUBLIC_URL_CHARS),
        access_key_last4: optional_text(body, "access_key_last4", MAX_LAST4_CHARS),
        has_secret: body
            .get("has_secret")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Parses `{ ok: true } | { ok: false, error? }`.
pub fn parse_r2_test(body: &Value) -> Option<R2TestOutcome> {
    let ok = body.get("ok")?.as_bool()?;

    if ok {
        return Some(R2TestOutcome {
            ok: true,
            error: None,
        });
    }

    Some(R2TestOutcome {
        ok: false,
        error: Some(
            optional_text(body, "error", MAX_SITE_TEXT_CHARS)
                .unwrap_or_else(|| "The connection test failed.".to_string()),
        ),
    })
}

/// First message per known field of a Laravel 422 body (`errors: { field: [messages] }`).
/// A message that contains one of the submitted `secrets` is replaced by a generic one, so a
/// server that echoed a value can never put it on screen.
pub fn parse_field_errors(body: &Value, secrets: &[&str]) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Some(errors) = body.get("errors").and_then(Value::as_object) else {
        return fields;
    };

    for (site_name, name) in FIELD_NAMES {
        let first = errors
            .get(site_name)
            .and_then(|messages| messages.as_array())
            .and_then(|messages| messages.first())
            .and_then(Value::as_str)
            .and_then(|text| clean_text(text, MAX_SITE_TEXT_CHARS));
        let Some(message) = first else { continue };
        let leaks = secrets
            .iter()
            .any(|secret| secret.len() >= 4 && message.contains(secret));

        fields.insert(
            name.to_string(),
            if leaks {
                "This value was rejected by the site.".to_string()
            } else {
                message
            },
        );
    }

    fields
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_a_full_status_and_serializes_camel_case() {
        let status = parse_r2_status(&json!({
            "configured": true,
            "source": "database",
            "endpoint": "https://acct.r2.cloudflarestorage.com",
            "bucket": "media",
            "url": "https://cdn.example.com",
            "access_key_last4": "abcd",
            "has_secret": true,
            "secret_access_key": "must-be-ignored"
        }))
        .unwrap();

        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "configured": true,
                "source": "database",
                "endpoint": "https://acct.r2.cloudflarestorage.com",
                "bucket": "media",
                "url": "https://cdn.example.com",
                "accessKeyLast4": "abcd",
                "hasSecret": true
            })
        );
    }

    #[test]
    fn parses_an_unconfigured_status_with_nulls() {
        let status = parse_r2_status(&json!({
            "configured": false, "source": "none", "endpoint": null, "bucket": null,
            "url": null, "access_key_last4": null, "has_secret": false
        }))
        .unwrap();

        assert_eq!(status.source, R2Source::None);
        assert!(!status.configured && !status.has_secret);
        assert!(status.endpoint.is_none() && status.access_key_last4.is_none());
    }

    #[test]
    fn rejects_unknown_shapes() {
        assert!(parse_r2_status(&json!({ "source": "env" })).is_none());
        assert!(parse_r2_status(&json!({ "configured": true })).is_none());
        assert!(parse_r2_status(&json!("x")).is_none());
    }

    #[test]
    fn unknown_source_from_an_older_site_is_treated_as_none() {
        let status = parse_r2_status(&json!({ "configured": true, "source": "env" })).unwrap();

        assert_eq!(status.source, R2Source::None);
        assert!(status.configured);
    }

    #[test]
    fn status_text_is_cleaned_and_capped() {
        let long = "a".repeat(5000);
        let status = parse_r2_status(&json!({
            "configured": true, "source": "database", "bucket": "b\u{0}ucket",
            "endpoint": long, "access_key_last4": "123456789012"
        }))
        .unwrap();

        assert_eq!(status.bucket.as_deref(), Some("bucket"));
        assert_eq!(status.endpoint.unwrap().chars().count(), MAX_ENDPOINT_CHARS);
        assert_eq!(
            status.access_key_last4.unwrap().chars().count(),
            MAX_LAST4_CHARS
        );
    }

    #[test]
    fn parses_test_outcomes() {
        assert_eq!(
            parse_r2_test(&json!({ "ok": true })),
            Some(R2TestOutcome {
                ok: true,
                error: None
            })
        );
        assert_eq!(
            parse_r2_test(&json!({ "ok": false, "error": "Access denied" })),
            Some(R2TestOutcome {
                ok: false,
                error: Some("Access denied".into())
            })
        );
        assert_eq!(
            parse_r2_test(&json!({ "ok": false }))
                .unwrap()
                .error
                .as_deref(),
            Some("The connection test failed.")
        );
        assert!(parse_r2_test(&json!({ "error": "x" })).is_none());
    }

    #[test]
    fn field_errors_keep_known_fields_and_drop_leaked_values() {
        let body = json!({
            "message": "The given data was invalid.",
            "errors": {
                "endpoint": ["The endpoint must be a valid URL."],
                "secret_access_key": ["The value topsecret123 is wrong."],
                "other": ["ignored"]
            }
        });
        let fields = parse_field_errors(&body, &["topsecret123"]);

        assert_eq!(fields.len(), 2);
        assert_eq!(fields["endpoint"], "The endpoint must be a valid URL.");
        assert_eq!(
            fields["secretAccessKey"],
            "This value was rejected by the site."
        );
    }
}
