//! Port of desktop-app/src/main/queue/jobQueue.test.ts (same scenarios, same expectations),
//! plus the concurrency tests of M6.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::job_queue::{
    CANNOT_REMOVE, GATE_NO_CONFIG, GATE_OFFLINE, GATE_SIGN_IN, INTERRUPTED_MESSAGE,
    RECOVERED_UPLOAD_MESSAGE, SIGN_IN_TO_RESUME, UNEXPECTED_ERROR, WAITING_FOR_SLOT,
};
use super::testing::*;
use crate::api::app_config::testing::config;
use crate::dto::{ActionResult, AuthStatus, JobState, QueueSummary};
use crate::ffmpeg::errors::{PipelineError, PipelineErrorKind, RESUME_UNAVAILABLE};
use crate::pipeline::run::BeforeUploadInfo;
use crate::pipeline::steps::upload::NetworkWaitInfo;
use crate::store::JobMode;

const GB: i64 = 1024 * 1024 * 1024;
const SITE_A: &str = "https://a.example.com";
const SITE_B: &str = "https://b.example.com";
const OTHER: &str = "https://other.example.com";

fn ok() -> ActionResult {
    ActionResult::Ok
}

fn is_ok(result: &ActionResult) -> bool {
    *result == ActionResult::Ok
}

fn error_text(result: &ActionResult) -> String {
    match result {
        ActionResult::Err(e) => e.clone(),
        ActionResult::Ok => String::new(),
    }
}

fn wait_info(since: i64, next: u64) -> NetworkWaitInfo {
    NetworkWaitInfo {
        since,
        attempt: 1,
        next_retry_in_ms: next,
        budget_remaining_ms: 1,
    }
}

async fn started(files: Vec<(&'static str, i64)>) -> Harness {
    let h = Harness::with(|o| o.files = files);

    h.add(&["/v/a.mp4"]).await;
    h
}

// ---- addFiles ------------------------------------------------------------------------------

#[tokio::test]
async fn add_files_validates_extension_existence_type_size_and_path() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![
            ("/v/a.MP4", 10),
            ("/v/b.mkv", 20),
            ("/v/c.txt", 5),
            ("/v/empty.mp4", 0),
            ("/v/dir.mp4", -1),
        ];
    });

    let result = h
        .add(&[
            "/v/a.MP4",
            "/v/b.mkv",
            "/v/c.txt",
            "/v/missing.mp4",
            "/v/empty.mp4",
            "/v/dir.mp4",
            "relative/x.mp4",
        ])
        .await;

    assert_eq!(result.added, 2);
    assert_eq!(
        result
            .rejected
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["c.txt", "missing.mp4", "empty.mp4", "dir.mp4", "x.mp4"]
    );
    assert_eq!(
        h.store.read(|d| d
            .jobs
            .iter()
            .map(|j| (j.source_path.clone(), j.size_bytes.as_u64().unwrap()))
            .collect::<Vec<_>>()),
        [("/v/a.MP4".to_string(), 10), ("/v/b.mkv".to_string(), 20)]
    );
    // Reasons never contain the full path.
    assert!(!serde_json::to_string(&result.rejected)
        .unwrap()
        .contains("/v/"));
}

#[tokio::test]
async fn add_files_dedupes_against_unfinished_jobs_and_within_the_batch() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/a.mp4", 1)];
    });

    h.add(&["/v/a.mp4", "/v/a.mp4"]).await;
    assert_eq!(h.store.read(|d| d.jobs.len()), 1);

    let again = h.add(&["/v/a.mp4"]).await;
    assert_eq!(again.added, 0);
    assert_eq!(again.rejected[0].reason, "Already in the queue.");

    // Once the job is final it can be added again.
    h.queue.cancel("job-1").await;
    assert_eq!(h.add(&["/v/a.mp4"]).await.added, 1);
}

#[tokio::test]
async fn add_files_orders_a_batch_smallest_first_and_keeps_batches_fifo() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![
            ("/v/big.mp4", 300),
            ("/v/small.mp4", 10),
            ("/v/mid.mp4", 100),
            ("/v/tiny.mp4", 1),
        ];
    });

    h.add(&["/v/big.mp4", "/v/small.mp4", "/v/mid.mp4"]).await;
    h.add(&["/v/tiny.mp4"]).await;

    assert_eq!(
        h.store.read(|d| d
            .jobs
            .iter()
            .map(|j| j.source_path.clone())
            .collect::<Vec<_>>()),
        ["/v/small.mp4", "/v/mid.mp4", "/v/big.mp4", "/v/tiny.mp4"]
    );

    h.set_auth(signed_in(None)).await;
    let paths = |h: &Harness| {
        h.runs()
            .iter()
            .map(|r| r.args.job.source_path.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(paths(&h), ["/v/small.mp4"]);
    h.run(0).resolve();
    flush().await;
    assert_eq!(paths(&h), ["/v/small.mp4", "/v/mid.mp4"]);
}

// ---- scheduling ----------------------------------------------------------------------------

#[tokio::test]
async fn respects_max_concurrent_1_and_2() {
    for max in [1usize, 2] {
        let h = Harness::with(|o| {
            o.max_concurrent = max as i64;
            o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2), ("/v/c.mp4", 3)];
        });

        h.add(&["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"]).await;
        assert_eq!(h.runs().len(), max);
        assert!(h.queue.has_active_jobs());

        h.run(0).resolve();
        flush().await;
        assert_eq!(h.runs().len(), max + 1);
    }
}

#[tokio::test]
async fn starts_nothing_while_signed_out_and_waiting_jobs_explain_why() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;

    assert!(h.runs().is_empty());
    let dto = &h.queue.list()[0];
    assert_eq!(dto.state, JobState::Waiting);
    assert_eq!(dto.waiting_reason.as_deref(), Some(GATE_SIGN_IN));
    assert_eq!(
        h.queue.summary().blocked_reason.as_deref(),
        Some(GATE_SIGN_IN)
    );

    h.set_auth(signed_in(None)).await;
    assert_eq!(h.runs().len(), 1);
    assert_eq!(h.queue.list()[0].waiting_reason, None);
}

#[tokio::test]
async fn holds_jobs_while_the_config_is_missing_offline_or_ffmpeg_is_unavailable() {
    let h = Harness::with(|o| {
        o.config = None;
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;

    assert!(h.runs().is_empty());
    assert_eq!(
        h.queue.list()[0].waiting_reason.as_deref(),
        Some(GATE_NO_CONFIG)
    );

    h.set_config(Some(config()));
    h.set_block(Some("ffmpeg is not available."));
    h.queue.kick();
    assert!(h.runs().is_empty());
    assert_eq!(
        h.queue.list()[0].waiting_reason.as_deref(),
        Some("ffmpeg is not available.")
    );

    h.set_block(None);
    *h.ctx.auth.lock().unwrap() = with_status(AuthStatus::Offline);
    h.queue.kick();
    assert!(h.runs().is_empty());
    assert_eq!(
        h.queue.list()[0].waiting_reason.as_deref(),
        Some(GATE_OFFLINE)
    );

    h.set_auth(signed_in(None)).await;
    assert_eq!(h.runs().len(), 1);
}

#[tokio::test]
async fn explains_when_a_job_waits_for_a_free_slot() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)]);
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;

    assert_eq!(
        h.queue
            .list()
            .iter()
            .map(|j| j.waiting_reason.clone())
            .collect::<Vec<_>>(),
        [None, Some(WAITING_FOR_SLOT.to_string())]
    );
}

