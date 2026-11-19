//! Maps a stored job to the renderer-visible DTO (port of desktop-app/src/main/queue/jobDto.ts).
//! Nothing here may leak a path, a register payload, a prefix or a secret: only the file NAME,
//! the state, the public id / embed URL of a registered video and the (already scrubbed)
//! error detail.

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::Value;

use super::file_validation::PathStyle;
use super::states::{
    is_attention_state, is_final_state, is_paused_upload, is_retryable_state, stage_key,
};
use crate::desktop::safe_https_url;
use crate::dto::{JobDto, JobErrorDetail, JobState};
use crate::store::JobRecord;

/// What the queue knows about a job besides the store (RAM only).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobRuntimeInfo {
    /// A pipeline, register or resume call is in flight for this job.
    pub running: bool,
    pub cancel_requested: bool,
    /// Latest overall progress, `None` when unknown.
    pub progress: Option<u32>,
    pub waiting_reason: Option<String>,
    /// The upload is retrying because the network is down.
    pub waiting_for_network: bool,
    /// Epoch ms the current outage started.
    pub network_wait_since: Option<i64>,
    /// Thumbnail URL Rust remembers for the job's video (link cache); validated before it is
    /// put on the DTO.
    pub thumbnail_url: Option<String>,
}

/// True when the record holds a usable register payload (`Boolean(job.registerPayload)`; a
/// stored value that is not a valid register body counts as absent, so no action that needs it
/// is offered).
pub fn has_register_payload(job: &JobRecord) -> bool {
    job.register_payload_typed().is_some()
}

/// `registered.embed_url` / `registered.public_id` of a done job.
pub fn registered_field<'a>(job: &'a JobRecord, field: &str) -> Option<&'a str> {
    job.registered.as_ref()?.get(field)?.as_str()
}

/// `registered.id` (the site's numeric video id) of a done job, when it is a positive integer.
pub fn registered_video_id(job: &JobRecord) -> Option<i64> {
    job.registered
        .as_ref()?
        .get("id")?
        .as_i64()
        .filter(|id| *id > 0)
}

/// Progress shown for jobs that have no live value (e.g. after a restart).
fn fallback_progress(state: JobState) -> u32 {
    if state == JobState::Done {
        100
    } else if is_attention_state(state) {
        98
    } else {
        0
    }
}

fn size_of(job: &JobRecord) -> u64 {
    job.size_bytes
        .as_u64()
        .or_else(|| {
            job.size_bytes
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n.round() as u64)
        })
        .unwrap_or(0)
}

fn error_detail_of(job: &JobRecord) -> Option<JobErrorDetail> {
    match &job.error_detail {
        Some(value @ Value::Object(_)) => serde_json::from_value(value.clone()).ok(),
        _ => None,
    }
}

