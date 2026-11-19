//! Payload validation for IPC commands. Port of desktop-app/src/main/ipc/validate.ts.
//!
//! The renderer shim sends a command's input as the single `payload` argument, so "the IPC
//! arguments" of the Electron handlers map to `Option<Value>` here: `None` = no argument.
//! String lengths are counted in UTF-16 units, like JS `.length`.

use std::fmt;

use serde_json::{Map, Value};

use crate::api::logs::LogType;
use crate::api::videos::{
    normalize_video_title, VideoSort, MAX_BULK_DELETE, MAX_TITLE_CHARS, STATUS_FILTERS,
};
use crate::dto::{CopyKind, VideoLinkKind};
use crate::secure::Secret;
use crate::settings::SettingsPatch;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcValidationError(pub String);

impl fmt::Display for IpcValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IpcValidationError {}

type Result<T> = std::result::Result<T, IpcValidationError>;

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(IpcValidationError(message.into()))
}

fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Channels without a payload must be invoked with no arguments.
pub fn expect_no_args(payload: Option<&Value>) -> Result<()> {
    match payload {
        None => Ok(()),
        Some(_) => invalid("Unexpected arguments"),
    }
}

pub fn expect_string(value: Option<&Value>, name: &str, max_length: usize) -> Result<String> {
    let Some(Value::String(text)) = value else {
        return invalid(format!("{name} must be a string"));
    };

    if js_length(text) > max_length {
        return invalid(format!("{name} is too long"));
    }

    Ok(text.clone())
}

pub fn expect_plain_object<'a>(
    value: Option<&'a Value>,
    name: &str,
) -> Result<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => invalid(format!("{name} must be an object")),
    }
}

pub fn expect_boolean(value: Option<&Value>, name: &str) -> Result<bool> {
    match value {
        Some(Value::Bool(b)) => Ok(*b),
        _ => invalid(format!("{name} must be a boolean")),
    }
}

/// Integer within `[min, max]` (`1.0` counts as an integer, like `Number.isInteger`).
pub fn expect_int(value: Option<&Value>, name: &str, min: i64, max: i64) -> Result<i64> {
    let number = value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64);

    match number {
        Some(n) => Ok(n as i64),
        None => invalid(format!("{name} must be an integer from {min} to {max}")),
    }
}

pub fn expect_one_of<'a>(
    value: Option<&Value>,
    name: &str,
    allowed: &[&'a str],
) -> Result<&'a str> {
    let text = value.and_then(Value::as_str);

    match allowed.iter().find(|a| Some(**a) == text) {
        Some(found) => Ok(found),
        None => invalid(format!("{name} is not an allowed value")),
    }
}

pub fn expect_string_array(
    value: Option<&Value>,
    name: &str,
    max_items: usize,
    max_length: usize,
) -> Result<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return invalid(format!("{name} must be an array"));
    };

    if items.len() > max_items {
        return invalid(format!("{name} has too many items"));
    }

    items
        .iter()
        .enumerate()
        .map(|(index, item)| expect_string(Some(item), &format!("{name}[{index}]"), max_length))
        .collect()
}

/// `^[A-Za-z0-9_-]{1,64}$`.
pub fn expect_job_id(value: Option<&Value>, name: &str) -> Result<String> {
    let id = expect_string(value, name, 64)?;
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');

    if !valid {
        return invalid(format!("{name} is not valid"));
    }

    Ok(id)
}

/// A single payload argument that must be a plain object with only the allowed keys.
pub fn expect_single_object(
    payload: Option<Value>,
    name: &str,
    allowed_keys: &[&str],
) -> Result<Map<String, Value>> {
    let Some(value) = payload else {
        return invalid(format!("{name} expects exactly one argument"));
    };
    let Value::Object(object) = value else {
        return invalid(format!("{name} must be an object"));
    };

    if object
        .keys()
        .any(|key| !allowed_keys.contains(&key.as_str()))
    {
        return invalid(format!("{name} has an unexpected property"));
    }

    Ok(object)
}

/// Validated `auth:login` input. The site is fixed at build time: the renderer cannot send (or
/// even name) a server here.
#[derive(Debug)]
pub struct LoginInput {
    pub username: String,
    pub password: Secret,
    pub stay_signed_in: bool,
}