#[tokio::test]
async fn passes_the_config_a_per_job_token_and_a_fresh_public_id_to_the_pipeline() {
    let h = Harness::with(|o| o.files = vec![("/v/My Video.mp4", 1)]);
    h.add(&["/v/My Video.mp4"]).await;

    let run = h.run(0);
    assert_eq!(run.args.config, config());
    assert_eq!(run.args.job.id, "job-1");
    assert_eq!(run.args.job.source_path, "/v/My Video.mp4");
    assert_eq!(run.args.job.filename, "My Video.mp4");
    assert_eq!(run.args.job.public_id, "pub000000001");
    assert_eq!(run.args.tmp_root.to_string_lossy(), TMP_ROOT);
    assert!(!run.cancel.is_cancelled());
}

// ---- hooks and persistence -----------------------------------------------------------------

#[tokio::test]
async fn maps_stage_progress_and_prefix_hooks_to_state() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    let hooks = h.run(0).hooks.clone();

    assert_eq!(h.job("job-1").state, JobState::Transcoding);
    hooks.on_prefix("2026/01/01/a-pub000000001/");
    hooks.on_stage(JobState::Uploading);
    hooks.on_progress(61);

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Uploading);
    assert_eq!(job.prefix.as_deref(), Some("2026/01/01/a-pub000000001/"));

    let dto = &h.queue.list()[0];
    assert_eq!(dto.state, JobState::Uploading);
    assert_eq!(dto.stage_key, "job.state.uploading");
    assert_eq!(dto.progress, 61.0);
    assert!(dto.can_cancel && !dto.can_retry);
}

#[tokio::test]
async fn persists_state_transitions_but_never_progress_ticks() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    let hooks = h.run(0).hooks.clone();
    let before = h.store.get();

    h.clock.advance(1000);
    for i in 1..=50 {
        hooks.on_progress(i);
    }
    assert_eq!(h.store.get(), before);

    hooks.on_stage(JobState::Thumbnail);
    assert_ne!(h.store.get(), before);
    assert_eq!(h.job("job-1").updated_at, "2026-01-01T00:00:01.000Z");
}

#[tokio::test]
async fn never_lets_progress_go_backwards() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    let hooks = h.run(0).hooks.clone();

    hooks.on_progress(40);
    hooks.on_progress(30);

    assert_eq!(h.queue.list()[0].progress, 40.0);
}

// ---- event throttling ----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn emits_at_most_4_progress_events_per_second_and_stage_changes_immediately() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.tokio_clock = true;
    });
    h.add(&["/v/a.mp4"]).await;
    let hooks = h.run(0).hooks.clone();
    h.snapshots.lock().unwrap().clear();

    // 40 ticks over one second (every 25 ms).
    for i in 1..=40 {
        hooks.on_progress(i);
        tokio::time::advance(Duration::from_millis(25)).await;
        flush().await;
    }
    let count = h.snapshot_count();
    assert!((3..=4).contains(&count), "{count} events");

    // The trailing emit carries the latest value.
    tokio::time::advance(Duration::from_millis(300)).await;
    flush().await;
    assert_eq!(h.last_snapshot()[0].progress, 40.0);

    let count = h.snapshot_count();
    hooks.on_stage(JobState::Storyboard);
    assert_eq!(h.snapshot_count(), count + 1);
    assert_eq!(h.last_snapshot()[0].state, JobState::Storyboard);
}

#[tokio::test]
async fn emits_queue_summaries_only_when_they_change() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1)]);
    let summaries: Arc<std::sync::Mutex<Vec<QueueSummary>>> = Arc::default();
    let sink = Arc::clone(&summaries);
    h.queue.subscribe_summary(Arc::new(move |s: &QueueSummary| {
        sink.lock().unwrap().push(s.clone())
    }));
    h.add(&["/v/a.mp4"]).await;
    let count = summaries.lock().unwrap().len();

    h.run(0).hooks.on_progress(10);
    h.run(0).hooks.on_stage(JobState::Thumbnail);

    let summaries = summaries.lock().unwrap();
    assert_eq!(summaries.len(), count);
    let last = summaries.last().unwrap();
    assert_eq!((last.running, last.waiting, last.total), (1, 0, 1));
}

// ---- pipeline results ----------------------------------------------------------------------

#[tokio::test]
async fn done_stores_the_registered_video_and_clears_the_payload() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).resolve();
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.public_id.as_deref(), Some("pub000000001"));
    assert_eq!(
        job.registered.as_ref().unwrap()["embed_url"],
        "https://site.example.com/embed/pub000000001"
    );
    assert_eq!(
        job.registered.as_ref().unwrap()["public_id"],
        "pub000000001"
    );
    assert_eq!(job.error_message, None);
    assert!(job.finished_at.is_some());

    let dto = &h.queue.list()[0];
    assert_eq!(dto.progress, 100.0);
    assert!(dto.can_remove && !dto.can_cancel);
    assert!(!h.queue.has_active_jobs());
}

/// Resolves the first run with a payload that has `thumbnail_path` set as given.
async fn finish_with_thumbnail(h: &Harness, thumbnail_path: Option<&str>) {
    let mut payload = payload();

    payload.thumbnail_path = thumbnail_path.map(str::to_string);

    h.run(0).resolve_with(crate::pipeline::run::PipelineResult {
        registered: crate::pipeline::register::RegisteredVideo {
            id: 1,
            public_id: "pub000000001".into(),
            embed_url: "https://site.example.com/embed/pub000000001".into(),
        },
        prefix: "2026/01/01/x-pub000000001/".into(),
        payload,
    });
    flush().await;
}

#[tokio::test]
async fn done_stores_a_safe_https_thumbnail_url_built_from_the_payload() {
    let h = started(vec![("/v/a.mp4", 1)]).await;

    finish_with_thumbnail(&h, Some("2026/01/01/x-pub000000001/thumbnail.jpg")).await;

    let job = h.job("job-1");

    assert_eq!(job.state, JobState::Done);
    assert_eq!(
        job.thumbnail_url.as_deref(),
        Some("https://cdn.example.com/2026/01/01/x-pub000000001/thumbnail.jpg")
    );
    // The DTO takes it straight from the record.
    assert_eq!(
        h.queue.list()[0].thumbnail_url.as_deref(),
        job.thumbnail_url.as_deref()
    );
}

#[tokio::test]
async fn done_stores_no_thumbnail_url_without_a_payload_thumbnail() {
    let h = started(vec![("/v/a.mp4", 1)]).await;

    finish_with_thumbnail(&h, None).await;

    assert_eq!(h.job("job-1").state, JobState::Done);
    assert_eq!(h.job("job-1").thumbnail_url, None);
    assert_eq!(h.queue.list()[0].thumbnail_url, None);
}

#[tokio::test]
async fn done_stores_no_thumbnail_url_when_the_r2_base_is_missing() {
    let h = started(vec![("/v/a.mp4", 1)]).await;

    h.set_config(None);
    finish_with_thumbnail(&h, Some("2026/01/01/x-pub000000001/thumbnail.jpg")).await;

    assert_eq!(h.job("job-1").state, JobState::Done);
    assert_eq!(h.job("job-1").thumbnail_url, None);
}

