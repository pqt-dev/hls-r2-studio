//! Cloud video library DTOs: `GET /api/app/videos` (list) and `GET /api/app/videos/{id}`
//! (detail). See docs/DESKTOP-APP-API.md and `Api\App\VideoController`.
//!
//! The same types parse the site's snake_case JSON and serialize camelCase for the renderer.
//! Unknown extra fields are ignored. Nothing from the site is trusted: every string is
//! length-capped and every URL must be `https://` (anything else becomes `None`) in `sanitize`.

use std::collections::BTreeMap;

/// Server-side order of the video list (`sort` query parameter of `GET /api/app/videos`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoSort {
    #[default]
    Newest,
    Oldest,
    TitleAsc,
    TitleDesc,
    DurationDesc,
    SizeDesc,
}

/// Accepted values of the `status` filter of the video list (same whitelist as the site).
pub const STATUS_FILTERS: &[&str] = &["pending", "processing", "ready", "failed"];

impl VideoSort {
    /// The whitelist shared with the renderer (`VIDEO_SORTS` in ipc.ts) and the site.
    pub const ALLOWED: &'static [&'static str] = &[
        "newest",
        "oldest",
        "title_asc",
        "title_desc",
        "duration_desc",
        "size_desc",
    ];

    pub fn as_param(self) -> &'static str {
        match self {
            Self::Newest => "newest",
            Self::Oldest => "oldest",
            Self::TitleAsc => "title_asc",
            Self::TitleDesc => "title_desc",
            Self::DurationDesc => "duration_desc",
            Self::SizeDesc => "size_desc",
        }
    }

    pub fn from_param(text: &str) -> Option<Self> {
        Some(match text {
            "newest" => Self::Newest,
            "oldest" => Self::Oldest,
            "title_asc" => Self::TitleAsc,
            "title_desc" => Self::TitleDesc,
            "duration_desc" => Self::DurationDesc,
            "size_desc" => Self::SizeDesc,
            _ => return None,
        })
    }
}

use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;

/// Largest `per_page` of `GET /api/app/videos`. The site validates `per_page` to 1..=50
/// (`Api\App\VideoController`) and answers HTTP 422 beyond it. This is the single definition of
/// the limit: `SiteClient::list_videos` enforces it, callers never hardcode it.
pub const MAX_VIDEOS_PER_PAGE: u32 = 50;
/// The API never returns more than `MAX_VIDEOS_PER_PAGE` items per page.
pub const MAX_LIST_ITEMS: usize = MAX_VIDEOS_PER_PAGE as usize;

const MAX_SHORT: usize = 64;
const MAX_TEXT: usize = 512;
const MAX_URL: usize = 2048;
const MAX_STORYBOARDS: usize = 8;

/// `pending`, `processing`, `ready`, `failed`; any other word is kept as `Unknown`, so a status
/// added by the site later never breaks the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStatus {
    Pending,
    Processing,
    Ready,
    Failed,
    Unknown(String),
}

impl VideoStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Unknown(other) => other,
        }
    }
}

impl<'de> Deserialize<'de> for VideoStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;

        Ok(match text.as_str() {
            "pending" => Self::Pending,
            "processing" => Self::Processing,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            _ => Self::Unknown(cap_text(text, MAX_SHORT)),
        })
    }
}

impl Serialize for VideoStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// An empty PHP array is encoded as `[]` instead of `{}`: both mean "no entries".
fn map_or_empty_list<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    // The list and null variants only swallow the value.
    #[allow(dead_code)]
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum MapOrList<T> {
        Map(BTreeMap<String, T>),
        List(Vec<IgnoredAny>),
        Nothing(()),
    }

    Ok(match MapOrList::<T>::deserialize(deserializer)? {
        MapOrList::Map(map) => map,
        MapOrList::List(_) | MapOrList::Nothing(()) => BTreeMap::new(),
    })
}

pub(crate) fn cap_text(mut text: String, max_chars: usize) -> String {
    if let Some((index, _)) = text.char_indices().nth(max_chars) {
        text.truncate(index);
    }

    text
}

fn cap_opt(value: &mut Option<String>, max_chars: usize) {
    if let Some(text) = value.take() {
        *value = Some(cap_text(text, max_chars));
    }
}

