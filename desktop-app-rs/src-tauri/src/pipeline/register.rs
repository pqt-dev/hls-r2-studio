//! Register payload (spec 3.5), client-side validation and API error mapping (spec 4.4 step 7).
//! Port of register.ts + registerClient.ts. The HTTP call itself is `SiteClient::register`
//! (`api/site_client.rs`); the retry loop belongs to the later `runPipeline` milestone.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use super::file_names::{storyboard_file_name, PLAYLIST_FILE, THUMBNAIL_FILE};
use super::prefix::{is_valid_prefix, MAX_KEY_LENGTH};
use super::public_id::is_valid_public_id;
use super::slug::base_name_without_extension;
use super::storyboard_plan::{storyboard_json, StoryboardEntry};
use crate::ffmpeg::probe_parse::OutputInfo;

/// Body of `POST /api/app/videos`. The same shape is persisted with the job (`registerPayload`
/// in `store.json`), so a stored payload can be retried. Field names are the site's snake_case.
///
/// Deviation from the TS (which only has `number`): the fields are typed (`i64`/`u64`/`f64`), so
/// "fractional size" and similar values cannot be represented; deserializing such a stored
/// value fails instead of being reported by [`validate_register_payload`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterPayload {
    pub public_id: String,
    pub title: String,
    pub original_filename: String,
    pub original_size_bytes: i64,
    pub disk_prefix: String,
    pub playlist_path: String,
    pub thumbnail_path: Option<String>,
    pub storyboards: Option<BTreeMap<String, StoryboardEntry>>,
    pub duration: Option<f64>,
    pub output_width: Option<u64>,
    pub output_height: Option<u64>,
    pub output_fps: Option<f64>,
    pub output_bitrate_kbps: Option<i64>,
    pub output_codec: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuildRegisterPayloadInput {
    pub public_id: String,
    pub prefix: String,
    pub original_filename: String,
    pub original_size_bytes: i64,
    pub duration: Option<f64>,
    pub has_thumbnail: bool,
    /// Grid sizes (3, 4, 5) whose storyboard image exists.
    pub storyboard_grids: Vec<u32>,
    /// `None` when the output probe failed (all output fields become null).
    pub output: Option<OutputInfo>,
}

fn round2(value: f64) -> f64 {
    ((value + f64::EPSILON) * 100.0).round() / 100.0
}

/// JS `String.prototype.trim` whitespace (differs slightly from Rust's `trim`: it includes
/// U+FEFF and excludes U+0085).
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub fn build_register_payload(input: &BuildRegisterPayloadInput) -> RegisterPayload {
    let base = base_name_without_extension(&input.original_filename);
    let base = js_trim(&base);
    let output = input.output.as_ref();

    RegisterPayload {
        public_id: input.public_id.clone(),
        // A name like ".hidden" has an empty base; the server requires a title, so keep the name.
        title: if base.is_empty() {
            js_trim(&input.original_filename).to_string()
        } else {
            base.to_string()
        },
        original_filename: input.original_filename.clone(),
        original_size_bytes: input.original_size_bytes,
        disk_prefix: input.prefix.clone(),
        playlist_path: format!("{}{PLAYLIST_FILE}", input.prefix),
        thumbnail_path: input
            .has_thumbnail
            .then(|| format!("{}{THUMBNAIL_FILE}", input.prefix)),
        storyboards: storyboard_json(&input.storyboard_grids, &input.prefix),
        duration: input.duration,
        output_width: output.and_then(|o| o.width),
        output_height: output.and_then(|o| o.height),
        output_fps: output.and_then(|o| o.fps).map(round2),
        output_bitrate_kbps: output.and_then(|o| o.bitrate_kbps),
        output_codec: output.and_then(|o| o.codec.clone()),
    }
}

const STORYBOARD_KEYS: [&str; 3] = ["3x3", "4x4", "5x5"];
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn char_length(value: &str) -> usize {
    value.chars().count()
}

/// JS `string.length` (UTF-16 code units).
fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn path_too_long() -> String {
    format!("Paths must be at most {MAX_KEY_LENGTH} characters.")
}

