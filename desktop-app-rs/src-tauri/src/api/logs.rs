//! `GET /api/app/logs`: the web Logs page as JSON (summary or one paginated type). See
//! docs/DESKTOP-APP-API.md.
//!
//! Unknown extra fields are ignored and an unknown `status` word is kept as `Unknown`. Nothing
//! from the site is trusted: every string is control-character-stripped and length-capped in
//! `sanitize` (`error_detail` keeps its line breaks and tabs, the only control characters that
//! are allowed). The renderer must show all of it as plain text.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::videos::{cap_text, VideoListMeta, VideoStatus, MAX_LIST_ITEMS};

const MAX_SHORT: usize = 64;
const MAX_TITLE: usize = 255;
const MAX_MESSAGE: usize = 2000;

/// The `type` filter of the paginated shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogType {
    Success,
    Error,
    Processing,
}

impl LogType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Processing => "processing",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "success" => Some(Self::Success),
            "error" => Some(Self::Error),
            "processing" => Some(Self::Processing),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogCounts {
    pub total: u64,
    pub success: u64,
    pub error: u64,
    pub processing: u64,
}

/// Progress as a whole percent 0..=100 (the site may send a float or an out-of-range number).
fn lenient_progress<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;

    Ok(value
        .and_then(|value| value.as_f64())
        .filter(|n| n.is_finite())
        .map(|n| n.round().clamp(0.0, 100.0) as u32))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "snake_case", serialize = "camelCase"))]
pub struct LogItem {
    pub id: i64,
    pub public_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub original_filename: Option<String>,
    pub status: VideoStatus,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default, deserialize_with = "lenient_progress")]
    pub progress: Option<u32>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub error_detail: Option<String>,
    #[serde(default)]
    pub failed_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Drops control characters (keeping `\n` and `\t` when `multiline`), then caps the length.
fn clean(text: String, max_chars: usize, multiline: bool) -> String {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() || (multiline && matches!(c, '\n' | '\t')))
        .collect();

    cap_text(text, max_chars)
}

fn clean_opt(value: &mut Option<String>, max_chars: usize, multiline: bool) {
    if let Some(text) = value.take() {
        *value = Some(clean(text, max_chars, multiline));
    }
}

impl LogItem {
    fn sanitize(&mut self) {
        self.public_id = clean(std::mem::take(&mut self.public_id), MAX_SHORT, false);
        self.title = clean(std::mem::take(&mut self.title), MAX_TITLE, false);
        clean_opt(&mut self.original_filename, MAX_TITLE, false);
        clean_opt(&mut self.stage, MAX_SHORT, false);
        clean_opt(&mut self.error_message, MAX_MESSAGE, false);
        clean_opt(&mut self.error_detail, MAX_MESSAGE, true);
        clean_opt(&mut self.failed_at, MAX_SHORT, false);
        clean_opt(&mut self.created_at, MAX_SHORT, false);
        clean_opt(&mut self.updated_at, MAX_SHORT, false);

        if let VideoStatus::Unknown(word) = &mut self.status {
            *word = clean(std::mem::take(word), MAX_SHORT, false);
        }
    }
}

fn sanitize_all(items: &mut [LogItem]) {
    items.iter_mut().for_each(LogItem::sanitize);
}

/// Without `type`: `{ counts, success[], error[], processing[] }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogsSummary {
    pub counts: LogCounts,
    pub success: Vec<LogItem>,
    pub error: Vec<LogItem>,
    pub processing: Vec<LogItem>,
}

impl LogsSummary {
    /// `false` when an array is longer than the API ever sends.
    pub fn within_limits(&self) -> bool {
        [&self.success, &self.error, &self.processing]
            .iter()
            .all(|items| items.len() <= MAX_LIST_ITEMS)
    }

    pub fn sanitize(&mut self) {
        sanitize_all(&mut self.success);
        sanitize_all(&mut self.error);
        sanitize_all(&mut self.processing);
    }
}

/// With `type`: `{ counts, data[], meta }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogsPage {
    pub counts: LogCounts,
    pub data: Vec<LogItem>,
    pub meta: VideoListMeta,
}

impl LogsPage {
    pub fn within_limits(&self) -> bool {
        self.data.len() <= MAX_LIST_ITEMS
    }

    pub fn sanitize(&mut self) {
        sanitize_all(&mut self.data);
    }
}

/// The parsed answer: the shape follows the requested `type`.
#[derive(Debug, Clone, PartialEq)]
pub enum LogsReply {
    Summary(LogsSummary),
    Page(LogsPage),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn log_type_round_trips_known_words_only() {
        for kind in [LogType::Success, LogType::Error, LogType::Processing] {
            assert_eq!(LogType::parse(kind.as_str()), Some(kind));
        }

        assert_eq!(LogType::parse("x"), None);
        assert_eq!(LogType::parse("Success"), None);
    }

    #[test]
    fn items_sanitize_strings_and_progress() {
        let mut item: LogItem = serde_json::from_value(json!({
            "id": 1, "public_id": "abc", "title": "a\u{0}b\nc",
            "status": "weird", "progress": 250.4, "stage": "x".repeat(100),
            "error_detail": format!("l1\n\tl2\u{7}{}", "d".repeat(3000)),
            "error_message": "m\u{1b}[31m", "unknown_field": 1
        }))
        .unwrap();

        item.sanitize();

        assert_eq!(item.title, "abc");
        assert_eq!(item.progress, Some(100));
        assert_eq!(item.stage.as_deref().map(str::len), Some(64));
        assert_eq!(item.error_message.as_deref(), Some("m[31m"));

        let detail = item.error_detail.unwrap();

        assert!(detail.starts_with("l1\n\tl2d"));
        assert_eq!(detail.chars().count(), 2000);
        assert_eq!(item.status, VideoStatus::Unknown("weird".into()));
    }
}