/// Normalises a storage folder (R2 key prefix) from the site: a relative key without a leading
/// slash, backslash, `.` / `..` segment, control character or empty segment, at most `MAX_TEXT`
/// bytes, with exactly one trailing slash. Anything else is `None`.
pub(crate) fn normalize_storage_folder(raw: &str) -> Option<String> {
    let trimmed = raw.trim_end_matches('/');

    if trimmed.is_empty()
        || raw.len() > MAX_TEXT
        || trimmed.starts_with('/')
        || trimmed
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '\\' | '?' | '#'))
        || trimmed
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }

    Some(format!("{trimmed}/"))
}

/// Keeps only an absolute `https://` URL of sane length.
pub(crate) fn clean_url(value: &mut Option<String>) {
    let keep = value
        .as_deref()
        .is_some_and(|text| text.len() <= MAX_URL && Url::parse(text).is_ok_and(is_https));

    if !keep {
        *value = None;
    }
}

fn is_https(url: Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some()
}

/// Builds a public https URL from the R2 public base URL and an object path of the site.
/// `None` when the base is not `https://` or the path is unsafe: empty, a backslash, `?`, `#`,
/// a control character, a leading `//` or scheme (`http:`), or a `.` / `..` segment. Empty
/// segments (leading, trailing or doubled slashes) are dropped and each segment is
/// percent-encoded.
pub fn build_public_url(base: &str, path: &str) -> Option<String> {
    if path.is_empty()
        || path.len() > MAX_TEXT
        || path.starts_with("//")
        || path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | '?' | '#'))
    {
        return None;
    }

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if segments.is_empty()
        || segments.iter().any(|s| *s == "." || *s == "..")
        || segments.first().is_some_and(|s| has_scheme(s))
    {
        return None;
    }

    let mut url = Url::parse(base).ok().filter(|u| is_https(u.clone()))?;

    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(segments);

    let text: String = url.into();

    (text.len() <= MAX_URL).then_some(text)
}

/// `name:` at the start of the first segment (`http:foo`, `javascript:x`).
fn has_scheme(segment: &str) -> bool {
    segment.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    })
}

/// `meta` of the list answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct VideoListMeta {
    pub page: u32,
    pub per_page: u32,
    pub total: u64,
    pub last_page: u32,
}

/// `{ path }` of a storyboard in a list item (an object key, not a URL). Internal: never
/// serialized, so the paths cannot reach the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StoryboardPath {
    #[serde(default)]
    pub path: Option<String>,
}

/// One row of the list as the site sends it. The list carries storage paths (not URLs) for the
/// files. Internal: it has no `Serialize`; the renderer gets `VideoListItemDto` (ipc/videos.rs).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct VideoListItem {
    pub id: i64,
    pub public_id: String,
    pub title: String,
    #[serde(default)]
    pub original_filename: Option<String>,
    #[serde(default)]
    pub original_size_bytes: Option<u64>,
    pub status: VideoStatus,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub output_width: Option<u32>,
    #[serde(default)]
    pub output_height: Option<u32>,
    /// Frames per second of the output (the site stores a decimal).
    #[serde(default)]
    pub output_fps: Option<f64>,
    /// Video bitrate of the output in kilobits per second (`videos.output_bitrate_kbps`).
    #[serde(default)]
    pub output_bitrate_kbps: Option<u64>,
    #[serde(default)]
    pub output_codec: Option<String>,
    #[serde(default)]
    pub disk_prefix: Option<String>,
    #[serde(default)]
    pub playlist_path: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    #[serde(default)]
    pub custom_image_path: Option<String>,
    /// Storyboard grid key (`3x3`...) to its storage path.
    #[serde(default, deserialize_with = "map_or_empty_list")]
    pub storyboards: BTreeMap<String, StoryboardPath>,
    #[serde(default)]
    pub embed_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl VideoListItem {
    fn sanitize(&mut self) {
        self.public_id = cap_text(std::mem::take(&mut self.public_id), MAX_SHORT);
        self.title = cap_text(std::mem::take(&mut self.title), MAX_TEXT);
        cap_opt(&mut self.original_filename, MAX_TEXT);
        cap_opt(&mut self.output_codec, MAX_SHORT);
        cap_opt(&mut self.disk_prefix, MAX_TEXT);
        cap_opt(&mut self.playlist_path, MAX_TEXT);
        cap_opt(&mut self.thumbnail_path, MAX_TEXT);
        cap_opt(&mut self.custom_image_path, MAX_TEXT);
        cap_opt(&mut self.created_at, MAX_SHORT);
        clean_url(&mut self.embed_url);
        retain_storyboards(&mut self.storyboards, |entry| {
            cap_opt(&mut entry.path, MAX_TEXT);
        });
    }
}