pub fn iso_of_millis(ms: i64) -> Option<String> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn to_job_dto(job: &JobRecord, runtime: &JobRuntimeInfo, style: PathStyle) -> JobDto {
    let running = runtime.running;
    let waiting_for_network =
        running && job.state == JobState::Uploading && runtime.waiting_for_network;
    let progress = if job.state == JobState::Done {
        100
    } else {
        runtime
            .progress
            .unwrap_or_else(|| fallback_progress(job.state))
    };
    let has_payload = has_register_payload(job);
    let public_id = if job.state == JobState::Done {
        registered_field(job, "public_id")
            .map(str::to_string)
            .or_else(|| job.public_id.clone())
    } else {
        job.public_id.clone()
    };

    let video_id = registered_video_id(job);
    let thumbnail_url = video_id
        .and(runtime.thumbnail_url.as_deref())
        .and_then(safe_https_url);

    JobDto {
        id: job.id.clone(),
        file_name: style.base_name(&job.source_path),
        size_bytes: size_of(job),
        state: job.state,
        stage_key: stage_key(job.state),
        progress: f64::from(progress.min(100)),
        waiting_reason: if job.state == JobState::Waiting && !running {
            runtime.waiting_reason.clone()
        } else {
            None
        },
        waiting_for_network,
        network_wait_since: if waiting_for_network {
            runtime.network_wait_since.and_then(iso_of_millis)
        } else {
            None
        },
        error_message: job.error_message.clone(),
        error_detail: error_detail_of(job),
        public_id,
        embed_url: registered_field(job, "embed_url").map(str::to_string),
        video_id,
        thumbnail_url,
        created_at: job.created_at.clone(),
        updated_at: job.updated_at.clone(),
        started_at: job.started_at.clone(),
        finished_at: job.finished_at.clone(),
        can_cancel: !runtime.cancel_requested
            && (running || job.state == JobState::Waiting || is_attention_state(job.state)),
        can_retry: !running && (is_retryable_state(job.state) || is_paused_upload(job.state)),
        can_resume: !running && is_paused_upload(job.state) && has_payload,
        can_retry_register: !running && is_attention_state(job.state) && has_payload,
        can_remove: !running && (is_final_state(job.state) || is_paused_upload(job.state)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::history::tests_support::job;

    fn payload() -> Value {
        json!({
            "public_id": "aaaaaaaaaaaa", "title": "t", "original_filename": "t.mp4",
            "original_size_bytes": 1, "disk_prefix": "2026/01/01/t-aaaaaaaaaaaa/",
            "playlist_path": "2026/01/01/t-aaaaaaaaaaaa/playlist.m3u8", "thumbnail_path": null,
            "storyboards": null, "duration": null, "output_width": null, "output_height": null,
            "output_fps": null, "output_bitrate_kbps": null, "output_codec": null
        })
    }

    #[test]
    fn never_leaks_paths_payloads_or_prefixes() {
        let mut record = job("j1", JobState::UploadInterrupted);
        record.source_path = "/home/alice/secret/clip.mp4".into();
        record.tmp_dir = Some("/tmp/hls/aaaaaaaaaaaa".into());
        record.prefix = Some("2026/01/01/t-aaaaaaaaaaaa/".into());
        record.register_payload = Some(payload());

        let dto = to_job_dto(&record, &JobRuntimeInfo::default(), PathStyle::Posix);
        let text = serde_json::to_string(&dto).unwrap();

        assert_eq!(dto.file_name, "clip.mp4");
        assert!(!text.contains("/home/alice"));
        assert!(!text.contains("/tmp/hls"));
        assert!(!text.contains("disk_prefix"));
        assert!(!text.contains("2026/01/01"));
        assert!(dto.can_resume && dto.can_retry && dto.can_remove && !dto.can_cancel);
        assert!(dto.thumbnail_url.is_none());

        // A finished job exposes only the https CDN URL, still no path or prefix.
        let (mut done, info) = done_with_video(Some("https://cdn.example.com/x/thumbnail.jpg"));
        done.source_path = "/home/alice/secret/clip.mp4".into();
        done.prefix = Some("2026/01/01/t-aaaaaaaaaaaa/".into());
        let dto = to_job_dto(&done, &info, PathStyle::Posix);
        let text = serde_json::to_string(&dto).unwrap();

        assert!(dto
            .thumbnail_url
            .as_deref()
            .unwrap()
            .starts_with("https://"));
        assert!(!text.contains("/home/alice"));
        assert!(!text.contains("2026/01/01"));
    }

    fn done_with_video(thumbnail: Option<&str>) -> (JobRecord, JobRuntimeInfo) {
        let mut done = job("d", JobState::Done);
        done.registered =
            Some(json!({ "id": 9, "public_id": "p", "embed_url": "https://s/embed/p" }));

        (
            done,
            JobRuntimeInfo {
                thumbnail_url: thumbnail.map(str::to_string),
                ..JobRuntimeInfo::default()
            },
        )
    }

    #[test]
    fn thumbnail_url_is_a_safe_https_url_or_absent() {
        let (done, info) = done_with_video(Some("https://cdn.example.com/a/thumbnail.jpg"));
        let dto = to_job_dto(&done, &info, PathStyle::Posix);

        assert_eq!(
            dto.thumbnail_url.as_deref(),
            Some("https://cdn.example.com/a/thumbnail.jpg")
        );
        assert!(serde_json::to_string(&dto)
            .unwrap()
            .contains("\"thumbnailUrl\":\"https://cdn.example.com/a/thumbnail.jpg\""));

        // Cache miss: absent and not serialized.
        let (done, info) = done_with_video(None);
        let dto = to_job_dto(&done, &info, PathStyle::Posix);
        assert_eq!(dto.thumbnail_url, None);
        assert!(!serde_json::to_string(&dto)
            .unwrap()
            .contains("thumbnailUrl"));

        // Unsafe values are dropped.
        for bad in [
            "http://cdn.example.com/t.jpg",
            "https://user:pw@cdn.example.com/t.jpg",
            "file:///home/alice/t.jpg",
            "/home/alice/t.jpg",
        ] {
            let (done, info) = done_with_video(Some(bad));
            assert_eq!(
                to_job_dto(&done, &info, PathStyle::Posix).thumbnail_url,
                None
            );
        }

        // Without a registered video id there is no thumbnail at all.
        let mut no_id = job("n", JobState::Waiting);
        no_id.registered = None;
        let info = JobRuntimeInfo {
            thumbnail_url: Some("https://cdn.example.com/t.jpg".into()),
            ..JobRuntimeInfo::default()
        };
        assert_eq!(
            to_job_dto(&no_id, &info, PathStyle::Posix).thumbnail_url,
            None
        );
    }

    #[test]
    fn progress_fallbacks_and_flags() {
        let mut done = job("d", JobState::Done);
        done.public_id = Some("old".into());
        done.registered =
            Some(json!({ "id": 1, "public_id": "newid", "embed_url": "https://s/embed/newid" }));
        let dto = to_job_dto(&done, &JobRuntimeInfo::default(), PathStyle::Posix);

        assert_eq!(dto.progress, 100.0);
        assert_eq!(dto.public_id.as_deref(), Some("newid"));
        assert_eq!(dto.embed_url.as_deref(), Some("https://s/embed/newid"));
        assert_eq!(dto.video_id, Some(1));

        // Without a usable id the field is absent (and not serialized).
        done.registered = Some(json!({ "id": "x", "public_id": "newid" }));
        let dto = to_job_dto(&done, &JobRuntimeInfo::default(), PathStyle::Posix);
        assert_eq!(dto.video_id, None);
        assert!(!serde_json::to_string(&dto).unwrap().contains("videoId"));

        let mut attention = job("a", JobState::RegisterFailed);
        attention.register_payload = Some(payload());
        let dto = to_job_dto(&attention, &JobRuntimeInfo::default(), PathStyle::Posix);

        assert_eq!(dto.progress, 98.0);
        assert!(dto.can_retry_register && dto.can_cancel && !dto.can_remove);

        // An unusable payload is not offered for a register retry.
        attention.register_payload = Some(json!({ "x": 1 }));
        assert!(
            !to_job_dto(&attention, &JobRuntimeInfo::default(), PathStyle::Posix)
                .can_retry_register
        );
    }

    #[test]
    fn network_wait_is_only_shown_while_uploading_and_running() {
        let record = job("u", JobState::Uploading);
        let info = JobRuntimeInfo {
            running: true,
            waiting_for_network: true,
            network_wait_since: Some(1_767_225_600_000),
            progress: Some(61),
            ..JobRuntimeInfo::default()
        };
        let dto = to_job_dto(&record, &info, PathStyle::Posix);

        assert!(dto.waiting_for_network);
        assert_eq!(
            dto.network_wait_since.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(dto.progress, 61.0);

        let mut stopped = info.clone();
        stopped.running = false;
        let dto = to_job_dto(&record, &stopped, PathStyle::Posix);

        assert!(!dto.waiting_for_network && dto.network_wait_since.is_none());
    }

    #[test]
    fn waiting_reason_only_for_waiting_jobs_without_a_run() {
        let info = JobRuntimeInfo {
            waiting_reason: Some("Sign in to start processing.".into()),
            ..JobRuntimeInfo::default()
        };

        assert!(
            to_job_dto(&job("w", JobState::Waiting), &info, PathStyle::Posix)
                .waiting_reason
                .is_some()
        );
        assert!(
            to_job_dto(&job("f", JobState::Failed), &info, PathStyle::Posix)
                .waiting_reason
                .is_none()
        );
    }

    #[test]
    fn error_detail_is_typed_or_dropped() {
        let mut record = job("f", JobState::Failed);
        record.error_detail =
            Some(json!({ "step": "transcoding", "exitCode": 69, "stderrTail": ["a"] }));

        assert_eq!(
            to_job_dto(&record, &JobRuntimeInfo::default(), PathStyle::Posix).error_detail,
            Some(JobErrorDetail {
                step: JobState::Transcoding,
                exit_code: Some(69),
                stderr_tail: vec!["a".into()]
            })
        );

        record.error_detail = Some(json!({ "bogus": true }));
        assert!(
            to_job_dto(&record, &JobRuntimeInfo::default(), PathStyle::Posix)
                .error_detail
                .is_none()
        );
    }
}
