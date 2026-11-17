//! Cloud video library DTOs: `GET /api/app/videos` (list) and `GET /api/app/videos/{id}`
//! (detail). See docs/DESKTOP-APP-API.md and `Api\App\VideoController`.
//!
//! The same types parse the site's snake_case JSON and serialize camelCase for the renderer.
//! Unknown extra fields are ignored. Nothing from the site is trusted: every string is
//! length-capped and every URL must be `https://` (anything else becomes `None`) in `sanitize`.

use std::collections::BTreeMap;

use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;

/// The API never returns more than 50 items per page.
pub const MAX_LIST_ITEMS: usize = 50;

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

fn cap_text(mut text: String, max_chars: usize) -> String {
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

/// Keeps only an absolute `https://` URL of sane length.
fn clean_url(value: &mut Option<String>) {
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

#[cfg(test)]
mod tests {
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