pub const MAX_USERNAME_LENGTH: usize = 256;
pub const MAX_PASSWORD_LENGTH: usize = 1024;

/// `parseLogin`. The password string is moved (not copied) into a `Secret`.
pub fn parse_login(payload: Option<Value>) -> Result<LoginInput> {
    let mut object =
        expect_single_object(payload, "login", &["username", "password", "staySignedIn"])?;
    let username = expect_string(object.get("username"), "username", MAX_USERNAME_LENGTH)?;
    let password = match object.remove("password") {
        Some(Value::String(text)) => Secret::new(text),
        _ => return invalid("password must be a string"),
    };

    if js_length(password.expose()) > MAX_PASSWORD_LENGTH {
        return invalid("password is too long");
    }

    let stay_signed_in = match object.get("staySignedIn") {
        None => true,
        value => expect_boolean(value, "staySignedIn")?,
    };

    Ok(LoginInput {
        username,
        password,
        stay_signed_in,
    })
}

pub const MAX_ADD_PATHS: usize = 1000;
pub const MAX_PATH_LENGTH: usize = 4096;
const COPY_KINDS: &[&str] = &["embed-url", "shortcode"];

/// `parseSettingsPatch`: only `tmpRoot` and `maxConcurrent` are accepted, so a `siteUrl` (or any
/// other key) is rejected. Value rules (writable folder, 1..2) stay in the settings service.
pub fn parse_settings_patch(payload: Option<Value>) -> Result<SettingsPatch> {
    let object = expect_single_object(payload, "settings", &["tmpRoot", "maxConcurrent"])?;
    let mut patch = SettingsPatch::default();

    if let Some(value) = object.get("tmpRoot") {
        patch.tmp_root = Some(expect_string(Some(value), "tmpRoot", 4096)?);
    }

    if let Some(value) = object.get("maxConcurrent") {
        patch.max_concurrent = Some(expect_int(Some(value), "maxConcurrent", -1000, 1000)? as f64);
    }

    Ok(patch)
}

/// `parseId`: `{ id }` with a safe job id (`jobs:cancel`, `retry`, `retry-register`, `resume`,
/// `remove`, `open-embed`).
pub fn parse_job_id_payload(payload: Option<Value>, name: &str) -> Result<String> {
    let object = expect_single_object(payload, name, &["id"])?;

    expect_job_id(object.get("id"), "id")
}

/// `jobs:add-paths`: `{ paths: string[] }`, at most 1000 entries.
pub fn parse_add_paths(payload: Option<Value>) -> Result<Vec<String>> {
    let object = expect_single_object(payload, "paths", &["paths"])?;

    expect_string_array(object.get("paths"), "paths", MAX_ADD_PATHS, MAX_PATH_LENGTH)
}

/// `jobs:copy`: `{ id, kind }` where kind is `embed-url` or `shortcode`.
pub fn parse_copy(payload: Option<Value>) -> Result<(String, CopyKind)> {
    let object = expect_single_object(payload, "copy", &["id", "kind"])?;
    let id = expect_job_id(object.get("id"), "id")?;
    let kind = match expect_one_of(object.get("kind"), "kind", COPY_KINDS)? {
        "embed-url" => CopyKind::EmbedUrl,
        _ => CopyKind::Shortcode,
    };

    Ok((id, kind))
}

pub const DEFAULT_VIDEOS_PAGE: u32 = 1;
pub const DEFAULT_VIDEOS_PER_PAGE: u32 = 24;
pub const MAX_VIDEOS_PER_PAGE: u32 = 50;
pub const MAX_VIDEOS_QUERY_LENGTH: usize = 100;
/// Largest integer a JS number holds exactly (the server id is a PHP integer).
const VIDEO_LINK_KINDS: &[&str] = &[
    "embed-url",
    "playlist-url",
    "shortcode",
    "iframe-code",
    "thumbnail-url",
    "custom-image-url",
    "storyboard-url",
    "storage-folder",
];
/// Most storyboards a detail keeps (`MAX_STORYBOARDS` in api/videos.rs), so `index` is 0..=7.
const MAX_STORYBOARD_INDEX: i64 = 7;
const MAX_VIDEO_ID: i64 = 9_007_199_254_740_991;