/// Checks that every path derived from `prefix` (the longest is the 5x5 storyboard) fits the
/// server's varchar(255) columns. Run before any upload starts. Empty = fits.
pub fn validate_prefix_length(prefix: &str) -> Vec<String> {
    let mut longest = js_length(prefix)
        .max(js_length(&format!("{prefix}{PLAYLIST_FILE}")))
        .max(js_length(&format!("{prefix}{THUMBNAIL_FILE}")));

    for grid in [3, 4, 5] {
        longest = longest.max(js_length(&format!(
            "{prefix}{}",
            storyboard_file_name(grid)
        )));
    }

    if longest > MAX_KEY_LENGTH {
        vec![format!(
            "The upload location is too long. {}",
            path_too_long()
        )]
    } else {
        vec![]
    }
}

/// Mirrors the server rules of `Api\App\VideoController::rules()`. Empty = valid.
pub fn validate_register_payload(payload: &RegisterPayload) -> Vec<String> {
    let mut errors = Vec::new();

    if !is_valid_public_id(&payload.public_id) {
        errors.push("public_id must be 12 characters of a-z and 0-9.".to_string());
    }

    let title = &payload.title;

    if js_trim(title).is_empty() || char_length(title) > 255 {
        errors.push("title is required and must be at most 255 characters.".to_string());
    }

    let filename = &payload.original_filename;

    if js_trim(filename).is_empty() || char_length(filename) > 255 {
        errors
            .push("original_filename is required and must be at most 255 characters.".to_string());
    }

    if !(1..=MAX_SAFE_INTEGER).contains(&payload.original_size_bytes) {
        errors.push("original_size_bytes must be an integer of at least 1.".to_string());
    }

    let prefix_ok = is_valid_public_id(&payload.public_id)
        && is_valid_prefix(&payload.disk_prefix, &payload.public_id);

    if !prefix_ok {
        errors.push("disk_prefix must look like YYYY/MM/DD/<slug>-<public_id>/.".to_string());
    }

    let prefix = prefix_ok.then_some(payload.disk_prefix.as_str());

    let storyboard_paths = payload
        .storyboards
        .iter()
        .flat_map(|map| map.values().map(|entry| entry.path.as_str()));
    let too_long = std::iter::once(payload.disk_prefix.as_str())
        .chain(std::iter::once(payload.playlist_path.as_str()))
        .chain(payload.thumbnail_path.as_deref())
        .chain(storyboard_paths)
        .any(|value| js_length(value) > MAX_KEY_LENGTH);

    if too_long {
        errors.push(format!(
            "disk_prefix, playlist_path, thumbnail_path and storyboard paths must each be at most {MAX_KEY_LENGTH} characters."
        ));
    }

    if none_or(prefix, |p| {
        payload.playlist_path != format!("{p}{PLAYLIST_FILE}")
    }) {
        errors.push("playlist_path must be disk_prefix + \"playlist.m3u8\".".to_string());
    }

    if let Some(thumbnail) = &payload.thumbnail_path {
        if none_or(prefix, |p| *thumbnail != format!("{p}{THUMBNAIL_FILE}")) {
            errors.push(
                "thumbnail_path must be null or disk_prefix + \"thumbnail.jpg\".".to_string(),
            );
        }
    }

    if let Some(storyboards) = &payload.storyboards {
        let valid = storyboards.iter().all(|(key, entry)| {
            prefix.is_some_and(|p| {
                STORYBOARD_KEYS.contains(&key.as_str())
                    && entry.path == format!("{p}storyboard_{key}.jpg")
            })
        });

        if !valid {
            errors.push(
                "storyboards must be null or contain only 3x3/4x4/5x5 entries with valid paths."
                    .to_string(),
            );
        }
    }

    if let Some(duration) = payload.duration {
        if !(duration.is_finite() && duration >= 0.0) {
            errors.push("duration must be null or a number of at least 0.".to_string());
        }
    }

    if let Some(width) = payload.output_width {
        if !(1..=65535).contains(&width) {
            errors.push("output_width must be null or an integer from 1 to 65535.".to_string());
        }
    }

    if let Some(height) = payload.output_height {
        if !(1..=65535).contains(&height) {
            errors.push("output_height must be null or an integer from 1 to 65535.".to_string());
        }
    }

    if let Some(fps) = payload.output_fps {
        if !(0.0..=999.99).contains(&fps) {
            errors.push("output_fps must be null or a number from 0 to 999.99.".to_string());
        }
    }

    if let Some(bitrate) = payload.output_bitrate_kbps {
        if !(0..=4_294_967_295).contains(&bitrate) {
            errors.push(
                "output_bitrate_kbps must be null or an integer from 0 to 4294967295.".to_string(),
            );
        }
    }

    if let Some(codec) = &payload.output_codec {
        if char_length(codec) > 20 {
            errors.push("output_codec must be null or at most 20 characters.".to_string());
        }
    }

    errors
}

