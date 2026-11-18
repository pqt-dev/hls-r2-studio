//! `GET /api/app/overview`: the numbers of the web dashboard (the video counts).
//! See docs/DESKTOP-APP-API.md.
//!
//! Parsing is tolerant and manual: unknown fields (such as the `system` object the site may still
//! send) are ignored. The video counts are required: a missing or invalid count makes the whole
//! answer invalid.

use serde::Serialize;
use serde_json::Value;

/// Counts above this are not plausible; they are treated as invalid.
const MAX_COUNT: u64 = 1_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct VideoCounts {
    pub total: u64,
    pub ready: u64,
    pub processing: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Overview {
    pub videos: VideoCounts,
}

fn count(object: &Value, key: &str) -> Option<u64> {
    object
        .get(key)?
        .as_u64()
        .filter(|number| *number <= MAX_COUNT)
}

impl Overview {
    /// `None` when `videos` or one of its four counts is missing or not a non-negative integer.
    pub fn parse(body: &Value) -> Option<Self> {
        let videos = body.get("videos")?;

        Some(Self {
            videos: VideoCounts {
                total: count(videos, "total")?,
                ready: count(videos, "ready")?,
                processing: count(videos, "processing")?,
                failed: count(videos, "failed")?,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_the_documented_answer() {
        let overview = Overview::parse(&json!({
            "videos": { "total": 5, "ready": 2, "processing": 2, "failed": 1, "extra": 1 },
        }))
        .unwrap();

        assert_eq!(overview.videos.total, 5);
        assert_eq!(overview.videos.failed, 1);
        assert_eq!(overview.videos.ready, 2);
        assert_eq!(overview.videos.processing, 2);
    }

    #[test]
    fn rejects_missing_or_invalid_counts() {
        for body in [
            json!({}),
            json!({ "videos": null }),
            json!({ "videos": { "total": 1, "ready": 1, "processing": 0 } }),
            json!({ "videos": { "total": -1, "ready": 1, "processing": 0, "failed": 0 } }),
            json!({ "videos": { "total": 1.5, "ready": 1, "processing": 0, "failed": 0 } }),
            json!({ "videos": { "total": "1", "ready": 1, "processing": 0, "failed": 0 } }),
        ] {
            assert_eq!(Overview::parse(&body), None, "{body}");
        }
    }

    #[test]
    fn unknown_fields_including_system_are_ignored() {
        let videos = json!({ "total": 0, "ready": 0, "processing": 0, "failed": 0 });

        for system in [
            json!(null),
            json!("x"),
            json!([1]),
            json!({ "cpu_percent": 12 }),
        ] {
            let body = json!({ "videos": videos, "system": system, "future": true });
            let overview = Overview::parse(&body).unwrap();

            assert_eq!(overview.videos.total, 0);
            assert!(serde_json::to_value(&overview)
                .unwrap()
                .get("system")
                .is_none());
        }
    }

    #[test]
    fn serializes_only_the_counts() {
        let overview = Overview::parse(&json!({
            "videos": { "total": 1, "ready": 1, "processing": 0, "failed": 0 },
            "system": { "cpu_percent": 1, "ram_used_gb": 2 }
        }))
        .unwrap();
        let value = serde_json::to_value(&overview).unwrap();

        assert_eq!(
            value,
            json!({ "videos": { "total": 1, "ready": 1, "processing": 0, "failed": 0 } })
        );
    }
}