#[tokio::test]
async fn failed_stores_message_redacted_detail_and_prefix() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    let mut error = PipelineError::new(
        PipelineErrorKind::Failed,
        JobState::Transcoding,
        "ffmpeg failed",
    );
    error.exit_code = Some(69);
    error.stderr_tail = vec!["Authorization: Bearer abc.def".into(), "normal line".into()];
    error.prefix = Some("2026/01/01/a-pub000000001/".into());
    h.run(0).reject(error);
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error_message.as_deref(), Some("ffmpeg failed"));
    assert_eq!(job.prefix.as_deref(), Some("2026/01/01/a-pub000000001/"));
    assert_eq!(
        job.error_detail,
        Some(json!({
            "step": "transcoding", "exitCode": 69,
            "stderrTail": ["Authorization: [REDACTED]", "normal line"]
        }))
    );
    let dto = &h.queue.list()[0];
    assert!(dto.can_retry && dto.can_remove);
}

#[tokio::test]
async fn cancelled_marks_the_job_cancelled() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).cancel_on_abort(JobState::Uploading);
    h.queue.cancel("job-1").await;
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.error_detail.as_ref().unwrap()["step"], "uploading");
}

#[tokio::test]
async fn register_failed_keeps_payload_and_prefix_and_exposes_retry_register() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).reject(register_error(
        PipelineErrorKind::RegisterFailed,
        "Could not reach the site.",
    ));
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::RegisterFailed);
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert_eq!(job.prefix, Some(payload().disk_prefix));
    let dto = &h.queue.list()[0];
    assert!(dto.can_retry_register && !dto.can_retry && !dto.can_remove && dto.can_cancel);
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn needs_sign_in_keeps_the_payload() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).reject(register_error(
        PipelineErrorKind::NeedsSignIn,
        "Session expired.",
    ));
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::NeedsSignIn);
    assert_eq!(job.register_payload_typed(), Some(payload()));
}

#[tokio::test]
async fn an_unexpected_error_becomes_a_generic_failure_without_leaking_details() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).panic();
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error_message.as_deref(), Some(UNEXPECTED_ERROR));
    assert!(!serde_json::to_string(&h.queue.list())
        .unwrap()
        .contains("secret internal"));
    assert!(h.logged("Job failed unexpectedly"));
}

#[tokio::test]
async fn starts_the_next_job_after_a_failure() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)]);
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;
    h.run(0).reject(failed_error(JobState::Transcoding, "boom"));
    flush().await;

    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.job("job-2").state, JobState::Transcoding);
}

#[tokio::test]
async fn applies_the_history_cap_when_a_job_finishes() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1)]);
    let old: Vec<_> = (0..200)
        .map(|i| record(&format!("old-{i}"), JobState::Done))
        .collect();
    h.store.update(|d| d.jobs.splice(0..0, old).for_each(drop));
    h.add(&["/v/a.mp4"]).await;
    h.run(0).resolve();
    flush().await;

    let jobs = h.store.get().jobs;
    assert_eq!(
        jobs.iter().filter(|j| j.state == JobState::Done).count(),
        200
    );
    assert!(!jobs.iter().any(|j| j.id == "old-0"));
    assert!(jobs.iter().any(|j| j.id == "job-1"));
}

// ---- cancel --------------------------------------------------------------------------------

#[tokio::test]
async fn cancels_a_waiting_job_without_touching_the_pipeline() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;

    assert_eq!(h.queue.cancel("job-1").await, ok());
    assert_eq!(h.job("job-1").state, JobState::Cancelled);
    assert!(h.runs().is_empty());
}

#[tokio::test]
async fn aborts_the_token_when_cancelled_during_each_stage() {
    for stage in [
        JobState::Transcoding,
        JobState::Thumbnail,
        JobState::Storyboard,
        JobState::Uploading,
        JobState::Registering,
    ] {
        let h = started(vec![("/v/a.mp4", 1)]).await;
        let run = h.run(0);
        run.cancel_on_abort(stage);
        run.hooks.on_stage(stage);

        h.queue.cancel("job-1").await;
        assert!(run.cancel.is_cancelled());
        assert!(!h.queue.list()[0].can_cancel);

        flush().await;
        assert_eq!(h.job("job-1").state, JobState::Cancelled, "{stage:?}");
    }
}

#[tokio::test]
async fn abandoning_a_register_failed_job_does_not_delete_r2_files() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0)
        .reject(register_error(PipelineErrorKind::RegisterFailed, "x"));
    flush().await;

    assert_eq!(h.queue.cancel("job-1").await, ok());
    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn rejects_cancel_for_finished_jobs_and_unknown_ids() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).resolve();
    flush().await;

    assert!(!is_ok(&h.queue.cancel("job-1").await));
    assert!(!is_ok(&h.queue.cancel("nope").await));
}

// ---- retry ---------------------------------------------------------------------------------

async fn failed_at(step: JobState, prefix: Option<&str>) -> Harness {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).hooks.on_stage(JobState::Uploading);
    let mut error = PipelineError::new(PipelineErrorKind::Failed, step, "x");
    error.prefix = prefix.map(str::to_string);
    h.run(0).reject(error);
    flush().await;

    h
}

#[tokio::test]
async fn retry_reruns_with_a_new_public_id_and_deletes_the_old_prefix_after_a_partial_upload() {
    let prefix = "2026/01/01/a-pub000000001/";
    let h = failed_at(JobState::Uploading, Some(prefix)).await;

    assert_eq!(h.queue.retry("job-1").await, ok());
    flush().await;

    assert_eq!(h.deleted(), [("bucket".to_string(), prefix.to_string())]);
    assert_eq!(h.removed(), [tmp("pub000000001")]);
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.run(1).args.job.public_id, "pub000000002");
    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Transcoding);
    assert_eq!(job.public_id.as_deref(), Some("pub000000002"));
    assert_eq!(
        (job.error_message, job.error_detail, job.prefix),
        (None, None, None)
    );
}

#[tokio::test]
async fn retry_does_not_touch_r2_when_nothing_was_uploaded() {
    let h = failed_at(JobState::Transcoding, None).await;
    h.queue.retry("job-1").await;

    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn retry_does_not_delete_files_when_the_failure_happened_while_registering() {
    let h = failed_at(JobState::Registering, Some("2026/01/01/a-pub000000001/")).await;
    h.queue.retry("job-1").await;

    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn retry_still_works_when_no_config_is_available_for_the_cleanup() {
    let h = failed_at(JobState::Uploading, Some("2026/01/01/a-pub000000001/")).await;
    h.set_config(None);

    assert_eq!(h.queue.retry("job-1").await, ok());
    assert!(h.deleted().is_empty());
    assert_eq!(h.job("job-1").state, JobState::Waiting);
}

#[tokio::test]
async fn retry_works_for_cancelled_and_interrupted_jobs_and_rejects_other_states() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)];
    });
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;
    h.queue.cancel("job-1").await;
    h.store.update(|d| d.jobs[1].state = JobState::Interrupted);

    assert!(is_ok(&h.queue.retry("job-1").await));
    assert!(is_ok(&h.queue.retry("job-2").await));
    assert!(!is_ok(&h.queue.retry("job-1").await)); // now waiting
    assert!(!is_ok(&h.queue.retry("nope").await));
}

