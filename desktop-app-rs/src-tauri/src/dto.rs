//! Serde mirrors of the DTOs in `src/shared/ipc.ts` and `src/shared/types.ts`.
//!
//! Structs use `rename_all = "camelCase"` and omit optional TS fields (`field?:`) when `None`.
//! TS discriminated unions (`ActionResult`, `SettingsResult`, `PickDirectoryResult`) are
//! serialized by hand so the JSON is exactly what the TS types describe, e.g. `{ok:true}`,
//! `{ok:false,error}`, `{canceled:true}`. Nothing here may carry a secret.

use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};

// ---- auth ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    SignedOut,
    SigningIn,
    SignedIn,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub status: AuthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r2_configured: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persisted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AuthState {
    pub fn signed_out() -> Self {
        Self {
            status: AuthStatus::SignedOut,
            username: None,
            site_url: None,
            r2_configured: None,
            persisted: None,
            error: None,
        }
    }
}

// ---- settings -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    /// Read-only: the site this build is fixed to (empty when the build has none).
    pub site_url: String,
    pub tmp_root: String,
    pub max_concurrent: u32,
}

// ---- result unions ------------------------------------------------------------------------

/// `{ ok: true } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionResult {
    Ok,
    Err(String),
}

impl ActionResult {
    pub fn err(message: impl Into<String>) -> Self {
        Self::Err(message.into())
    }

    pub fn not_implemented() -> Self {
        Self::err("Not implemented yet")
    }
}

impl Serialize for ActionResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ok => {
                let mut s = serializer.serialize_struct("ActionResult", 1)?;
                s.serialize_field("ok", &true)?;
                s.end()
            }
            Self::Err(error) => {
                let mut s = serializer.serialize_struct("ActionResult", 2)?;
                s.serialize_field("ok", &false)?;
                s.serialize_field("error", error)?;
                s.end()
            }
        }
    }
}

/// `{ ok: true; settings: SettingsDto } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsResult {
    Ok(SettingsDto),
    Err(String),
}

impl Serialize for SettingsResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ok(settings) => {
                let mut s = serializer.serialize_struct("SettingsResult", 2)?;
                s.serialize_field("ok", &true)?;
                s.serialize_field("settings", settings)?;
                s.end()
            }
            Self::Err(error) => {
                let mut s = serializer.serialize_struct("SettingsResult", 2)?;
                s.serialize_field("ok", &false)?;
                s.serialize_field("error", error)?;
                s.end()
            }
        }
    }
}

/// `{ canceled: true } | { canceled: false; path: string }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickDirectoryResult {
    Canceled,
    Picked(String),
}

impl Serialize for PickDirectoryResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Canceled => {
                let mut s = serializer.serialize_struct("PickDirectoryResult", 1)?;
                s.serialize_field("canceled", &true)?;
                s.end()
            }
            Self::Picked(path) => {
                let mut s = serializer.serialize_struct("PickDirectoryResult", 2)?;
                s.serialize_field("canceled", &false)?;
                s.serialize_field("path", path)?;
                s.end()
            }
        }
    }
}

// ---- jobs ---------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedFile {
    /// File name only (never the full path).
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddFilesResult {
    pub added: u32,
    pub rejected: Vec<RejectedFile>,
    /// True when the user closed the file dialog without choosing anything.
    pub canceled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Waiting,
    Transcoding,
    Thumbnail,
    Storyboard,
    Uploading,
    Registering,
    Done,
    Failed,
    Cancelled,
    Interrupted,
    RegisterFailed,
    NeedsSignIn,
    UploadInterrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobErrorDetail {
    /// Pipeline step that failed.
    pub step: JobState,
    pub exit_code: Option<i32>,
    /// Last ~200 lines of ffmpeg stderr.
    pub stderr_tail: Vec<String>,
}

/// Renderer-visible job. No file paths, payloads or secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDto {
    pub id: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub state: JobState,
    /// Translation key of the current stage label, e.g. `job.state.uploading`.
    pub stage_key: String,
    /// Overall progress 0-100.
    pub progress: f64,
    pub waiting_reason: Option<String>,
    pub waiting_for_network: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_wait_since: Option<String>,
    pub error_message: Option<String>,
    pub error_detail: Option<JobErrorDetail>,
    /// Numeric id of the video on the site (`registered.id`); set only for a registered job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<i64>,
    /// Public https thumbnail URL of a registered video when Rust already knows it (its link
    /// cache); absent otherwise. Never a local path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub can_cancel: bool,
    pub can_retry: bool,
    pub can_resume: bool,
    pub can_retry_register: bool,
    pub can_remove: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub running: u32,
    pub waiting: u32,
    pub attention: u32,
    pub done: u32,
    pub failed: u32,
    pub total: u32,
    pub blocked_reason: Option<String>,
}

// ---- diagnostics --------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FfmpegDiagnostics {
    /// False while the startup self-check has not finished.
    pub checked: bool,
    pub ok: bool,
    pub version: Option<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsDto {
    pub app_version: String,
    pub platform: String,
    pub ffmpeg: FfmpegDiagnostics,
}

// ---- command payloads (renderer -> Rust) --------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IdPayload {
    pub id: String,
}