/// `prefix === null || predicate(prefix)`.
fn none_or(prefix: Option<&str>, predicate: impl FnOnce(&str) -> bool) -> bool {
    match prefix {
        None => true,
        Some(value) => predicate(value),
    }
}

// ---- register client ----------------------------------------------------------------------

/// What went wrong calling `POST /api/app/videos`: no HTTP response, or a status (+ error code).
#[derive(Debug, Clone, PartialEq)]
pub enum RegisterFailure {
    Network,
    Http {
        status: u16,
        error_code: Option<String>,
        /// Numeric `Retry-After` header value in seconds (only used for HTTP 429).
        retry_after_seconds: Option<f64>,
    },
}

/// Error a [`RegisterClient`] returns: either no HTTP response or a status (+ error code).
/// Anything that is not a clear HTTP answer is a (retryable) network failure.
#[derive(Debug, Clone, PartialEq)]
pub struct RegisterRequestError {
    pub failure: RegisterFailure,
    pub message: String,
}

impl RegisterRequestError {
    pub fn new(failure: RegisterFailure) -> Self {
        let message = match &failure {
            RegisterFailure::Network => "network error".to_string(),
            RegisterFailure::Http { status, .. } => format!("HTTP {status}"),
        };

        Self { failure, message }
    }

    pub fn with_message(failure: RegisterFailure, message: &str) -> Self {
        Self {
            failure,
            message: message.to_string(),
        }
    }
}

impl fmt::Display for RegisterRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RegisterRequestError {}

/// The site's answer to a successful register.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisteredVideo {
    pub id: i64,
    pub public_id: String,
    pub embed_url: String,
}

/// Calls `POST /api/app/videos`. On failure it MUST return a [`RegisterRequestError`] so
/// [`map_register_error`] can classify it.
#[async_trait::async_trait]
pub trait RegisterClient: Send + Sync {
    async fn register(
        &self,
        payload: &RegisterPayload,
    ) -> Result<RegisteredVideo, RegisterRequestError>;
}

// ---- API error mapping --------------------------------------------------------------------

/// Waits before each retry; 1 first attempt + 5 retries.
pub const REGISTER_RETRY_DELAYS_MS: [u64; 5] = [1000, 2000, 4000, 8000, 16000];

/// Upper bound for a server supplied `Retry-After`, so a bad header cannot stall a job.
pub const MAX_RETRY_AFTER_MS: u64 = 60000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterErrorInfo {
    /// True: retry with backoff (network, 5xx, 429).
    pub retryable: bool,
    /// Wait to use instead of the normal backoff step (429 with a valid Retry-After).
    pub retry_after_ms: Option<u64>,
    /// True only for the server error codes `playlist_not_found` (422) and `public_id_conflict`
    /// (409): the site definitively rejected this video, so the job fails and the R2 objects are
    /// deleted. Other non-retryable answers keep the upload for a later retry.
    pub definitive: bool,
    /// True: keep the job at "Waiting for sign-in" and call register again after sign-in.
    pub needs_sign_in: bool,
    pub user_message: String,
}

fn info(
    retryable: bool,
    definitive: bool,
    needs_sign_in: bool,
    user_message: impl Into<String>,
) -> RegisterErrorInfo {
    RegisterErrorInfo {
        retryable,
        retry_after_ms: None,
        definitive,
        needs_sign_in,
        user_message: user_message.into(),
    }
}