#[tokio::test]
async fn a_double_click_on_retry_cannot_start_two_runs() {
    let h = failed_at(JobState::Uploading, Some("2026/01/01/a-pub000000001/")).await;
    let (a, b) = tokio::join!(h.queue.retry("job-1"), h.queue.retry("job-1"));
    flush().await;

    let mut oks = [is_ok(&a), is_ok(&b)];
    oks.sort();
    assert_eq!(oks, [false, true]);
    assert_eq!(h.runs().len(), 2);
}

// ---- retryRegister -------------------------------------------------------------------------

async fn register_failed(kind: PipelineErrorKind) -> Harness {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).reject(register_error(kind, "x"));
    flush().await;

    h
}

#[tokio::test]
async fn retry_register_uses_the_stored_payload_without_reupload_and_finishes() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;

    assert_eq!(h.queue.retry_register("job-1"), ok());
    assert_eq!(h.runs().len(), 1);
    flush().await;
    assert_eq!(h.register_runs()[0].args.payload, payload());
    assert_eq!(h.job("job-1").state, JobState::Registering);

    h.register_runs()[0].resolve();
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
    assert_eq!(job.registered.unwrap()["public_id"], payload().public_id);
}

#[tokio::test]
async fn retry_register_returns_to_register_failed_when_it_fails_the_same_way() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;
    h.queue.retry_register("job-1");
    flush().await;
    h.register_runs()[0].reject(register_error(
        PipelineErrorKind::RegisterFailed,
        "still down",
    ));
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::RegisterFailed);
    assert_eq!(job.error_message.as_deref(), Some("still down"));
}

#[tokio::test]
async fn a_definitive_rejection_fails_the_job_and_removes_the_useless_r2_files() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;
    h.queue.retry_register("job-1");
    flush().await;
    let mut error =
        PipelineError::new(PipelineErrorKind::Failed, JobState::Registering, "rejected");
    error.prefix = Some(payload().disk_prefix);
    error.definitive = true;
    h.register_runs()[0].reject(error);
    flush().await;

    assert_eq!(h.job("job-1").state, JobState::Failed);
    assert_eq!(h.deleted(), [("bucket".to_string(), payload().disk_prefix)]);
}

#[tokio::test]
async fn a_failure_that_is_not_definitive_keeps_the_r2_files() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;
    h.queue.retry_register("job-1");
    flush().await;
    let mut error = PipelineError::new(
        PipelineErrorKind::Failed,
        JobState::Registering,
        "invalid stored data",
    );
    error.prefix = Some(payload().disk_prefix);
    h.register_runs()[0].reject(error);
    flush().await;

    assert_eq!(h.job("job-1").state, JobState::Failed);
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn cancelling_a_register_retry_only_stops_the_attempt() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;
    h.queue.retry_register("job-1");
    flush().await;
    h.queue.cancel("job-1").await;
    assert!(h.register_runs()[0].cancel.is_cancelled());
    h.register_runs()[0].reject(PipelineError::new(
        PipelineErrorKind::Cancelled,
        JobState::Registering,
        "c",
    ));
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::RegisterFailed);
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn retry_register_requires_being_signed_in_and_an_eligible_job() {
    let h = register_failed(PipelineErrorKind::NeedsSignIn).await;
    *h.ctx.auth.lock().unwrap() = signed_out(None);

    assert!(!is_ok(&h.queue.retry_register("job-1")));
    assert!(!is_ok(&h.queue.retry_register("nope")));
    flush().await;
    assert!(h.register_runs().is_empty());
}

// ---- auto resume after sign-in -------------------------------------------------------------

#[tokio::test]
async fn sign_in_retry_registers_needs_sign_in_jobs_and_starts_waiting_jobs() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)]);
    h.add(&["/v/a.mp4"]).await;
    h.run(0)
        .reject(register_error(PipelineErrorKind::NeedsSignIn, "expired"));
    flush().await;

    // Session lost; a new file is added but cannot start.
    h.set_auth(signed_out(None)).await;
    h.add(&["/v/b.mp4"]).await;
    flush().await;
    assert_eq!(h.runs().len(), 1);
    assert!(h.register_runs().is_empty());

    h.set_auth(signed_in(None)).await;
    flush().await;

    assert_eq!(h.register_runs().len(), 1);
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.job("job-1").state, JobState::Registering);
    assert_eq!(h.job("job-2").state, JobState::Transcoding);
}

// ---- recovery ------------------------------------------------------------------------------

#[tokio::test]
async fn recovery_turns_running_jobs_into_interrupted_and_removes_their_temp_dirs() {
    let h = Harness::with(|o| o.auth = signed_out(None));
    let base = |id: &str, state: JobState, public_id: Option<&str>| {
        let mut job = record(id, state);
        job.public_id = public_id.map(str::to_string);
        job.prefix = public_id.map(|p| format!("2026/01/01/x-{p}/"));
        job.register_payload = Some(if state == JobState::RegisterFailed {
            payload_value()
        } else {
            serde_json::Value::Null
        });
        job
    };
    h.push_jobs(vec![
        base("t", JobState::Transcoding, Some("aaaaaaaaaaaa")),
        base("u", JobState::Uploading, Some("bbbbbbbbbbbb")),
        base("r", JobState::Registering, Some("cccccccccccc")),
        base("evil", JobState::Thumbnail, Some("../../etc")),
        base("w", JobState::Waiting, None),
        base("rf", JobState::RegisterFailed, Some("dddddddddddd")),
        base("d", JobState::Done, Some("eeeeeeeeeeee")),
    ]);

    h.queue.recover().await;

    assert_eq!(
        h.states(),
        [
            "t:interrupted",
            "u:interrupted",
            "r:interrupted",
            "evil:interrupted",
            "w:waiting",
            "rf:register_failed",
            "d:done"
        ]
    );
    let mut removed = h.removed();
    removed.sort();
    assert_eq!(
        removed,
        [
            tmp("aaaaaaaaaaaa"),
            tmp("bbbbbbbbbbbb"),
            tmp("cccccccccccc")
        ]
    );
    let u = h.job("u");
    assert_eq!(u.error_message.as_deref(), Some(INTERRUPTED_MESSAGE));
    assert!(u
        .error_message
        .unwrap()
        .contains("closed while this job was running"));
    assert_eq!(
        u.error_detail,
        Some(json!({ "step": "uploading", "exitCode": null, "stderrTail": [] }))
    );
    assert_eq!(h.job("rf").register_payload_typed(), Some(payload()));
    assert!(h.dto("u").can_retry);
}

// ---- remove and clearFinished --------------------------------------------------------------

#[tokio::test]
async fn removes_only_final_jobs() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2), ("/v/c.mp4", 3)]);
    h.add(&["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"]).await;
    h.run(0).resolve();
    flush().await;

    assert_eq!(
        h.queue.remove("job-2").await,
        ActionResult::err(CANNOT_REMOVE)
    ); // running
    assert!(!is_ok(&h.queue.remove("job-3").await)); // waiting
    assert!(is_ok(&h.queue.remove("job-1").await));
    assert_eq!(h.states(), ["job-2:transcoding", "job-3:waiting"]);
}

