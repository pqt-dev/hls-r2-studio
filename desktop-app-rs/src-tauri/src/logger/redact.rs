//! Secret redaction for log text and structured fields. Port of
//! desktop-app/src/main/logger/redact.ts: Authorization / Bearer values, Sanctum-style tokens
//! (`<id>|<random>`), values of sensitive keys, and the user's home directory (as `~`).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

pub const REDACTED: &str = "[REDACTED]";

/// Normalised (lower case, no `_`/`-`) key names whose values must never be logged.
const SENSITIVE_KEYS: [&str; 7] = [
    "token",
    "accesstoken",
    "secret",
    "password",
    "secretaccesskey",
    "accesskeyid",
    "authorization",
];

const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, Default)]
pub struct RedactOptions {
    /// Home directory to replace with `~`. `None` = the current user's home directory;
    /// `Some("")` disables the replacement.
    pub home_dir: Option<String>,
}

/// The current user's home directory (`os.homedir()`): `USERPROFILE` on Windows, `HOME` elsewhere.
pub fn default_home_dir() -> Option<String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

    std::env::var(var).ok().filter(|v| !v.is_empty())
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect();

    SENSITIVE_KEYS.contains(&normalized.as_str())
}

/// Matches `homeDir` as written and with either slash style, case-insensitively.
fn home_pattern(home_dir: Option<&str>) -> Option<Regex> {
    let home = home_dir?;
    let trimmed = home.trim_end_matches(['\\', '/']);

    if trimmed.chars().count() < 2 {
        return None;
    }

    let mut variants: Vec<String> = Vec::new();

    for v in [
        trimmed.to_string(),
        trimmed.replace('\\', "/"),
        trimmed.replace('/', "\\"),
    ] {
        if !variants.contains(&v) {
            variants.push(v);
        }
    }

    let pattern = variants
        .iter()
        .map(|v| regex::escape(v))
        .collect::<Vec<_>>()
        .join("|");

    Regex::new(&format!("(?i){pattern}")).ok()
}

struct Patterns {
    authorization: Regex,
    bearer: Regex,
    sanctum: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();

    PATTERNS.get_or_init(|| Patterns {
        // Authorization header / key-value forms, with or without a scheme.
        authorization: Regex::new(
            r#"(?i)(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"',;]+"#,
        )
        .expect("authorization pattern"),
        // Bare "Bearer xyz" values (ASCII word boundary, like JS `\b`).
        bearer: Regex::new(r"(?i)(?-u:\b)Bearer\s+[A-Za-z0-9._~+/=|-]+").expect("bearer pattern"),
        // Sanctum personal access tokens: "<id>|<random>".
        sanctum: Regex::new(r"(?-u:\b)[0-9]+\|[A-Za-z0-9]{20,}").expect("sanctum pattern"),
    })
}

fn redact_text(input: &str, home: Option<&Regex>) -> String {
    let p = patterns();
    let out = p
        .authorization
        .replace_all(input, |caps: &regex::Captures| {
            format!("{}{REDACTED}", &caps[1])
        });
    let out = p
        .bearer
        .replace_all(&out, |_: &regex::Captures| format!("Bearer {REDACTED}"));
    let out = p
        .sanctum
        .replace_all(&out, |_: &regex::Captures| REDACTED.to_string());

    match home {
        Some(home) => home
            .replace_all(&out, |_: &regex::Captures| "~")
            .into_owned(),
        None => out.into_owned(),
    }
}

/// Redacts secrets inside a free-form string.
pub fn redact_string(input: &str, options: &RedactOptions) -> String {
    let home_dir = options.home_dir.clone().or_else(default_home_dir);

    redact_text(input, home_pattern(home_dir.as_deref()).as_ref())
}

fn walk(value: &Value, home: Option<&Regex>, depth: usize) -> Value {
    match value {
        Value::String(s) => Value::String(redact_text(s, home)),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return Value::String("[Truncated]".into());
            }

            Value::Array(items.iter().map(|i| walk(i, home, depth + 1)).collect())
        }
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return Value::String("[Truncated]".into());
            }

            let mut out = Map::new();

            for (key, item) in map {
                let redacted = if is_sensitive_key(key) {
                    Value::String(REDACTED.into())
                } else {
                    walk(item, home, depth + 1)
                };
                out.insert(key.clone(), redacted);
            }

            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Returns a copy of `value` with secrets removed. The input is never modified.
pub fn redact_value(value: &Value, options: &RedactOptions) -> Value {
    let home_dir = options.home_dir.clone().or_else(default_home_dir);

    walk(value, home_pattern(home_dir.as_deref()).as_ref(), 0)
}