/// Validated `videos:list` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideosListInput {
    pub page: u32,
    pub per_page: u32,
    /// Trimmed search text; `None` when absent or blank.
    pub query: Option<String>,
    pub sort: VideoSort,
    /// One of `STATUS_FILTERS`; `None` means every status.
    pub status: Option<String>,
}

/// `videos:list`: `{ page?, perPage?, q?, sort? }` (no argument = all defaults).
pub fn parse_videos_list(payload: Option<Value>) -> Result<VideosListInput> {
    let Some(payload) = payload else {
        return Ok(VideosListInput {
            page: DEFAULT_VIDEOS_PAGE,
            per_page: DEFAULT_VIDEOS_PER_PAGE,
            query: None,
            sort: VideoSort::Newest,
            status: None,
        });
    };
    let object = expect_single_object(
        Some(payload),
        "videos",
        &["page", "perPage", "q", "sort", "status"],
    )?;
    let page = match object.get("page") {
        None => DEFAULT_VIDEOS_PAGE,
        value => expect_int(value, "page", 1, i64::from(u32::MAX))? as u32,
    };
    let per_page = match object.get("perPage") {
        None => DEFAULT_VIDEOS_PER_PAGE,
        value => expect_int(value, "perPage", 1, i64::from(MAX_VIDEOS_PER_PAGE))? as u32,
    };
    let query = match object.get("q") {
        None => None,
        Some(Value::String(text)) => {
            let text = text.trim();

            if js_length(text) > MAX_VIDEOS_QUERY_LENGTH {
                return invalid("q is too long");
            }

            Some(text.to_string()).filter(|text| !text.is_empty())
        }
        Some(_) => return invalid("q must be a string"),
    };

    let sort = match object.get("sort") {
        None => VideoSort::Newest,
        value => {
            let text = expect_one_of(value, "sort", VideoSort::ALLOWED)?;

            VideoSort::from_param(text).unwrap_or_default()
        }
    };

    let status = match object.get("status") {
        None => None,
        value => Some(expect_one_of(value, "status", STATUS_FILTERS)?.to_string()),
    };

    Ok(VideosListInput {
        page,
        per_page,
        query,
        sort,
        status,
    })
}

/// Validated `logs:get` input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogsGetInput {
    pub log_type: Option<LogType>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

const LOG_TYPES: &[&str] = &["success", "error", "processing"];

/// `logs:get`: `{ type?, page?, perPage? }` (no argument = the summary). `page` is 1.., `perPage`
/// 1..=50; unknown keys are rejected.
pub fn parse_logs_get(payload: Option<Value>) -> Result<LogsGetInput> {
    let Some(payload) = payload else {
        return Ok(LogsGetInput {
            log_type: None,
            page: None,
            per_page: None,
        });
    };
    let object = expect_single_object(Some(payload), "logs", &["type", "page", "perPage"])?;
    let log_type = match object.get("type") {
        None => None,
        value => LogType::parse(expect_one_of(value, "type", LOG_TYPES)?),
    };
    let page = match object.get("page") {
        None => None,
        value => Some(expect_int(value, "page", 1, i64::from(u32::MAX))? as u32),
    };
    let per_page = match object.get("perPage") {
        None => None,
        value => Some(expect_int(value, "perPage", 1, i64::from(MAX_VIDEOS_PER_PAGE))? as u32),
    };

    Ok(LogsGetInput {
        log_type,
        page,
        per_page,
    })
}