#[tokio::test]
async fn clear_finished_drops_final_jobs_but_keeps_active_and_attention_jobs() {
    let h = Harness::with(|o| o.auth = signed_out(None));
    h.push_jobs(vec![
        record("1", JobState::Done),
        record("2", JobState::Failed),
        record("3", JobState::Cancelled),
        record("4", JobState::Interrupted),
        record("5", JobState::Waiting),
        record("6", JobState::RegisterFailed),
        record("7", JobState::NeedsSignIn),
    ]);

    h.queue.clear_finished();

    assert_eq!(
        h.states(),
        ["5:waiting", "6:register_failed", "7:needs_sign_in"]
    );
}

// ---- shutdown ------------------------------------------------------------------------------

#[tokio::test]
async fn shutdown_aborts_all_running_jobs_waits_for_cleanup_and_starts_nothing_new() {
    let h = Harness::with(|o| {
        o.max_concurrent = 2;
        o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2), ("/v/c.mp4", 3)];
    });
    h.add(&["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"]).await;
    flush().await;
    for run in h.runs() {
        run.cancel_on_abort(JobState::Transcoding);
    }

    h.queue.shutdown().await;
    flush().await;

    assert!(h.runs().iter().all(|r| r.cancel.is_cancelled()));
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.job("job-1").state, JobState::Cancelled);
    assert_eq!(h.job("job-3").state, JobState::Waiting);
    assert!(!h.queue.has_active_jobs());
}

#[tokio::test(start_paused = true)]
async fn shutdown_gives_up_waiting_after_the_timeout() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.tokio_clock = true;
    });
    h.add(&["/v/a.mp4"]).await;
    flush().await;

    let begin = tokio::time::Instant::now();
    h.queue.shutdown().await;

    assert!(tokio::time::Instant::now() - begin >= Duration::from_millis(200));
    assert!(h.run(0).cancel.is_cancelled());
}

// ---- big files -----------------------------------------------------------------------------

#[tokio::test]
async fn records_the_size_reported_by_stat() {
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/big.mp4", 5 * GB)];
    });
    h.add(&["/v/big.mp4"]).await;

    assert_eq!(h.queue.list()[0].size_bytes, 5 * GB as u64);
}

// ---- gate ----------------------------------------------------------------------------------

#[tokio::test]
async fn gate_does_not_start_while_signed_in_but_the_token_is_missing() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.session = false;
    });
    h.add(&["/v/a.mp4"]).await;

    assert!(h.runs().is_empty());
    assert_eq!(
        h.queue.summary().blocked_reason.as_deref(),
        Some(GATE_SIGN_IN)
    );
}

#[tokio::test]
async fn gate_does_not_start_while_signed_in_but_the_config_is_empty() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.config = None;
    });
    h.add(&["/v/a.mp4"]).await;

    assert!(h.runs().is_empty());
}

#[tokio::test]
async fn gate_does_not_start_while_signed_out_even_with_a_config() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.auth = signed_out(None);
    });
    h.add(&["/v/a.mp4"]).await;

    assert!(h.runs().is_empty());
}

// ---- jobs are bound to the site they were uploaded for -------------------------------------

async fn needs_sign_in_on_a() -> Harness {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.auth = signed_in(Some(SITE_A));
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0)
        .reject(register_error(PipelineErrorKind::NeedsSignIn, "expired"));
    flush().await;

    h
}

const MESSAGE_A: &str =
    "This video was uploaded for a.example.com; sign in to that site to finish it.";

#[tokio::test]
async fn records_the_site_origin_when_the_job_starts() {
    let h = needs_sign_in_on_a().await;

    assert_eq!(h.job("job-1").site_origin.as_deref(), Some(SITE_A));
}

#[tokio::test]
async fn does_not_auto_register_against_another_site_and_explains_why() {
    let h = needs_sign_in_on_a().await;

    h.set_auth(signed_out(Some(SITE_B))).await;
    h.set_auth(signed_in(Some(SITE_B))).await;
    flush().await;

    assert!(h.register_runs().is_empty());
    let job = h.job("job-1");
    assert_eq!(job.state, JobState::NeedsSignIn);
    assert_eq!(job.error_message.as_deref(), Some(MESSAGE_A));
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn refuses_a_manual_register_retry_against_another_site() {
    let h = needs_sign_in_on_a().await;
    *h.ctx.auth.lock().unwrap() = signed_in(Some(SITE_B));

    assert_eq!(
        h.queue.retry_register("job-1"),
        ActionResult::err(MESSAGE_A)
    );
    flush().await;
    assert!(h.register_runs().is_empty());
    assert_eq!(h.job("job-1").state, JobState::NeedsSignIn);
}

#[tokio::test]
async fn resumes_automatically_once_signed_in_to_the_original_site_again() {
    let h = needs_sign_in_on_a().await;

    h.set_auth(signed_in(Some(SITE_B))).await;
    h.set_auth(signed_in(Some(SITE_A))).await;
    flush().await;

    assert_eq!(h.register_runs().len(), 1);
}

#[tokio::test]
async fn never_deletes_r2_files_with_the_config_of_another_site() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.auth = signed_in(Some(SITE_A));
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0).hooks.on_stage(JobState::Uploading);
    let mut error = PipelineError::new(PipelineErrorKind::Failed, JobState::Uploading, "x");
    error.prefix = Some("2026/01/01/a-pub000000001/".into());
    h.run(0).reject(error);
    flush().await;
    *h.ctx.auth.lock().unwrap() = signed_in(Some(SITE_B));

    assert_eq!(h.queue.retry("job-1").await, ok());
    assert!(h.deleted().is_empty());
    assert_eq!(h.job("job-1").site_origin.as_deref(), Some(SITE_B));
}

#[tokio::test]
async fn tolerates_old_records_without_a_site_origin() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1)];
        o.auth = signed_in(Some(SITE_A));
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0)
        .reject(register_error(PipelineErrorKind::RegisterFailed, "x"));
    flush().await;
    h.store.update(|d| d.jobs[0].site_origin = None);

    assert_eq!(h.queue.retry_register("job-1"), ok());
}

#[tokio::test]
async fn a_job_of_another_site_can_still_be_cancelled_and_nothing_is_deleted() {
    let h = needs_sign_in_on_a().await;
    *h.ctx.auth.lock().unwrap() = signed_in(Some(SITE_B));

    assert_eq!(h.queue.cancel("job-1").await, ok());
    assert_eq!(h.job("job-1").state, JobState::Cancelled);
    assert!(h.deleted().is_empty());
}

// ---- crash window around registering -------------------------------------------------------

#[tokio::test]
async fn flushes_the_store_before_the_first_register_request() {
    let h = started(vec![("/v/a.mp4", 1)]).await;
    h.run(0).hooks.on_before_register().await.unwrap();

    assert_eq!(h.flushes(), 1);
}

#[tokio::test]
async fn flushes_the_store_before_the_register_only_retry_too() {
    let h = register_failed(PipelineErrorKind::RegisterFailed).await;
    h.queue.retry_register("job-1");
    flush().await;
    h.register_runs()[0]
        .hooks
        .on_before_register()
        .await
        .unwrap();

    assert_eq!(h.flushes(), 1);
}