fn retain_storyboards<T>(map: &mut BTreeMap<String, T>, mut each: impl FnMut(&mut T)) {
    let mut kept = BTreeMap::new();

    for (key, mut entry) in std::mem::take(map) {
        if kept.len() >= MAX_STORYBOARDS {
            break;
        }

        each(&mut entry);
        kept.insert(cap_text(key, MAX_SHORT), entry);
    }

    *map = kept;
}

/// The list answer: `{ data: [...], meta: {...} }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VideoPage {
    pub data: Vec<VideoListItem>,
    pub meta: VideoListMeta,
}

impl VideoPage {
    /// Caps strings; the item count is checked by the caller (`MAX_LIST_ITEMS`).
    pub fn sanitize(&mut self) {
        self.data.iter_mut().for_each(VideoListItem::sanitize);
    }
}

/// `error` of a failed video; `detail` is already sanitized by the site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct VideoError {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub failed_at: Option<String>,
}

/// A generated storyboard grid of the detail (`url` is a public https URL).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Storyboard {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub columns: Option<u32>,
    #[serde(default)]
    pub count: Option<u32>,
}

/// The grid the embed player uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbedStoryboard {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// `GET /api/app/videos/{id}`. The URL fields are `None` when the file does not exist or R2 is
/// not configured on the site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct VideoDetail {
    pub id: i64,
    pub public_id: String,
    pub title: String,
    #[serde(default)]
    pub original_filename: Option<String>,
    #[serde(default)]
    pub original_size_bytes: Option<u64>,
    pub status: VideoStatus,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub progress: Option<u32>,
    /// Set only when `status` is `failed`.
    #[serde(default)]
    pub error: Option<VideoError>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub output_width: Option<u32>,
    #[serde(default)]
    pub output_height: Option<u32>,
    #[serde(default)]
    pub output_fps: Option<f64>,
    #[serde(default)]
    pub output_bitrate_kbps: Option<u64>,
    #[serde(default)]
    pub output_codec: Option<String>,
    /// Storage folder (R2 key prefix, e.g. `2026/11/18/<slug>-<id>/`) of the video's files: path
    /// only, never a URL. The site sends it as `disk_prefix` (older sites omit it); the renderer
    /// gets it as `storageFolder`. Normalised by `normalize_storage_folder` in `sanitize`.
    #[serde(
        default,
        rename(deserialize = "disk_prefix", serialize = "storageFolder")
    )]
    pub storage_folder: Option<String>,
    #[serde(default)]
    pub embed_url: Option<String>,
    #[serde(default)]
    pub playlist_url: Option<String>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub has_custom_image: bool,
    #[serde(default)]
    pub custom_image_url: Option<String>,
    /// Storyboard grid key (`3x3`...) to its grid.
    #[serde(default, deserialize_with = "map_or_empty_list")]
    pub storyboards: BTreeMap<String, Storyboard>,
    #[serde(default)]
    pub embed_storyboard: Option<EmbedStoryboard>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Ready-made `[hls_embed_vl id="..."]` and iframe snippet shown on the detail page. Not part
    /// of the site's answer: Rust fills them (same builders and checks as the Copy buttons) before
    /// the detail goes to the renderer, which only displays them.
    #[serde(default, skip_deserializing)]
    pub shortcode: Option<String>,
    #[serde(default, skip_deserializing)]
    pub iframe_code: Option<String>,
}