/// `videos:copy-link`: `{ id, kind }` with a positive integer id and `embed-url` / `playlist-url` / `shortcode` / `iframe-code` / `thumbnail-url` / `custom-image-url` / `storage-folder`, or `{ id, kind: 'storyboard-url', index }` with an integer `index` from 0 to 7. `index` is required for `storyboard-url` and rejected for every other kind.
pub fn parse_video_link(payload: Option<Value>) -> Result<(i64, VideoLinkKind)> {
    let object = expect_single_object(payload, "video link", &["id", "kind", "index"])?;
    let id = expect_int(object.get("id"), "id", 1, MAX_VIDEO_ID)?;
    let kind_name = expect_one_of(object.get("kind"), "kind", VIDEO_LINK_KINDS)?;

    if kind_name == "storyboard-url" {
        let index = expect_int(object.get("index"), "index", 0, MAX_STORYBOARD_INDEX)?;

        return Ok((id, VideoLinkKind::StoryboardUrl(index as usize)));
    }

    if object.contains_key("index") {
        return invalid("index is only allowed for storyboard-url");
    }

    let kind = match kind_name {
        "embed-url" => VideoLinkKind::EmbedUrl,
        "shortcode" => VideoLinkKind::Shortcode,
        "iframe-code" => VideoLinkKind::IframeCode,
        "thumbnail-url" => VideoLinkKind::ThumbnailUrl,
        "custom-image-url" => VideoLinkKind::CustomImageUrl,
        "storage-folder" => VideoLinkKind::StorageFolder,
        _ => VideoLinkKind::PlaylistUrl,
    };

    Ok((id, kind))
}

/// `videos:get`: `{ id }` with a positive integer.
pub fn parse_video_id(payload: Option<Value>) -> Result<i64> {
    let object = expect_single_object(payload, "video", &["id"])?;

    expect_int(object.get("id"), "id", 1, MAX_VIDEO_ID)
}

/// `videos:update-title`: `{ id, title }`. The title is trimmed and must be 1..=255 characters
/// without control characters (the same rule `SiteClient::update_video_title` applies).
pub fn parse_video_title_update(payload: Option<Value>) -> Result<(i64, String)> {
    let object = expect_single_object(payload, "video title", &["id", "title"])?;
    let id = expect_int(object.get("id"), "id", 1, MAX_VIDEO_ID)?;
    // A generous byte bound before the character count, so a huge string is never walked.
    let raw = expect_string(object.get("title"), "title", 4 * MAX_TITLE_CHARS)?;
    let title =
        normalize_video_title(&raw).map_err(|message| IpcValidationError(message.into()))?;

    Ok((id, title))
}