#[tokio::test]
async fn retry_of_an_interrupted_job_never_deletes_its_old_prefix_and_logs_a_note() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1)]);
    let mut job = record("job-1", JobState::Interrupted);
    job.source_path = "/v/a.mp4".into();
    job.public_id = Some("pub000000001".into());
    job.prefix = Some("2026/01/01/a-pub000000001/".into());
    job.error_message = Some("interrupted".into());
    job.error_detail = Some(json!({ "step": "uploading", "exitCode": null, "stderrTail": [] }));
    h.push_jobs(vec![job]);

    assert_eq!(h.queue.retry("job-1").await, ok());
    assert!(h.deleted().is_empty());
    assert!(h.logged("may be orphaned"));
}

// ---- resumable uploads ---------------------------------------------------------------------

fn paused_harness(
    edit: impl FnOnce(&mut crate::store::JobRecord),
    options: impl FnOnce(&mut HarnessOptions),
) -> Harness {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        options(o);
    });
    let mut job = paused_record("p1");
    edit(&mut job);
    h.push_jobs(vec![job]);

    h
}

fn paused() -> Harness {
    paused_harness(|_| (), |_| ())
}

#[tokio::test]
async fn persists_payload_tmp_dir_and_prefix_durably_before_the_first_upload() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;
    let public_id = h.job("job-1").public_id.unwrap();

    h.run(0)
        .hooks
        .on_before_upload(&BeforeUploadInfo {
            prefix: payload().disk_prefix,
            public_id: public_id.clone(),
            tmp_dir: tmp(&public_id).into(),
            register_payload: payload(),
        })
        .await
        .unwrap();

    let job = h.job("job-1");
    assert_eq!(job.prefix, Some(payload().disk_prefix));
    assert_eq!(job.tmp_dir, Some(tmp(&public_id)));
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert_eq!(h.flushes(), 1);
    assert_eq!(job.register_started, None);
}

#[tokio::test]
async fn before_register_flushes_and_records_that_the_site_may_have_registered_it() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0).hooks.on_before_register().await.unwrap();

    assert_eq!(h.flushes(), 1);
    assert_eq!(h.job("job-1").register_started, Some(true));
}

#[tokio::test]
async fn maps_upload_interrupted_to_a_resumable_state_without_deleting_anything() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0).reject(interrupted_error());
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::UploadInterrupted);
    assert!(job
        .error_message
        .as_deref()
        .unwrap()
        .contains("network was unavailable"));
    assert_eq!(
        job.error_detail,
        Some(json!({ "step": "uploading", "exitCode": null, "stderrTail": [] }))
    );
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert_eq!(job.tmp_dir, Some(tmp("aaaaaaaaaaaa")));
    assert_eq!(job.prefix, Some(payload().disk_prefix));
    assert_eq!(job.finished_at, None);
    assert!(h.deleted().is_empty() && h.removed().is_empty());

    let dto = h.dto("job-1");
    assert!(dto.can_resume && dto.can_retry && dto.can_remove && !dto.can_cancel);
    assert!(!dto.waiting_for_network);
    let text = serde_json::to_string(&dto).unwrap();
    assert!(!text.contains(&tmp("aaaaaaaaaaaa")) && !text.contains("disk_prefix"));
    let summary = h.queue.summary();
    assert_eq!((summary.attention, summary.running), (1, 0));
    assert!(h.queue.has_paused_uploads());
}

#[tokio::test]
async fn an_unresumable_upload_interrupted_fails_and_removes_the_temp_dir() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0).reject(PipelineError::new(
        PipelineErrorKind::UploadInterrupted,
        JobState::Uploading,
        "x",
    ));
    flush().await;

    assert_eq!(h.job("job-1").state, JobState::Failed);
    assert_eq!(h.removed(), [tmp(&h.job("job-1").public_id.unwrap())]);
}

#[tokio::test]
async fn frees_the_slot_of_a_paused_upload_so_the_next_job_starts() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)];
    });
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;
    h.run(0).reject(interrupted_error());
    flush().await;

    assert_eq!(
        h.states(),
        ["job-1:upload_interrupted", "job-2:transcoding"]
    );
}

// ---- network wait --------------------------------------------------------------------------

#[tokio::test]
async fn network_wait_sets_and_clears_the_runtime_flags_while_the_state_stays_uploading() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    let since = h.clock.ms() - 5000;
    h.add(&["/v/a.mp4"]).await;
    let hooks = h.run(0).hooks.clone();
    hooks.on_stage(JobState::Uploading);
    hooks.on_network_wait(&wait_info(since, 2000));

    let dto = &h.queue.list()[0];
    assert_eq!(dto.state, JobState::Uploading);
    assert!(dto.waiting_for_network && dto.can_cancel);
    assert_eq!(
        dto.network_wait_since.as_deref(),
        Some("2025-12-31T23:59:55.000Z")
    );
    // Never persisted.
    assert!(!serde_json::to_string(&h.store.get().jobs)
        .unwrap()
        .contains("waitingForNetwork"));
    assert!(h.last_snapshot()[0].waiting_for_network);

    hooks.on_network_restored();

    let dto = &h.queue.list()[0];
    assert!(!dto.waiting_for_network && dto.network_wait_since.is_none());
    assert_eq!(dto.state, JobState::Uploading);
    assert!(!h.last_snapshot()[0].waiting_for_network);
}

#[tokio::test(start_paused = true)]
async fn network_wait_emits_the_first_wait_immediately_and_throttles_repeats() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    let info = wait_info(h.clock.ms(), 1);
    h.add(&["/v/a.mp4"]).await;
    let hooks = h.run(0).hooks.clone();
    hooks.on_stage(JobState::Uploading);

    let before = h.snapshot_count();
    hooks.on_network_wait(&info);
    assert_eq!(h.snapshot_count(), before + 1);

    for _ in 0..10 {
        hooks.on_network_wait(&info);
    }
    // Same clock: everything else is coalesced into one trailing emit.
    assert_eq!(h.snapshot_count(), before + 1);
    tokio::time::advance(Duration::from_millis(300)).await;
    flush().await;
    assert_eq!(h.snapshot_count(), before + 2);
}

#[tokio::test]
async fn cancelling_during_the_network_wait_ends_like_a_normal_cancel() {
    let h = Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 1)];
    });
    h.add(&["/v/a.mp4"]).await;
    h.run(0).cancel_on_abort(JobState::Uploading);
    h.run(0).hooks.on_network_wait(&wait_info(h.clock.ms(), 1));

    assert_eq!(h.queue.cancel("job-1").await, ok());
    flush().await;

    let job = h.job("job-1");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.tmp_dir, None);
    assert!(!h.queue.list()[0].waiting_for_network);
}

// ---- resume --------------------------------------------------------------------------------

#[tokio::test]
async fn resume_continues_without_the_pipeline_with_the_stored_payload_and_kept_dir() {
    let h = paused();

    assert_eq!(h.queue.resume("p1"), ok());
    flush().await;

    assert!(h.runs().is_empty());
    assert_eq!(h.resume_runs().len(), 1);
    let run = h.resume_runs()[0].clone();
    assert_eq!(run.args.input.job_id, "p1");
    assert_eq!(run.args.input.public_id, "aaaaaaaaaaaa");
    assert_eq!(run.args.input.payload, payload());
    assert_eq!(
        run.args.input.tmp_dir.to_string_lossy(),
        tmp("aaaaaaaaaaaa")
    );
    assert_eq!(run.args.config, config());
    let job = h.job("p1");
    assert_eq!(job.state, JobState::Uploading);
    assert_eq!(job.error_message, None);
    assert_eq!(job.mode, None);

    run.hooks.on_stage(JobState::Uploading);
    run.hooks.on_progress(50);
    let dto = &h.queue.list()[0];
    assert_eq!((dto.state, dto.progress), (JobState::Uploading, 50.0));

    run.hooks.on_before_register().await.unwrap();
    assert_eq!(h.job("p1").register_started, Some(true));

    run.resolve();
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.registered.unwrap()["public_id"], "aaaaaaaaaaaa");
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
    assert_eq!(job.tmp_dir, None);
    assert_eq!(job.register_started, None);
}