impl VideoDetail {
    pub fn sanitize(&mut self) {
        self.public_id = cap_text(std::mem::take(&mut self.public_id), MAX_SHORT);
        self.title = cap_text(std::mem::take(&mut self.title), MAX_TEXT);
        cap_opt(&mut self.original_filename, MAX_TEXT);
        cap_opt(&mut self.stage, MAX_SHORT);
        cap_opt(&mut self.output_codec, MAX_SHORT);
        cap_opt(&mut self.created_at, MAX_SHORT);
        cap_opt(&mut self.updated_at, MAX_SHORT);

        if let Some(error) = &mut self.error {
            cap_opt(&mut error.message, MAX_TEXT);
            cap_opt(&mut error.detail, 4096);
            cap_opt(&mut error.failed_at, MAX_SHORT);
        }

        self.storage_folder = self
            .storage_folder
            .take()
            .and_then(|folder| normalize_storage_folder(&folder));
        clean_url(&mut self.embed_url);
        clean_url(&mut self.playlist_url);
        clean_url(&mut self.thumbnail_url);
        clean_url(&mut self.custom_image_url);
        retain_storyboards(&mut self.storyboards, |entry| clean_url(&mut entry.url));

        if let Some(grid) = &mut self.embed_storyboard {
            clean_url(&mut grid.url);
        }
    }
}

/// The site accepts titles of 1..=255 characters (Laravel counts characters, not bytes).
pub const MAX_TITLE_CHARS: usize = 255;
/// `DELETE /api/app/videos/bulk-destroy` takes 1..=100 ids.
pub const MAX_BULK_DELETE: usize = 100;
const MAX_DELETE_MESSAGE: usize = 300;

pub const TITLE_REQUIRED: &str = "Title is required.";
pub const TITLE_TOO_LONG: &str = "Title is too long (255 characters at most).";
pub const TITLE_INVALID: &str = "Title is invalid.";

/// Trims the title and checks it the way the site does: not empty, at most 255 characters, and
/// no control characters. Returns the text to send, or a safe English message.
pub fn normalize_video_title(raw: &str) -> Result<String, &'static str> {
    let title = raw.trim();

    if title.is_empty() {
        return Err(TITLE_REQUIRED);
    }

    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(TITLE_TOO_LONG);
    }

    if title.chars().any(char::is_control) {
        return Err(TITLE_INVALID);
    }

    Ok(title.to_string())
}

/// Server text shown to the user: control characters dropped, trimmed and length-capped.
fn clean_message(raw: &str) -> String {
    let text: String = raw.chars().filter(|c| !c.is_control()).collect();

    cap_text(text.trim().to_string(), MAX_DELETE_MESSAGE)
}

/// Outcome of `DELETE /api/app/videos/{id}` (HTTP 200 in all three cases).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeleteStatus {
    Deleted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoDeleteOutcome {
    pub status: DeleteStatus,
    /// Sanitized, length-capped server message (never empty).
    pub message: String,
}

impl VideoDeleteOutcome {
    /// `None` when `status` is missing or not one of `deleted|skipped|failed`.
    pub fn parse(body: &serde_json::Value) -> Option<Self> {
        let status = match body.get("status")?.as_str()? {
            "deleted" => DeleteStatus::Deleted,
            "skipped" => DeleteStatus::Skipped,
            "failed" => DeleteStatus::Failed,
            _ => return None,
        };
        let message = body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(clean_message)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| {
                match status {
                    DeleteStatus::Deleted => "Video has been deleted.",
                    DeleteStatus::Skipped => "The video is still processing.",
                    DeleteStatus::Failed => "The video could not be deleted.",
                }
                .to_string()
            });

        Some(Self { status, message })
    }
}

/// Outcome of `DELETE /api/app/videos/bulk-destroy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkDeleteOutcome {
    pub deleted: u32,
    pub failed: u32,
    pub skipped: u32,
    /// Sanitized, length-capped server message (never empty).
    pub message: String,
}