/// `videos:bulk-delete`: `{ ids }` with 1..=100 positive integers. Duplicates are dropped
/// (order kept).
pub fn parse_video_bulk_delete(payload: Option<Value>) -> Result<Vec<i64>> {
    let object = expect_single_object(payload, "video selection", &["ids"])?;
    let Some(Value::Array(items)) = object.get("ids") else {
        return invalid("ids must be an array");
    };

    if items.is_empty() || items.len() > MAX_BULK_DELETE {
        return invalid(format!("ids must hold 1 to {MAX_BULK_DELETE} items"));
    }

    let mut ids: Vec<i64> = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        let id = expect_int(Some(item), &format!("ids[{index}]"), 1, MAX_VIDEO_ID)?;

        if !ids.contains(&id) {
            ids.push(id);
        }
    }

    Ok(ids)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn expect_no_args_rejects_extra_arguments() {
        assert!(expect_no_args(None).is_ok());
        assert!(expect_no_args(Some(&json!(1))).is_err());
        assert!(expect_no_args(Some(&json!("unexpected"))).is_err());
        assert!(expect_no_args(Some(&json!({}))).is_err());
    }

    #[test]
    fn expect_string_checks_type_and_length() {
        assert_eq!(
            expect_string(Some(&json!("abc")), "x", 2048).unwrap(),
            "abc"
        );
        assert!(expect_string(Some(&json!(5)), "x", 2048).is_err());
        assert!(expect_string(None, "x", 2048).is_err());
        assert_eq!(
            expect_string(Some(&json!("a".repeat(11))), "x", 10),
            Err(IpcValidationError("x is too long".into()))
        );
        // UTF-16 units: one astral character counts as 2, like JS.
        assert!(expect_string(Some(&json!("\u{1F600}")), "x", 1).is_err());
    }

    #[test]
    fn expect_plain_object_rejects_null_arrays_and_primitives() {
        assert_eq!(
            expect_plain_object(Some(&json!({ "a": 1 })), "x").unwrap(),
            json!({ "a": 1 }).as_object().unwrap()
        );

        for bad in [json!(null), json!([]), json!("str"), json!(1)] {
            assert!(expect_plain_object(Some(&bad), "x").is_err());
        }

        assert!(expect_plain_object(None, "x").is_err());
    }

    #[test]
    fn expect_int_enforces_integers_in_range() {
        assert_eq!(expect_int(Some(&json!(2)), "n", 1, 2).unwrap(), 2);
        assert_eq!(expect_int(Some(&json!(2.0)), "n", 1, 2).unwrap(), 2);

        for bad in [json!(0), json!(3), json!(1.5), json!("1"), json!(null)] {
            assert!(expect_int(Some(&bad), "n", 1, 2).is_err(), "{bad}");
        }

        assert!(expect_int(None, "n", 1, 2).is_err());
    }

    #[test]
    fn expect_one_of_and_expect_string_array() {
        assert_eq!(
            expect_one_of(Some(&json!("a")), "k", &["a", "b"]).unwrap(),
            "a"
        );
        assert!(expect_one_of(Some(&json!("c")), "k", &["a", "b"]).is_err());
        assert!(expect_one_of(Some(&json!(1)), "k", &["a"]).is_err());

        assert_eq!(
            expect_string_array(Some(&json!(["a", "b"])), "p", 5, 4096).unwrap(),
            ["a", "b"]
        );
        assert!(expect_string_array(Some(&json!("a")), "p", 5, 4096).is_err());
        assert!(expect_string_array(Some(&json!(["a", 1])), "p", 5, 4096).is_err());
        assert!(expect_string_array(Some(&json!(["a", "b", "c"])), "p", 2, 4096).is_err());
        assert!(expect_string_array(Some(&json!(["a".repeat(11)])), "p", 2, 10).is_err());
    }

    #[test]
    fn expect_job_id_accepts_safe_ids_only() {
        assert_eq!(
            expect_job_id(Some(&json!("a1-b_2")), "id").unwrap(),
            "a1-b_2"
        );

        for bad in [
            json!(""),
            json!("../x"),
            json!("a b"),
            json!("x".repeat(65)),
            json!(5),
        ] {
            assert!(expect_job_id(Some(&bad), "id").is_err(), "{bad}");
        }
    }

    #[test]
    fn expect_single_object_rejects_missing_wrong_and_unknown_keys() {
        assert_eq!(
            expect_single_object(Some(json!({ "id": "a" })), "x", &["id"]).unwrap(),
            *json!({ "id": "a" }).as_object().unwrap()
        );
        assert!(expect_single_object(None, "x", &["id"]).is_err());
        assert!(expect_single_object(Some(json!([{}, {}])), "x", &["id"]).is_err());
        assert!(expect_single_object(Some(json!({ "id": "a", "evil": 1 })), "x", &["id"]).is_err());
        assert!(expect_single_object(Some(json!("a")), "x", &["id"]).is_err());
    }

    #[test]
    fn parse_login_defaults_stay_signed_in_to_true() {
        let input = parse_login(Some(json!({ "username": "u", "password": "p" }))).unwrap();

        assert_eq!(input.username, "u");
        assert_eq!(input.password.expose(), "p");
        assert!(input.stay_signed_in);

        let input = parse_login(Some(
            json!({ "username": "u", "password": "p", "staySignedIn": false }),
        ))
        .unwrap();
        assert!(!input.stay_signed_in);
    }

    #[test]
    fn parse_login_rejects_malformed_payloads() {
        for bad in [
            None,
            Some(json!("u")),
            Some(json!({ "username": "a" })),
            Some(json!({ "username": "a", "password": 1 })),
            Some(json!({ "username": 1, "password": "p" })),
            Some(json!({ "username": "u", "password": "p", "staySignedIn": "no" })),
            Some(json!({ "username": "u", "password": "p", "staySignedIn": null })),
            // The renderer cannot choose the server: a site URL is an unknown field.
            Some(json!({ "siteUrl": "https://evil.example", "username": "a", "password": "b" })),
            Some(json!({ "username": "a".repeat(257), "password": "p" })),
            Some(json!({ "username": "u", "password": "p".repeat(1025) })),
        ] {
            assert!(parse_login(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn validation_messages_never_contain_the_password() {
        let error = parse_login(Some(
            json!({ "username": "u", "password": "hunter2".repeat(200) }),
        ))
        .unwrap_err();

        assert_eq!(error.0, "password is too long");

        let input = parse_login(Some(json!({ "username": "u", "password": "hunter2" }))).unwrap();
        assert!(!format!("{input:?}").contains("hunter2"));
    }

    #[test]
    fn settings_patch_accepts_only_the_known_keys() {
        let patch =
            parse_settings_patch(Some(json!({ "tmpRoot": "/x", "maxConcurrent": 2 }))).unwrap();

        assert_eq!(patch.tmp_root.as_deref(), Some("/x"));
        assert_eq!(patch.max_concurrent, Some(2.0));
        assert_eq!(
            parse_settings_patch(Some(json!({}))).unwrap(),
            SettingsPatch::default()
        );

        for bad in [
            None,
            Some(json!("x")),
            Some(json!([1])),
            Some(json!(null)),
            // The site is fixed at build time: it is not a settings key.
            Some(json!({ "siteUrl": "https://evil.example" })),
            Some(json!({ "tmpRoot": "/x", "siteUrl": "https://evil.example" })),
            Some(json!({ "evil": 1 })),
            Some(json!({ "tmpRoot": 5 })),
            Some(json!({ "tmpRoot": "a".repeat(4097) })),
            Some(json!({ "maxConcurrent": "2" })),
            Some(json!({ "maxConcurrent": 1.5 })),
            Some(json!({ "maxConcurrent": null })),
            Some(json!({ "maxConcurrent": 1001 })),
        ] {
            assert!(parse_settings_patch(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn job_id_payload_validates_the_id() {
        assert_eq!(
            parse_job_id_payload(Some(json!({ "id": "a1" })), "cancel").unwrap(),
            "a1"
        );

        for bad in [
            None,
            Some(json!("a1")),
            Some(json!({})),
            Some(json!({ "id": 5 })),
            Some(json!({ "id": "../x" })),
            Some(json!({ "id": "" })),
            Some(json!({ "id": "a", "evil": 1 })),
        ] {
            assert!(
                parse_job_id_payload(bad.clone(), "cancel").is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn add_paths_validates_the_list() {
        assert_eq!(
            parse_add_paths(Some(json!({ "paths": ["/a", "/b"] }))).unwrap(),
            ["/a", "/b"]
        );

        for bad in [
            None,
            Some(json!({})),
            Some(json!({ "paths": "/a" })),
            Some(json!({ "paths": [1] })),
            Some(json!({ "paths": ["/a"], "evil": 1 })),
            Some(json!({ "paths": vec!["/a"; 1001] })),
            Some(json!({ "paths": ["a".repeat(4097)] })),
        ] {
            assert!(parse_add_paths(bad.clone()).is_err());
        }
    }

    #[test]
    fn copy_validates_id_and_kind() {
        assert_eq!(
            parse_copy(Some(json!({ "id": "a", "kind": "shortcode" }))).unwrap(),
            ("a".to_string(), CopyKind::Shortcode)
        );
        assert_eq!(
            parse_copy(Some(json!({ "id": "a", "kind": "embed-url" })))
                .unwrap()
                .1,
            CopyKind::EmbedUrl
        );

        for bad in [
            None,
            Some(json!({ "id": "a" })),
            Some(json!({ "id": "a", "kind": "other" })),
            Some(json!({ "id": "a", "kind": 1 })),
            Some(json!({ "id": "a b", "kind": "shortcode" })),
            Some(json!({ "id": "a", "kind": "shortcode", "evil": 1 })),
        ] {
            assert!(parse_copy(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn videos_list_applies_defaults_and_validates_bounds() {
        let defaults = VideosListInput {
            page: 1,
            per_page: 24,
            query: None,
            sort: VideoSort::Newest,
            status: None,
        };

        assert_eq!(parse_videos_list(None).unwrap(), defaults);
        assert_eq!(parse_videos_list(Some(json!({}))).unwrap(), defaults);
        assert_eq!(
            parse_videos_list(Some(json!({ "page": 3, "perPage": 50, "q": "  a b  " }))).unwrap(),
            VideosListInput {
                page: 3,
                per_page: 50,
                query: Some("a b".into()),
                sort: VideoSort::Newest,
                status: None,
            }
        );

        for name in STATUS_FILTERS {
            let input = parse_videos_list(Some(json!({ "status": name }))).unwrap();

            assert_eq!(input.status.as_deref(), Some(*name));
        }

        for name in VideoSort::ALLOWED {
            let input = parse_videos_list(Some(json!({ "sort": name }))).unwrap();

            assert_eq!(input.sort.as_param(), *name);
        }
        assert_eq!(
            parse_videos_list(Some(json!({ "q": "   " })))
                .unwrap()
                .query,
            None
        );

        let long = "x".repeat(101);

        for bad in [
            json!({ "page": 0 }),
            json!({ "page": 1.5 }),
            json!({ "page": "1" }),
            json!({ "perPage": 0 }),
            json!({ "perPage": 51 }),
            json!({ "q": long }),
            json!({ "q": 5 }),
            json!({ "sort": "random" }),
            json!({ "status": "done" }),
            json!({ "status": 1 }),
            json!({ "status": "" }),
            json!({ "sort": 1 }),
            json!({ "sort": "" }),
            json!({ "other": 1 }),
            json!("page"),
        ] {
            assert!(parse_videos_list(Some(bad.clone())).is_err(), "{bad}");
        }

        assert!(parse_videos_list(Some(json!({ "q": "x".repeat(100) }))).is_ok());
    }

    #[test]
    fn logs_get_validates_type_and_bounds() {
        let none = LogsGetInput {
            log_type: None,
            page: None,
            per_page: None,
        };

        assert_eq!(parse_logs_get(None).unwrap(), none);
        assert_eq!(parse_logs_get(Some(json!({}))).unwrap(), none);
        assert_eq!(
            parse_logs_get(Some(json!({ "type": "error", "page": 2, "perPage": 50 }))).unwrap(),
            LogsGetInput {
                log_type: Some(LogType::Error),
                page: Some(2),
                per_page: Some(50),
            }
        );

        for kind in ["success", "error", "processing"] {
            assert!(parse_logs_get(Some(json!({ "type": kind }))).is_ok());
        }

        for bad in [
            json!({ "type": "x" }),
            json!({ "type": "Error" }),
            json!({ "type": 5 }),
            json!({ "type": null }),
            json!({ "page": 0 }),
            json!({ "page": 1.5 }),
            json!({ "page": "1" }),
            json!({ "perPage": 0 }),
            json!({ "perPage": 51 }),
            json!({ "type": "error", "extra": 1 }),
            json!("error"),
            json!([]),
        ] {
            assert!(parse_logs_get(Some(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn video_id_must_be_a_positive_integer() {
        assert_eq!(parse_video_id(Some(json!({ "id": 12 }))).unwrap(), 12);

        for bad in [
            None,
            Some(json!({})),
            Some(json!({ "id": 0 })),
            Some(json!({ "id": -1 })),
            Some(json!({ "id": 1.5 })),
            Some(json!({ "id": "12" })),
            Some(json!({ "id": 1, "x": 1 })),
        ] {
            assert!(parse_video_id(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn video_link_validates_id_and_kind() {
        assert_eq!(
            parse_video_link(Some(json!({ "id": 5, "kind": "embed-url" }))).unwrap(),
            (5, VideoLinkKind::EmbedUrl)
        );
        assert_eq!(
            parse_video_link(Some(json!({ "id": 5, "kind": "playlist-url" }))).unwrap(),
            (5, VideoLinkKind::PlaylistUrl)
        );
        assert_eq!(
            parse_video_link(Some(json!({ "id": 5, "kind": "iframe-code" }))).unwrap(),
            (5, VideoLinkKind::IframeCode)
        );
        assert_eq!(
            parse_video_link(Some(json!({ "id": 5, "kind": "shortcode" }))).unwrap(),
            (5, VideoLinkKind::Shortcode)
        );
        assert_eq!(
            parse_video_link(Some(json!({ "id": 5, "kind": "storage-folder" }))).unwrap(),
            (5, VideoLinkKind::StorageFolder)
        );
        assert_eq!(
            parse_video_link(Some(
                json!({ "id": 5, "kind": "storyboard-url", "index": 2 })
            ))
            .unwrap(),
            (5, VideoLinkKind::StoryboardUrl(2))
        );
        assert_eq!(
            parse_video_link(Some(
                json!({ "id": 5, "kind": "storyboard-url", "index": 0 })
            ))
            .unwrap(),
            (5, VideoLinkKind::StoryboardUrl(0))
        );

        for bad in [
            None,
            Some(json!({ "id": 5 })),
            Some(json!({ "kind": "embed-url" })),
            Some(json!({ "id": 0, "kind": "embed-url" })),
            Some(json!({ "id": -2, "kind": "embed-url" })),
            Some(json!({ "id": "5", "kind": "embed-url" })),
            Some(json!({ "id": 5, "kind": "Shortcode" })),
            Some(json!({ "id": 5, "kind": "text" })),
            Some(json!({ "id": 5, "kind": 1 })),
            Some(json!({ "id": 5, "kind": "embed-url", "url": "https://evil.example" })),
            Some(json!({ "id": 5, "kind": "embed-url", "text": "x" })),
            Some(json!({ "id": 5, "kind": "storyboard-url" })),
            Some(json!({ "id": 5, "kind": "storyboard-url", "index": -1 })),
            Some(json!({ "id": 5, "kind": "storyboard-url", "index": 8 })),
            Some(json!({ "id": 5, "kind": "storyboard-url", "index": 1.5 })),
            Some(json!({ "id": 5, "kind": "storyboard-url", "index": "1" })),
            Some(json!({ "id": 5, "kind": "thumbnail-url", "index": 0 })),
            Some(json!({ "id": 5, "kind": "embed-url", "index": 0 })),
            Some(json!({ "id": 5, "kind": "storage-folder", "index": 0 })),
            Some(json!({ "id": 5, "kind": "storage-folder", "text": "x" })),
        ] {
            assert!(parse_video_link(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn video_title_update_trims_and_validates() {
        assert_eq!(
            parse_video_title_update(Some(json!({ "id": 3, "title": "  Hello  " }))).unwrap(),
            (3, "Hello".to_string())
        );
        // 255 characters (multi-byte) are fine: characters, not bytes.
        let long = "\u{0111}".repeat(255);
        assert_eq!(
            parse_video_title_update(Some(json!({ "id": 1, "title": long.clone() })))
                .unwrap()
                .1,
            long
        );

        for bad in [
            None,
            Some(json!({ "id": 3 })),
            Some(json!({ "title": "x" })),
            Some(json!({ "id": 0, "title": "x" })),
            Some(json!({ "id": 3, "title": "" })),
            Some(json!({ "id": 3, "title": "   " })),
            Some(json!({ "id": 3, "title": "a".repeat(256) })),
            Some(json!({ "id": 3, "title": "a\u{0007}b" })),
            Some(json!({ "id": 3, "title": "a\nb" })),
            Some(json!({ "id": 3, "title": 5 })),
            Some(json!({ "id": 3, "title": "x", "url": "https://evil.example" })),
        ] {
            assert!(parse_video_title_update(bad.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn video_bulk_delete_validates_and_dedupes_ids() {
        assert_eq!(
            parse_video_bulk_delete(Some(json!({ "ids": [3, 1, 3, 2, 1] }))).unwrap(),
            vec![3, 1, 2]
        );

        let max: Vec<i64> = (1..=100).collect();
        assert_eq!(
            parse_video_bulk_delete(Some(json!({ "ids": max.clone() }))).unwrap(),
            max
        );

        let too_many: Vec<i64> = (1..=101).collect();

        for bad in [
            None,
            Some(json!({})),
            Some(json!({ "ids": [] })),
            Some(json!({ "ids": [0] })),
            Some(json!({ "ids": [-1] })),
            Some(json!({ "ids": [1.5] })),
            Some(json!({ "ids": ["1"] })),
            Some(json!({ "ids": 5 })),
            Some(json!({ "ids": too_many })),
            Some(json!({ "ids": [1], "extra": true })),
        ] {
            assert!(parse_video_bulk_delete(bad.clone()).is_err(), "{bad:?}");
        }
    }
}