/// What `videos:copy-link` copies: a URL or the shortcode built from the video detail fetched
/// by Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoLinkKind {
    EmbedUrl,
    PlaylistUrl,
    Shortcode,
    IframeCode,
    /// The generated thumbnail image URL (the Images card of the detail page).
    ThumbnailUrl,
    /// The custom image URL (the Images card of the detail page).
    CustomImageUrl,
    /// The storage folder (R2 key prefix) of the video, from the cached detail.
    StorageFolder,
    /// One storyboard sprite-sheet URL, by position (0-based) among the detail's storyboards that
    /// have a URL, in the order the detail lists them.
    StoryboardUrl(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AddPathsPayload {
    pub paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    fn settings() -> SettingsDto {
        SettingsDto {
            site_url: "https://a.example".into(),
            tmp_root: String::new(),
            max_concurrent: 1,
        }
    }

    #[test]
    fn action_result_shapes() {
        assert_eq!(to_value(ActionResult::Ok).unwrap(), json!({ "ok": true }));
        assert_eq!(
            to_value(ActionResult::err("boom")).unwrap(),
            json!({ "ok": false, "error": "boom" })
        );
        assert_eq!(
            to_value(ActionResult::not_implemented()).unwrap(),
            json!({ "ok": false, "error": "Not implemented yet" })
        );
    }

    #[test]
    fn settings_result_shapes() {
        assert_eq!(
            to_value(SettingsResult::Ok(settings())).unwrap(),
            json!({ "ok": true, "settings": { "siteUrl": "https://a.example", "tmpRoot": "", "maxConcurrent": 1 } })
        );
        assert_eq!(
            to_value(SettingsResult::Err("bad".into())).unwrap(),
            json!({ "ok": false, "error": "bad" })
        );
    }

    #[test]
    fn pick_directory_result_shapes() {
        assert_eq!(
            to_value(PickDirectoryResult::Canceled).unwrap(),
            json!({ "canceled": true })
        );
        assert_eq!(
            to_value(PickDirectoryResult::Picked("/tmp/x".into())).unwrap(),
            json!({ "canceled": false, "path": "/tmp/x" })
        );
    }

    #[test]
    fn auth_state_omits_absent_optionals_and_uses_camel_case() {
        assert_eq!(
            to_value(AuthState::signed_out()).unwrap(),
            json!({ "status": "signed_out" })
        );

        let state = AuthState {
            status: AuthStatus::SignedIn,
            username: Some("ann".into()),
            site_url: Some("https://a.example".into()),
            r2_configured: Some(true),
            persisted: Some(false),
            error: None,
        };
        assert_eq!(
            to_value(state).unwrap(),
            json!({
                "status": "signed_in", "username": "ann", "siteUrl": "https://a.example",
                "r2Configured": true, "persisted": false
            })
        );
    }

    #[test]
    fn add_files_result_shape() {
        let result = AddFilesResult {
            added: 1,
            rejected: vec![RejectedFile {
                name: "a.txt".into(),
                reason: "Not a video".into(),
            }],
            canceled: false,
        };
        assert_eq!(
            to_value(result).unwrap(),
            json!({ "added": 1, "rejected": [{ "name": "a.txt", "reason": "Not a video" }], "canceled": false })
        );
    }

    #[test]
    fn diagnostics_shape() {
        let dto = DiagnosticsDto {
            app_version: "0.1.0".into(),
            platform: "darwin".into(),
            ffmpeg: FfmpegDiagnostics {
                checked: false,
                ok: false,
                version: None,
                missing: vec![],
            },
        };
        assert_eq!(
            to_value(dto).unwrap(),
            json!({
                "appVersion": "0.1.0", "platform": "darwin",
                "ffmpeg": { "checked": false, "ok": false, "version": null, "missing": [] }
            })
        );
    }

    #[test]
    fn job_dto_shape() {
        let job = JobDto {
            id: "j1".into(),
            file_name: "a.mp4".into(),
            size_bytes: 10,
            state: JobState::UploadInterrupted,
            stage_key: "job.state.upload_interrupted".into(),
            progress: 50.0,
            waiting_reason: None,
            waiting_for_network: false,
            network_wait_since: None,
            error_message: None,
            error_detail: Some(JobErrorDetail {
                step: JobState::Uploading,
                exit_code: None,
                stderr_tail: vec!["x".into()],
            }),
            video_id: None,
            thumbnail_url: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            started_at: None,
            finished_at: None,
            can_cancel: false,
            can_retry: true,
            can_resume: true,
            can_retry_register: false,
            can_remove: true,
        };
        let value = to_value(job).unwrap();
        assert_eq!(value["state"], "upload_interrupted");
        assert_eq!(value["fileName"], "a.mp4");
        assert_eq!(
            value["errorDetail"],
            json!({ "step": "uploading", "exitCode": null, "stderrTail": ["x"] })
        );
        assert!(value.get("networkWaitSince").is_none());
        assert_eq!(value["canRetryRegister"], false);
    }

    #[test]
    fn queue_summary_shape() {
        let summary = QueueSummary {
            running: 1,
            waiting: 2,
            attention: 0,
            done: 3,
            failed: 4,
            total: 10,
            blocked_reason: None,
        };
        assert_eq!(
            to_value(summary).unwrap(),
            json!({ "running": 1, "waiting": 2, "attention": 0, "done": 3, "failed": 4, "total": 10, "blockedReason": null })
        );
    }

    #[test]
    fn payloads_deserialize_from_renderer_json() {
        let paths: AddPathsPayload = serde_json::from_value(json!({ "paths": ["/a"] })).unwrap();
        assert_eq!(paths.paths, vec!["/a".to_string()]);
    }
}