#[tokio::test]
async fn resume_wires_the_network_wait_hooks() {
    let h = paused();
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0]
        .hooks
        .on_network_wait(&wait_info(h.clock.ms(), 1));

    assert!(h.queue.list()[0].waiting_for_network);
}

#[tokio::test]
async fn resume_goes_back_to_upload_interrupted_when_the_network_fails_again() {
    let h = paused();
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0].reject(interrupted_error());
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::UploadInterrupted);
    assert_eq!(job.tmp_dir, Some(tmp("aaaaaaaaaaaa")));
    assert!(h.deleted().is_empty() && h.removed().is_empty());
}

#[tokio::test]
async fn resume_respects_max_concurrent_and_waits_for_a_free_slot() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/a.mp4", 1)]);
    h.add(&["/v/a.mp4"]).await;
    assert_eq!(h.runs().len(), 1);

    h.queue.resume("p1");
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::Waiting);
    assert_eq!(job.mode, Some(JobMode::Resume));
    assert!(h.resume_runs().is_empty());
    assert_eq!(
        h.dto("p1").waiting_reason.as_deref(),
        Some(WAITING_FOR_SLOT)
    );

    h.run(0).resolve();
    flush().await;

    assert_eq!(h.resume_runs().len(), 1);
    assert_eq!(h.job("p1").state, JobState::Uploading);
}

#[tokio::test]
async fn a_running_resume_occupies_a_processing_slot() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/a.mp4", 1)]);
    h.queue.resume("p1");
    h.add(&["/v/a.mp4"]).await;
    flush().await;

    assert!(h.runs().is_empty());
    h.resume_runs()[0].resolve();
    flush().await;
    assert_eq!(h.runs().len(), 1);
}

#[tokio::test]
async fn register_failures_after_a_resume_map_like_in_the_pipeline() {
    let h = paused();
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0].reject(register_error(
        PipelineErrorKind::RegisterFailed,
        "site down",
    ));
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::RegisterFailed);
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert_eq!(job.tmp_dir, None);
}

#[tokio::test]
async fn a_failed_resume_removes_leftovers_of_the_temp_dir() {
    let h = paused();
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0].reject(failed_error(JobState::Uploading, "boom"));
    flush().await;

    assert_eq!(h.job("p1").state, JobState::Failed);
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
}

#[tokio::test]
async fn cancelling_a_resume_run_ends_as_cancelled() {
    let h = paused();
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0].cancel_on_abort(JobState::Uploading);
    h.queue.cancel("p1").await;
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
}

fn resume_unavailable() -> PipelineError {
    let mut error = PipelineError::new(PipelineErrorKind::Failed, JobState::Uploading, "gone");
    error.code = Some(RESUME_UNAVAILABLE.into());
    error.prefix = Some(payload().disk_prefix);
    error
}

#[tokio::test]
async fn resume_unavailable_falls_back_to_a_new_run_and_deletes_the_old_prefix() {
    for started in [None, Some(false)] {
        let h = paused_harness(|j| j.register_started = started, |_| ());
        h.queue.resume("p1");
        flush().await;
        h.resume_runs()[0].reject(resume_unavailable());
        flush().await;
        flush().await;

        assert_eq!(h.deleted_prefixes(), [payload().disk_prefix]);
        assert!(h.removed().contains(&tmp("aaaaaaaaaaaa")));
        // A brand-new run with a NEW public id.
        assert_eq!(h.runs().len(), 1);
        assert_ne!(h.run(0).args.job.public_id, "aaaaaaaaaaaa");
        let job = h.job("p1");
        assert_eq!(job.state, JobState::Transcoding);
        assert_eq!(job.register_payload, Some(serde_json::Value::Null));
        assert_eq!(job.tmp_dir, None);
    }
}

#[tokio::test]
async fn resume_unavailable_never_deletes_r2_files_when_the_register_call_had_started() {
    let h = paused_harness(|j| j.register_started = Some(true), |_| ());
    h.queue.resume("p1");
    flush().await;
    h.resume_runs()[0].reject(resume_unavailable());
    flush().await;
    flush().await;

    assert!(h.deleted().is_empty());
    assert!(h.removed().contains(&tmp("aaaaaaaaaaaa")));
    assert_eq!(h.runs().len(), 1);
    assert_eq!(h.job("p1").register_started, None);
}

#[tokio::test]
async fn resume_is_refused_for_other_states_unknown_ids_missing_payload_and_double_clicks() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/a.mp4", 1)]);
    let mut no_payload = paused_record("nopayload");
    no_payload.register_payload = Some(serde_json::Value::Null);
    let mut failed = paused_record("failed");
    failed.state = JobState::Failed;
    h.push_jobs(vec![no_payload, failed]);

    assert!(!is_ok(&h.queue.resume("nope")));
    assert!(!is_ok(&h.queue.resume("nopayload")));
    assert!(!is_ok(&h.queue.resume("failed")));
    assert_eq!(h.queue.resume("p1"), ok());
    assert!(!is_ok(&h.queue.resume("p1")));
    flush().await;
    assert_eq!(h.resume_runs().len(), 1);
}

#[tokio::test]
async fn resume_requires_being_signed_in() {
    let h = paused_harness(|_| (), |o| o.auth = signed_out(None));

    assert_eq!(h.queue.resume("p1"), ActionResult::err(SIGN_IN_TO_RESUME));
    assert_eq!(h.job("p1").state, JobState::UploadInterrupted);
}

#[tokio::test]
async fn resume_is_refused_against_another_site() {
    let h = paused_harness(|j| j.site_origin = Some(OTHER.into()), |_| ());
    let result = h.queue.resume("p1");

    assert!(error_text(&result).contains("other.example.com"));
    flush().await;
    assert!(h.resume_runs().is_empty());
    assert_eq!(h.job("p1").state, JobState::UploadInterrupted);
}

#[tokio::test]
async fn a_queued_resume_returns_to_paused_when_the_site_changed_meanwhile() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/a.mp4", 1)]);
    h.add(&["/v/a.mp4"]).await;
    h.queue.resume("p1");
    h.set_auth(signed_in(Some(OTHER))).await;
    h.run(0).resolve();
    flush().await;

    let job = h.job("p1");
    assert_eq!(job.state, JobState::UploadInterrupted);
    assert!(job.error_message.unwrap().contains("site.example.com"));
    assert_eq!(job.mode, None);
    assert!(h.resume_runs().is_empty());
}

#[tokio::test]
async fn does_not_resume_automatically_after_signing_in_again() {
    let h = paused_harness(|_| (), |o| o.auth = signed_out(None));
    h.set_auth(signed_in(Some(SITE))).await;
    flush().await;

    assert!(h.resume_runs().is_empty());
    assert_eq!(h.job("p1").state, JobState::UploadInterrupted);
}

