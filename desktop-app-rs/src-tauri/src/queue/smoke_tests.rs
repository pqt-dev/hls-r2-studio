//! Frontend-free end-to-end smoke test: the same plain functions the Tauri commands call
//! (`ipc::add_paths`, `ipc::job_action`, `ipc::open_embed`, `ipc::copy`) over the real queue with
//! a fake pipeline, store and clock. No Tauri runtime, no window, no network, no ffmpeg.

use std::sync::Mutex;

use async_trait::async_trait;

use super::testing::*;
use crate::dto::{ActionResult, CopyKind, JobState};
use crate::ipc::{add_paths, copy, job_action, open_embed, JobAction, JobsDesktop};
use crate::logger::testing::RecordingLogger;

#[derive(Default)]
struct Desktop {
    clipboard: Mutex<Vec<String>>,
    opened: Mutex<Vec<String>>,
}

#[async_trait]
impl JobsDesktop for Desktop {
    async fn pick_video_files(&self) -> Option<Vec<String>> {
        None
    }

    fn write_clipboard(&self, text: &str) -> Result<(), String> {
        self.clipboard.lock().unwrap().push(text.to_string());
        Ok(())
    }

    fn open_external(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

fn harness() -> Harness {
    Harness::with(|o| {
        o.auth = signed_in(Some(SITE));
        o.files = vec![("/v/a.mp4", 10), ("/v/b.mp4", 20)];
    })
}

#[tokio::test]
async fn add_run_done_then_open_and_copy() {
    let h = harness();
    let added = add_paths(&h.queue, &["/v/a.mp4".to_string()]).await;

    assert_eq!(
        (added.added, added.rejected.len(), added.canceled),
        (1, 0, false)
    );
    flush().await;
    assert_eq!(h.runs().len(), 1);

    h.run(0).resolve();
    flush().await;

    let dto = h.dto("job-1");
    assert_eq!(dto.state, JobState::Done);
    assert!(dto.can_remove && !dto.can_cancel);

    let desktop = Desktop::default();
    let logger = RecordingLogger::default();
    let id = h.job("job-1").public_id.unwrap();

    assert_eq!(
        open_embed(&h.queue, &desktop, Some(SITE), "job-1", &logger),
        ActionResult::Ok
    );
    assert_eq!(
        *desktop.opened.lock().unwrap(),
        [format!("{SITE}/embed/{id}")]
    );
    assert_eq!(
        copy(&h.queue, &desktop, "job-1", CopyKind::Shortcode, &logger),
        ActionResult::Ok
    );
    assert_eq!(
        *desktop.clipboard.lock().unwrap(),
        [format!("[hls_embed_vl id=\"{id}\"]")]
    );
    assert_eq!(
        job_action(&h.queue, JobAction::Remove, "job-1").await,
        ActionResult::Ok
    );
    assert!(h.queue.list().is_empty());
}

#[tokio::test]
async fn add_then_cancel_cleans_up_and_never_touches_the_source() {
    let h = harness();

    add_paths(&h.queue, &["/v/a.mp4".to_string()]).await;
    flush().await;
    assert_eq!(h.runs().len(), 1);

    assert_eq!(
        job_action(&h.queue, JobAction::Cancel, "job-1").await,
        ActionResult::Ok
    );
    assert!(h.run(0).cancel.is_cancelled());
    h.run(0).cancel_on_abort(JobState::Transcoding);
    flush().await;

    assert_eq!(h.dto("job-1").state, JobState::Cancelled);
    assert!(!h.queue.has_active_jobs());
    // Only temp data is ever removed; the source video is a file the fake still lists.
    assert!(h.backend.files.lock().unwrap().contains_key("/v/a.mp4"));
}

#[tokio::test]
async fn add_upload_interrupted_then_resume_never_reruns_the_pipeline() {
    let h = harness();

    add_paths(&h.queue, &["/v/a.mp4".to_string()]).await;
    flush().await;
    h.run(0).reject(interrupted_error());
    flush().await;

    let dto = h.dto("job-1");
    assert_eq!(dto.state, JobState::UploadInterrupted);
    assert!(dto.can_resume);

    assert_eq!(
        job_action(&h.queue, JobAction::Resume, "job-1").await,
        ActionResult::Ok
    );
    flush().await;
    assert_eq!(
        h.runs().len(),
        1,
        "resume must not start a new pipeline run"
    );
    assert_eq!(h.resume_runs().len(), 1);

    h.resume_runs()[0].resolve();
    flush().await;
    assert_eq!(h.dto("job-1").state, JobState::Done);
}