pub fn map_register_error(failure: &RegisterFailure) -> RegisterErrorInfo {
    let (status, error_code, retry_after_seconds) = match failure {
        RegisterFailure::Network => {
            return info(
                true,
                false,
                false,
                "Could not reach the site. Check your internet connection.",
            );
        }
        RegisterFailure::Http {
            status,
            error_code,
            retry_after_seconds,
        } => (*status, error_code.as_deref(), *retry_after_seconds),
    };

    if status == 429 {
        let valid = retry_after_seconds.filter(|s| s.is_finite() && *s >= 0.0);

        return RegisterErrorInfo {
            retry_after_ms: valid.map(|s| ((s * 1000.0).ceil() as u64).min(MAX_RETRY_AFTER_MS)),
            ..info(
                true,
                false,
                false,
                "The site is busy (too many requests). Retrying shortly.",
            )
        };
    }

    if status >= 500 {
        return info(
            true,
            false,
            false,
            if error_code == Some("storage_unavailable") {
                "The site could not reach R2 storage right now."
            } else {
                "The site had a temporary problem. Please try again."
            },
        );
    }

    if status == 401 {
        return info(
            false,
            false,
            true,
            "Your session has expired. Sign in again to finish registering the video.",
        );
    }

    // Only these two server codes prove the video can never be registered as it is.
    if status == 409 && error_code == Some("public_id_conflict") {
        return info(
            false,
            true,
            false,
            "This video ID is already used by a different video. Start the upload again.",
        );
    }

    if status == 422 && error_code == Some("playlist_not_found") {
        return info(
            false,
            true,
            false,
            "The playlist was not found on R2, so the video was not registered.",
        );
    }

    // A generic 409/422 (no known code) may be a validation or proxy problem: keep the upload.
    if status == 409 {
        return info(
            false,
            false,
            false,
            "The site could not register the video because of a conflict.",
        );
    }

    if status == 422 {
        return info(
            false,
            false,
            false,
            "The site rejected the video data as invalid.",
        );
    }

    // Any other 4xx (400, 403, 404, 405, 413, ...) may come from a wrong site URL or a proxy:
    // keep the upload so the user can retry after fixing the configuration.
    info(
        false,
        false,
        false,
        format!(
            "The site rejected the request (HTTP {status}). Check the site settings, then retry."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::probe_parse::EMPTY_OUTPUT_INFO;

    const PREFIX: &str = "2026/03/05/my-video-ab12cd34ef56/";

    fn input() -> BuildRegisterPayloadInput {
        BuildRegisterPayloadInput {
            public_id: "ab12cd34ef56".into(),
            prefix: PREFIX.into(),
            original_filename: "My Video.final.mp4".into(),
            original_size_bytes: 123_456_789,
            duration: Some(61.234),
            has_thumbnail: true,
            storyboard_grids: vec![3, 4, 5],
            output: Some(OutputInfo {
                width: Some(1280),
                height: Some(720),
                fps: Some(29.97003),
                bitrate_kbps: Some(2346),
                codec: Some("h264".into()),
            }),
        }
    }

    fn valid() -> RegisterPayload {
        build_register_payload(&input())
    }

    #[test]
    fn builds_the_exact_body_of_post_api_app_videos() {
        let json = serde_json::to_value(valid()).unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "public_id": "ab12cd34ef56",
                "title": "My Video.final",
                "original_filename": "My Video.final.mp4",
                "original_size_bytes": 123_456_789,
                "disk_prefix": PREFIX,
                "playlist_path": format!("{PREFIX}playlist.m3u8"),
                "thumbnail_path": format!("{PREFIX}thumbnail.jpg"),
                "storyboards": {
                    "3x3": { "path": format!("{PREFIX}storyboard_3x3.jpg") },
                    "4x4": { "path": format!("{PREFIX}storyboard_4x4.jpg") },
                    "5x5": { "path": format!("{PREFIX}storyboard_5x5.jpg") },
                },
                "duration": 61.234,
                "output_width": 1280,
                "output_height": 720,
                "output_fps": 29.97,
                "output_bitrate_kbps": 2346,
                "output_codec": "h264",
            })
        );
    }

    #[test]
    fn json_round_trips_the_persisted_shape() {
        let payload = valid();
        let text = serde_json::to_string(&payload).unwrap();

        assert_eq!(
            serde_json::from_str::<RegisterPayload>(&text).unwrap(),
            payload
        );
    }

    #[test]
    fn uses_null_for_missing_thumbnail_storyboards_duration_and_output_info() {
        let mut bare = input();

        bare.has_thumbnail = false;
        bare.storyboard_grids = vec![];
        bare.duration = None;
        bare.output = None;

        let payload = build_register_payload(&bare);

        assert_eq!(payload.thumbnail_path, None);
        assert_eq!(payload.storyboards, None);
        assert_eq!(payload.duration, None);
        assert_eq!(
            (
                payload.output_width,
                payload.output_height,
                payload.output_fps,
                payload.output_bitrate_kbps,
                payload.output_codec
            ),
            (None, None, None, None, None)
        );

        let mut empty = input();

        empty.output = Some(EMPTY_OUTPUT_INFO);

        assert_eq!(build_register_payload(&empty).output_codec, None);
    }

    #[test]
    fn serializes_storyboards_that_exist_only() {
        let mut four = input();

        four.storyboard_grids = vec![4];

        assert_eq!(
            build_register_payload(&four)
                .storyboards
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["4x4"]
        );
    }

    #[test]
    fn falls_back_to_the_file_name_when_the_base_name_is_empty() {
        let mut hidden = input();

        hidden.original_filename = ".hidden".into();

        assert_eq!(build_register_payload(&hidden).title, ".hidden");
    }

    #[test]
    fn trims_the_title_like_the_server_middleware_would() {
        let mut spaced = input();

        spaced.original_filename = "  spaced  .mp4".into();

        assert_eq!(build_register_payload(&spaced).title, "spaced");
    }

    #[test]
    fn accepts_a_payload_from_build_register_payload() {
        assert_eq!(validate_register_payload(&valid()), Vec::<String>::new());

        let mut bare = input();

        bare.has_thumbnail = false;
        bare.storyboard_grids = vec![];
        bare.duration = None;
        bare.output = None;

        assert_eq!(
            validate_register_payload(&build_register_payload(&bare)),
            Vec::<String>::new()
        );
    }

    #[test]
    fn rejects_each_bad_field() {
        type Mutation = Box<dyn Fn(&mut RegisterPayload)>;

        let entry = |path: String| StoryboardEntry { path };
        let cases: Vec<(&str, Mutation, &str)> = vec![
            (
                "bad public id",
                Box::new(|p| p.public_id = "short".into()),
                "public_id",
            ),
            ("empty title", Box::new(|p| p.title = "  ".into()), "title"),
            (
                "long title",
                Box::new(|p| p.title = "x".repeat(256)),
                "title",
            ),
            (
                "long filename",
                Box::new(|p| p.original_filename = "x".repeat(256)),
                "original_filename",
            ),
            (
                "zero size",
                Box::new(|p| p.original_size_bytes = 0),
                "original_size_bytes",
            ),
            (
                "negative size",
                Box::new(|p| p.original_size_bytes = -5),
                "original_size_bytes",
            ),
            (
                "prefix for another id",
                Box::new(|p| p.disk_prefix = "2026/03/05/x-zzzzzzzzzzzz/".into()),
                "disk_prefix",
            ),
            (
                "wrong playlist path",
                Box::new(|p| p.playlist_path = "other/playlist.m3u8".into()),
                "playlist_path",
            ),
            (
                "wrong thumbnail path",
                Box::new(|p| p.thumbnail_path = Some(format!("{PREFIX}thumb.jpg"))),
                "thumbnail_path",
            ),
            (
                "unknown storyboard key",
                Box::new(move |p| {
                    p.storyboards = Some(BTreeMap::from([(
                        "2x2".to_string(),
                        entry(format!("{PREFIX}storyboard_2x2.jpg")),
                    )]));
                }),
                "storyboards",
            ),
            (
                "wrong storyboard path",
                Box::new(|p| {
                    p.storyboards = Some(BTreeMap::from([(
                        "3x3".to_string(),
                        StoryboardEntry {
                            path: format!("{PREFIX}storyboard_4x4.jpg"),
                        },
                    )]));
                }),
                "storyboards",
            ),
            (
                "negative duration",
                Box::new(|p| p.duration = Some(-1.0)),
                "duration",
            ),
            (
                "NaN duration",
                Box::new(|p| p.duration = Some(f64::NAN)),
                "duration",
            ),
            (
                "zero width",
                Box::new(|p| p.output_width = Some(0)),
                "output_width",
            ),
            (
                "huge height",
                Box::new(|p| p.output_height = Some(70000)),
                "output_height",
            ),
            (
                "fps too high",
                Box::new(|p| p.output_fps = Some(1000.0)),
                "output_fps",
            ),
            (
                "negative bitrate",
                Box::new(|p| p.output_bitrate_kbps = Some(-1)),
                "output_bitrate_kbps",
            ),
            (
                "long codec",
                Box::new(|p| p.output_codec = Some("c".repeat(21))),
                "output_codec",
            ),
        ];

        for (name, mutate, field) in cases {
            let mut payload = valid();

            mutate(&mut payload);

            let errors = validate_register_payload(&payload);

            assert!(!errors.is_empty(), "{name}");
            assert!(
                errors.iter().any(|e| e.contains(field)),
                "{name}: {errors:?}"
            );
        }
    }

    #[test]
    fn accepts_paths_of_exactly_255_characters_and_rejects_256() {
        let id = "ab12cd34ef56";
        // prefix = 11 + slug + 1 + 12 + 1; longest key adds 18 ("storyboard_5x5.jpg").
        let prefix_for =
            |slug_length: usize| format!("2026/03/05/{}-{id}/", "a".repeat(slug_length));
        let build = |slug_length: usize| {
            let mut i = input();

            i.prefix = prefix_for(slug_length);
            build_register_payload(&i)
        };

        // 25 + slug + 18 = 255 -> slug 212 fits; 213 does not.
        assert!(validate_register_payload(&build(212)).is_empty());
        assert!(validate_register_payload(&build(213))
            .join(" ")
            .contains("255 characters"));
        assert!(validate_prefix_length(&prefix_for(212)).is_empty());
        assert!(validate_prefix_length(&prefix_for(213))
            .join(" ")
            .contains("too long"));
    }

    #[test]
    fn rejects_an_over_long_playlist_path() {
        let mut payload = valid();

        payload.playlist_path = format!("{PREFIX}{}", "x".repeat(300));

        assert!(validate_register_payload(&payload)
            .join(" ")
            .contains("at most 255 characters"));
    }

    #[test]
    fn counts_characters_not_bytes_for_the_255_limit() {
        let mut payload = valid();

        payload.title = "Đ".repeat(255);

        assert!(validate_register_payload(&payload).is_empty());
    }

    #[test]
    fn rejects_unknown_fields_when_reading_a_stored_payload() {
        let mut json = serde_json::to_value(valid()).unwrap();

        json["extra"] = serde_json::json!(1);

        assert!(serde_json::from_value::<RegisterPayload>(json).is_err());

        let mut json = serde_json::to_value(valid()).unwrap();

        json["storyboards"]["3x3"]["extra"] = serde_json::json!(1);

        assert!(serde_json::from_value::<RegisterPayload>(json).is_err());
    }

    fn http(status: u16) -> RegisterFailure {
        RegisterFailure::Http {
            status,
            error_code: None,
            retry_after_seconds: None,
        }
    }

    fn http_code(status: u16, code: &str) -> RegisterFailure {
        RegisterFailure::Http {
            status,
            error_code: Some(code.into()),
            retry_after_seconds: None,
        }
    }

    #[test]
    fn retries_network_failures() {
        let result = map_register_error(&RegisterFailure::Network);

        assert!(result.retryable && !result.needs_sign_in && !result.definitive);
    }

    #[test]
    fn retries_5xx() {
        for status in [500, 502, 503, 504] {
            let result = map_register_error(&http(status));

            assert!(result.retryable && !result.needs_sign_in, "{status}");
        }
    }

    #[test]
    fn explains_storage_unavailable() {
        let result = map_register_error(&http_code(503, "storage_unavailable"));

        assert!(result.retryable);
        assert!(result.user_message.contains("R2"));
    }

    #[test]
    fn retries_429_with_the_normal_backoff_when_there_is_no_retry_after() {
        let result = map_register_error(&http(429));

        assert!(result.retryable && !result.needs_sign_in);
        assert_eq!(result.retry_after_ms, None);
    }

    #[test]
    fn honors_a_numeric_retry_after_on_429_capped_at_60_s() {
        let wait = |seconds: Option<f64>| {
            map_register_error(&RegisterFailure::Http {
                status: 429,
                error_code: None,
                retry_after_seconds: seconds,
            })
            .retry_after_ms
        };

        assert_eq!(wait(Some(3.0)), Some(3000));
        assert_eq!(wait(Some(0.5)), Some(500));
        assert_eq!(wait(Some(9999.0)), Some(60000));
        assert_eq!(wait(Some(-1.0)), None);
        assert_eq!(wait(Some(f64::NAN)), None);
        assert_eq!(wait(None), None);
    }

    #[test]
    fn ignores_retry_after_for_other_statuses() {
        let result = map_register_error(&RegisterFailure::Http {
            status: 503,
            error_code: None,
            retry_after_seconds: Some(5.0),
        });

        assert_eq!(result.retry_after_ms, None);
    }

    #[test]
    fn asks_for_sign_in_on_401_without_retrying() {
        let result = map_register_error(&http(401));

        assert!(!result.retryable && result.needs_sign_in);
    }

    #[test]
    fn treats_the_two_known_codes_as_definitive() {
        for (status, code, message) in [
            (409, "public_id_conflict", "different video"),
            (422, "playlist_not_found", "playlist"),
        ] {
            let result = map_register_error(&http_code(status, code));

            assert!(!result.retryable && !result.needs_sign_in && result.definitive);
            assert!(result.user_message.contains(message));
        }
    }

    #[test]
    fn keeps_the_upload_on_a_generic_409_or_422() {
        for (status, code, message) in [
            (409, None, "conflict"),
            (409, Some("something_else"), "conflict"),
            (422, None, "invalid"),
            (422, Some("validation_failed"), "invalid"),
            (422, Some("public_id_conflict"), "invalid"),
            (409, Some("playlist_not_found"), "conflict"),
        ] {
            let result = map_register_error(&RegisterFailure::Http {
                status,
                error_code: code.map(str::to_string),
                retry_after_seconds: None,
            });

            assert!(
                !result.retryable && !result.needs_sign_in && !result.definitive,
                "{status} {code:?}"
            );
            assert!(result.user_message.contains(message), "{status} {code:?}");
        }
    }

    #[test]
    fn keeps_the_upload_on_other_4xx() {
        for status in [400, 403, 404, 405, 413] {
            let result = map_register_error(&http(status));

            assert!(!result.retryable && !result.needs_sign_in && !result.definitive);
            assert!(result.user_message.contains(&format!("HTTP {status}")));
        }
    }

    #[test]
    fn never_marks_retryable_401_or_network_outcomes_as_definitive() {
        assert!(!map_register_error(&RegisterFailure::Network).definitive);
        assert!(!map_register_error(&http(503)).definitive);
        assert!(!map_register_error(&http(429)).definitive);
        assert!(!map_register_error(&http(401)).definitive);
    }

    #[test]
    fn uses_the_1_2_4_8_16_s_backoff() {
        assert_eq!(REGISTER_RETRY_DELAYS_MS, [1000, 2000, 4000, 8000, 16000]);
    }

    #[test]
    fn request_error_messages() {
        assert_eq!(
            RegisterRequestError::new(RegisterFailure::Network).to_string(),
            "network error"
        );
        assert_eq!(RegisterRequestError::new(http(409)).to_string(), "HTTP 409");
    }

    #[test]
    fn js_trim_differs_from_rust_trim_like_javascript() {
        assert_eq!(js_trim("\u{feff} x \u{a0}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    }
}