impl BulkDeleteOutcome {
    /// `None` when a count is missing or not a small non-negative integer.
    pub fn parse(body: &serde_json::Value) -> Option<Self> {
        let count = |key: &str| {
            body.get(key)?
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n <= 1_000_000)
        };
        let (deleted, failed, skipped) = (count("deleted")?, count("failed")?, count("skipped")?);
        let message = body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(clean_message)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| format!("Deleted {deleted}, failed {failed}, skipped {skipped}."));

        Some(Self {
            deleted,
            failed,
            skipped,
            message,
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn storage_folder_is_normalised_to_a_relative_key_with_one_trailing_slash() {
        let ok = "2026/11/18/chintai-630-evidence-ios-54a51fhqca77/";

        assert_eq!(normalize_storage_folder(ok).as_deref(), Some(ok));
        assert_eq!(
            normalize_storage_folder("2026/11/18/clip-abc").as_deref(),
            Some("2026/11/18/clip-abc/")
        );
        assert_eq!(
            normalize_storage_folder("2026/11/18/clip-abc///").as_deref(),
            Some("2026/11/18/clip-abc/")
        );

        let too_long = format!("a/{}", "x".repeat(MAX_TEXT));

        for bad in [
            "",
            "/",
            "/2026/11/18/clip/",
            "../x/",
            "a/../b/",
            "a/./b/",
            "a//b/",
            "a\\b/",
            "a/b\n/",
            "a/b\u{7}/",
            "a b/",
            "a/b?x/",
            too_long.as_str(),
        ] {
            assert_eq!(normalize_storage_folder(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn detail_reads_disk_prefix_as_storage_folder_and_older_sites_give_none() {
        let base =
            serde_json::json!({ "id": 1, "public_id": "abc", "title": "T", "status": "ready" });
        let mut with = base.clone();

        with["disk_prefix"] = serde_json::json!("2026/11/18/clip-abc");

        let mut detail: VideoDetail = serde_json::from_value(with).unwrap();

        detail.sanitize();
        assert_eq!(
            detail.storage_folder.as_deref(),
            Some("2026/11/18/clip-abc/")
        );

        let mut unsafe_folder = base.clone();

        unsafe_folder["disk_prefix"] = serde_json::json!("/etc/../x");

        let mut detail: VideoDetail = serde_json::from_value(unsafe_folder).unwrap();

        detail.sanitize();
        assert_eq!(detail.storage_folder, None);

        let mut older: VideoDetail = serde_json::from_value(base).unwrap();

        older.sanitize();
        assert_eq!(older.storage_folder, None);
        assert!(serde_json::to_value(&older).unwrap()["storageFolder"].is_null());
    }

    use super::*;

    const BASE: &str = "https://cdn.example.com";

    #[test]
    fn builds_a_plain_url() {
        assert_eq!(
            build_public_url(BASE, "videos/abc/thumb.jpg").as_deref(),
            Some("https://cdn.example.com/videos/abc/thumb.jpg")
        );
    }

    #[test]
    fn joins_without_double_slashes() {
        for (base, path) in [
            ("https://cdn.example.com/", "/videos/a.jpg"),
            ("https://cdn.example.com/", "videos/a.jpg"),
            ("https://cdn.example.com", "/videos//a.jpg"),
        ] {
            assert_eq!(
                build_public_url(base, path).as_deref(),
                Some("https://cdn.example.com/videos/a.jpg"),
                "{base} + {path}"
            );
        }

        assert_eq!(
            build_public_url("https://cdn.example.com/media/", "a/b.jpg").as_deref(),
            Some("https://cdn.example.com/media/a/b.jpg")
        );
        assert_eq!(
            build_public_url("https://cdn.example.com/?x=1#f", "a.jpg").as_deref(),
            Some("https://cdn.example.com/a.jpg")
        );
    }

    #[test]
    fn encodes_each_segment() {
        assert_eq!(
            build_public_url(BASE, "my videos/a b.jpg").as_deref(),
            Some("https://cdn.example.com/my%20videos/a%20b.jpg")
        );
        assert_eq!(
            build_public_url(BASE, "v/\u{0111}\u{1ED9}.jpg").as_deref(),
            Some("https://cdn.example.com/v/%C4%91%E1%BB%99.jpg")
        );
        assert_eq!(
            build_public_url(BASE, "v/100%.jpg").as_deref(),
            Some("https://cdn.example.com/v/100%25.jpg")
        );
    }

    #[test]
    fn rejects_unsafe_paths() {
        for path in [
            "",
            "/",
            "../secret.jpg",
            "a/../b.jpg",
            "a/./b.jpg",
            "a\\b.jpg",
            "a.jpg?x=1",
            "a.jpg#frag",
            "a\u{0}b.jpg",
            "a\nb.jpg",
            "//evil.example.com/a.jpg",
            "http://evil.example.com/a.jpg",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
        ] {
            assert_eq!(build_public_url(BASE, path), None, "{path:?}");
        }
    }

    #[test]
    fn rejects_a_base_that_is_not_https() {
        for base in [
            "http://cdn.example.com",
            "ftp://cdn.example.com",
            "cdn.example.com",
            "",
            "https://",
        ] {
            assert_eq!(build_public_url(base, "a.jpg"), None, "{base:?}");
        }
    }
}