#[tokio::test]
async fn cancelling_a_queued_resume_discards_the_kept_files_like_a_running_cancel() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/a.mp4", 1)]);
    h.add(&["/v/a.mp4"]).await;
    h.queue.resume("p1");
    assert_eq!(h.queue.cancel("p1").await, ok());

    let job = h.job("p1");
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
    assert_eq!(job.mode, None);
    assert_eq!(h.deleted_prefixes(), [payload().disk_prefix]);
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
}

#[tokio::test]
async fn a_paused_upload_cannot_be_cancelled_directly() {
    let h = paused();

    assert!(!is_ok(&h.queue.cancel("p1").await));
}

// ---- start over, remove and clearFinished for paused uploads -------------------------------

#[tokio::test]
async fn start_over_removes_the_temp_dir_and_old_prefix_then_runs_with_a_new_public_id() {
    let h = paused();

    assert_eq!(h.queue.retry("p1").await, ok());
    flush().await;

    assert_eq!(h.deleted_prefixes(), [payload().disk_prefix]);
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
    assert_eq!(h.runs().len(), 1);
    assert_ne!(h.run(0).args.job.public_id, "aaaaaaaaaaaa");
    let job = h.job("p1");
    assert_eq!(job.state, JobState::Transcoding);
    assert_eq!(job.register_payload, Some(serde_json::Value::Null));
    assert_eq!(job.tmp_dir, None);
    assert!(h.resume_runs().is_empty());
}

#[tokio::test]
async fn start_over_keeps_the_r2_files_when_the_register_call_had_started() {
    let h = paused_harness(|j| j.register_started = Some(true), |_| ());
    h.queue.retry("p1").await;

    assert!(h.deleted().is_empty());
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
    assert!(h.logged("may be orphaned"));
    assert_eq!(h.job("p1").register_started, None);
}

#[tokio::test]
async fn start_over_still_works_without_a_config_for_the_cleanup() {
    let h = paused_harness(|_| (), |o| o.config = None);
    h.queue.retry("p1").await;

    assert!(h.deleted().is_empty());
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
    assert_eq!(h.job("p1").state, JobState::Waiting);
}

#[tokio::test]
async fn remove_deletes_the_temp_dir_and_the_r2_prefix_of_a_paused_upload() {
    let h = paused();

    assert_eq!(h.queue.remove("p1").await, ok());
    assert!(h.states().is_empty());
    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
    assert_eq!(h.deleted_prefixes(), [payload().disk_prefix]);
}

#[tokio::test]
async fn remove_keeps_the_r2_files_when_the_site_may_have_registered_the_video() {
    let h = paused_harness(|j| j.register_started = Some(true), |_| ());
    h.queue.remove("p1").await;

    assert_eq!(h.removed(), [tmp("aaaaaaaaaaaa")]);
    assert!(h.deleted().is_empty());
}

#[tokio::test]
async fn remove_skips_r2_cleanup_for_another_site_or_without_config_but_removes_the_dir() {
    let other = paused_harness(|j| j.site_origin = Some(OTHER.into()), |_| ());
    let no_config = paused_harness(|_| (), |o| o.config = None);

    other.queue.remove("p1").await;
    no_config.queue.remove("p1").await;

    assert!(other.deleted().is_empty());
    assert_eq!(other.removed(), [tmp("aaaaaaaaaaaa")]);
    assert!(no_config.deleted().is_empty());
    assert_eq!(no_config.removed(), [tmp("aaaaaaaaaaaa")]);
    assert!(other.states().is_empty());
}

#[tokio::test]
async fn clear_finished_never_touches_paused_uploads() {
    let h = paused();
    let mut failed = paused_record("f");
    failed.state = JobState::Failed;
    failed.tmp_dir = None;
    h.push_jobs(vec![failed]);
    h.queue.clear_finished();

    assert_eq!(h.states(), ["p1:upload_interrupted"]);
    assert!(h.removed().is_empty() && h.deleted().is_empty());
}

#[tokio::test]
async fn keeps_the_source_file_deduplicated_while_the_upload_is_paused() {
    let h = paused_harness(|_| (), |o| o.files = vec![("/v/p1.mp4", 1)]);

    assert_eq!(h.add(&["/v/p1.mp4"]).await.added, 0);
}

// ---- recovery of paused uploads ------------------------------------------------------------

#[tokio::test]
async fn recovery_keeps_uploads_with_payload_and_temp_dir_and_interrupts_the_rest() {
    let up = tmp("upxxxxxxxxxx");
    let rg = tmp("rgxxxxxxxxxx");
    let up_static: &'static str = Box::leak(up.clone().into_boxed_str());
    let rg_static: &'static str = Box::leak(rg.into_boxed_str());
    let h = Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![(up_static, -1), (rg_static, -1)];
    });
    let running = |id: &str, state: JobState| {
        let public_id = format!("{id:x<12}");
        let mut job = paused_record(id);
        job.state = state;
        job.tmp_dir = Some(tmp(&public_id));
        job.public_id = Some(public_id);
        job.error_message = None;
        job.error_detail = None;
        job
    };
    let mut rg_job = running("rg", JobState::Registering);
    rg_job.register_started = Some(true);
    let mut nopay = running("nopay", JobState::Uploading);
    nopay.register_payload = Some(serde_json::Value::Null);
    let mut tc = running("tc", JobState::Transcoding);
    tc.register_payload = Some(serde_json::Value::Null);
    tc.tmp_dir = None;
    let mut wr = running("wr", JobState::Waiting);
    wr.mode = Some(JobMode::Resume);
    h.push_jobs(vec![
        running("up", JobState::Uploading),
        rg_job,
        running("gone", JobState::Uploading),
        nopay,
        tc,
        wr,
        running("keep", JobState::UploadInterrupted),
    ]);

    h.queue.recover().await;

    assert_eq!(
        h.states(),
        [
            "up:upload_interrupted",
            "rg:upload_interrupted",
            "gone:interrupted",
            "nopay:interrupted",
            "tc:interrupted",
            "wr:upload_interrupted",
            "keep:upload_interrupted"
        ]
    );
    let job = h.job("up");
    assert_eq!(job.error_message.as_deref(), Some(RECOVERED_UPLOAD_MESSAGE));
    assert_eq!(job.error_detail.as_ref().unwrap()["step"], "uploading");
    assert_eq!(job.register_payload_typed(), Some(payload()));
    assert_eq!(job.tmp_dir, Some(up));
    assert_eq!(job.finished_at, None);
    assert_eq!(h.job("rg").register_started, Some(true));
    assert_eq!(h.job("wr").mode, None);
    assert_eq!(h.job("gone").tmp_dir, None);
    // Kept jobs keep their temp dirs; the others are cleaned like before. Never R2.
    let mut removed = h.removed();
    removed.sort();
    let mut expected = vec![
        tmp("gonexxxxxxxx"),
        tmp("nopayxxxxxxx"),
        tmp("tcxxxxxxxxxx"),
    ];
    expected.sort();
    assert_eq!(removed, expected);
    assert!(h.deleted().is_empty());
    assert!(h.queue.has_paused_uploads());
    assert!(h.dto("up").can_resume);
}