/// An error as a loggable value (`{ name, message }`, like the Error branch of the TS walker).
pub fn error_to_value(error: &dyn std::error::Error) -> Value {
    serde_json::json!({ "name": "Error", "message": error.to_string() })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const HOME: &str = "C:\\Users\\alice";

    fn opts(home: &str) -> RedactOptions {
        RedactOptions {
            home_dir: Some(home.to_string()),
        }
    }

    fn red(text: &str) -> String {
        redact_string(text, &opts(""))
    }

    #[test]
    fn masks_bearer_values() {
        assert_eq!(red("Bearer abc.DEF-123_xyz"), format!("Bearer {REDACTED}"));
    }

    #[test]
    fn masks_authorization_header_text() {
        let out = red("Authorization: Bearer 12|abcdefghijklmnopqrstuvwxyz0123");

        assert!(!out.contains("abcdefghij"));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn masks_authorization_key_value_forms() {
        assert_eq!(
            red(r#"{"authorization":"Basic dXNlcjpwdw=="}"#),
            format!(r#"{{"authorization":"{REDACTED}"}}"#)
        );
        assert_eq!(
            red("authorization=abc123"),
            format!("authorization={REDACTED}")
        );
    }

    #[test]
    fn masks_sanctum_style_tokens_inside_text() {
        let out = red("login ok token=7|AbCdEfGhIjKlMnOpQrStUv123456 done");

        assert!(!out.contains("AbCdEf"));
        assert!(out.starts_with("login ok"));
        assert!(out.ends_with("done"));
    }

    #[test]
    fn does_not_touch_short_number_word_pairs() {
        assert_eq!(red("a 1|abc b"), "a 1|abc b");
    }

    #[test]
    fn masks_values_of_sensitive_keys_at_any_depth() {
        let out = redact_value(
            &json!({
                "token": "t",
                "nested": { "Password": "p", "secret_access_key": "s", "accessKeyId": "k", "keep": "ok" },
                "list": [{ "authorization": "Bearer x" }]
            }),
            &opts(""),
        );

        assert_eq!(
            out,
            json!({
                "token": REDACTED,
                "nested": {
                    "Password": REDACTED,
                    "secret_access_key": REDACTED,
                    "accessKeyId": REDACTED,
                    "keep": "ok"
                },
                "list": [{ "authorization": REDACTED }]
            })
        );
    }

    #[test]
    fn replaces_the_home_directory_with_tilde_in_all_slash_styles_case_insensitively() {
        let o = opts(HOME);

        assert_eq!(
            redact_string("C:\\Users\\alice\\Videos\\a.mp4", &o),
            "~\\Videos\\a.mp4"
        );
        assert_eq!(
            redact_string("C:/Users/alice/Videos/a.mp4", &o),
            "~/Videos/a.mp4"
        );
        assert_eq!(redact_string("c:\\users\\ALICE\\x", &o), "~\\x");
    }

    #[test]
    fn replaces_a_posix_home_directory() {
        assert_eq!(
            redact_string("/Users/bob/file", &opts("/Users/bob")),
            "~/file"
        );
    }

    #[test]
    fn ignores_a_root_like_home_directory() {
        assert_eq!(redact_string("/etc/x", &opts("/")), "/etc/x");
    }

    #[test]
    fn a_trailing_slash_on_the_home_directory_is_ignored() {
        assert_eq!(
            redact_string("/Users/bob/file", &opts("/Users/bob/")),
            "~/file"
        );
    }

    #[test]
    fn redacts_inside_error_values() {
        let err = std::io::Error::other("failed in C:\\Users\\alice\\x with Bearer secrettoken");
        let out = redact_value(&error_to_value(&err), &opts(HOME));

        assert_eq!(
            out["message"],
            format!("failed in ~\\x with Bearer {REDACTED}")
        );
    }

    #[test]
    fn truncates_values_nested_deeper_than_the_limit_and_does_not_mutate_input() {
        let mut deep = json!({ "token": "x", "leaf": "Bearer abc" });

        for _ in 0..10 {
            deep = json!({ "next": deep });
        }

        let before = deep.clone();
        let out = redact_value(&deep, &opts(""));
        let mut cursor = &out;

        for _ in 0..8 {
            cursor = &cursor["next"];
        }

        assert_eq!(cursor, &json!("[Truncated]"));
        assert_eq!(deep, before);
    }

    #[test]
    fn passes_primitives_through() {
        assert_eq!(redact_value(&json!(5), &opts("")), json!(5));
        assert_eq!(redact_value(&Value::Null, &opts("")), Value::Null);
        assert_eq!(redact_value(&json!(true), &opts("")), json!(true));
    }
}
