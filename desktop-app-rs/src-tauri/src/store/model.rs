//! On-disk document of `store.json` (`AppData` in desktop-app/src/shared/types.ts).
//!
//! The JSON is shared with the Electron app, so field names are camelCase and optional fields are
//! omitted when absent. Unknown fields are kept in `extra` and written back untouched, like the
//! Electron store (which keeps whatever it read). Object-valued fields (error detail, register
//! payload, registered record) stay `serde_json::Value` so a record round-trips byte for byte;
//! the pipeline reads/writes the register payload through the typed accessors below.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};

use crate::dto::JobState;
use crate::pipeline::register::RegisterPayload;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub schema_version: i64,
    pub settings: AppSettings,
    pub jobs: Vec<JobRecord>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Legacy: older builds let the user pick the site; it is kept for the sign-in check.
    pub site_url: String,
    pub tmp_root: String,
    /// Any JSON number is accepted on load (like the Electron validator); see `max_concurrent_u32`.
    pub max_concurrent: Number,
    /// Name of the signed-in user (not a secret).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl AppSettings {
    /// The stored value as the DTO type; anything that is not a `u32` falls back to 1.
    pub fn max_concurrent_u32(&self) -> u32 {
        self.max_concurrent
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobMode {
    Resume,
}

/// `registerPayload` is `undefined | null | object`: keep null and absent apart.
fn present_value<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub source_path: String,
    /// Kept as a JSON number so integers are written back exactly as read.
    pub size_bytes: Number,
    pub state: JobState,
    pub public_id: Option<String>,
    pub prefix: Option<String>,
    pub error_message: Option<String>,
    pub error_detail: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_origin: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub register_payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmp_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub register_started: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<JobMode>,
    pub registered: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl JobRecord {
    /// `registerPayload` as the typed register body (what `resume_upload` / `retry_register`
    /// take). `None` when it is absent, `null` or not a register body.
    pub fn register_payload_typed(&self) -> Option<RegisterPayload> {
        let value = self.register_payload.as_ref().filter(|v| !v.is_null())?;

        serde_json::from_value(value.clone()).ok()
    }

    /// Stores the payload (`None` writes `null`, like the Electron queue's
    /// `registerPayload = null`).
    pub fn set_register_payload(&mut self, payload: Option<&RegisterPayload>) {
        self.register_payload = Some(
            payload
                .and_then(|p| serde_json::to_value(p).ok())
                .unwrap_or(Value::Null),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A job record exactly as the Electron app writes it for an `upload_interrupted` job.
    fn electron_record() -> Value {
        json!({
            "id": "job-1",
            "sourcePath": "C:\\Videos\\clip.mp4",
            "sizeBytes": 5000,
            "state": "upload_interrupted",
            "publicId": "ab12cd34ef56",
            "prefix": "2026/03/05/clip-ab12cd34ef56/",
            "errorMessage": "Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.",
            "errorDetail": null,
            "createdAt": "2026-03-05T10:00:00.000Z",
            "updatedAt": "2026-03-05T10:30:00.000Z",
            "startedAt": "2026-03-05T10:00:01.000Z",
            "finishedAt": "2026-03-05T10:30:00.000Z",
            "siteOrigin": "https://admin.example.com",
            "registerPayload": {
                "public_id": "ab12cd34ef56",
                "title": "clip",
                "original_filename": "clip.mp4",
                "original_size_bytes": 5000,
                "disk_prefix": "2026/03/05/clip-ab12cd34ef56/",
                "playlist_path": "2026/03/05/clip-ab12cd34ef56/playlist.m3u8",
                "thumbnail_path": "2026/03/05/clip-ab12cd34ef56/thumbnail.jpg",
                "storyboards": { "3x3": { "path": "2026/03/05/clip-ab12cd34ef56/storyboard_3x3.jpg" } },
                "duration": 12,
                "output_width": 1280,
                "output_height": 720,
                "output_fps": 30,
                "output_bitrate_kbps": 1500,
                "output_codec": "h264"
            },
            "tmpDir": "C:\\Temp\\hls\\ab12cd34ef56",
            "registered": null
        })
    }

    #[test]
    fn reads_the_resume_state_of_an_electron_record_and_writes_it_back_unchanged() {
        let record: JobRecord = serde_json::from_value(electron_record()).unwrap();
        let payload = record.register_payload_typed().unwrap();

        assert_eq!(payload.public_id, "ab12cd34ef56");
        assert_eq!(payload.duration, Some(12.0));
        assert_eq!(payload.storyboards.as_ref().unwrap().len(), 1);
        assert_eq!(
            record.tmp_dir.as_deref(),
            Some("C:\\Temp\\hls\\ab12cd34ef56")
        );
        assert_eq!(record.state, JobState::UploadInterrupted);
        assert_eq!(serde_json::to_value(&record).unwrap(), electron_record());
    }

    #[test]
    fn a_typed_payload_round_trips_through_the_record() {
        let mut record: JobRecord = serde_json::from_value(electron_record()).unwrap();
        let payload = record.register_payload_typed().unwrap();

        record.set_register_payload(Some(&payload));

        assert_eq!(record.register_payload_typed(), Some(payload));

        record.set_register_payload(None);

        assert_eq!(record.register_payload, Some(Value::Null));
        assert_eq!(record.register_payload_typed(), None);

        record.register_payload = Some(json!({ "not": "a payload" }));

        assert_eq!(record.register_payload_typed(), None);
    }
}
