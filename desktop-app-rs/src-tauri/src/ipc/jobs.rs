//! `jobs:*` commands (port of desktop-app/src/main/ipc/jobsHandlers.ts). Each command validates
//! its payload first (a malformed call is rejected with "Request failed"), then calls a plain
//! handler function below; the handlers take the queue and a `JobsDesktop` (dialog, clipboard,
//! browser) so they are tested without Tauri.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::auth::rejected;
use super::validate::{
    expect_no_args, parse_add_paths, parse_copy, parse_job_id_payload, MAX_ADD_PATHS,
};
use super::IpcError;
use crate::desktop::{is_embed_url_of_site, open_external_https};
use crate::dto::{ActionResult, AddFilesResult, CopyKind, JobDto};
use crate::logger::Log;
use crate::queue::job_dto::registered_field;
use crate::queue::{JobQueue, VIDEO_EXTENSIONS};
use crate::state::AppState;
use crate::window::MAIN_WINDOW_LABEL;

pub const NO_EMBED_URL: &str = "This video has no embed URL yet.";
pub const FOREIGN_EMBED_URL: &str = "The embed URL does not belong to the signed-in site.";
pub const OPEN_FAILED: &str = "Could not open the link.";
pub const NOT_REGISTERED: &str = "This video is not registered yet.";
pub const INVALID_VIDEO_ID: &str = "The video ID is not valid.";
pub const CLIPBOARD_FAILED: &str = "Could not copy to the clipboard.";

/// What the jobs handlers need from the desktop (Electron adapters in the TS app).
#[async_trait]
pub trait JobsDesktop: Send + Sync {
    /// Native multi-file dialog; `None` when the user cancelled.
    async fn pick_video_files(&self) -> Option<Vec<String>>;
    /// Native single-image dialog (jpg, jpeg, png, webp); `None` when the user cancelled.
    async fn pick_image_file(&self) -> Option<String> {
        None
    }
    fn write_clipboard(&self, text: &str) -> Result<(), String>;
    /// Opens an https URL that already passed every check.
    fn open_external(&self, url: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobAction {
    Cancel,
    Retry,
    RetryRegister,
    Resume,
    Remove,
}

pub async fn add_files(queue: &Arc<JobQueue>, desktop: &dyn JobsDesktop) -> AddFilesResult {
    let Some(mut paths) = desktop.pick_video_files().await.filter(|p| !p.is_empty()) else {
        return AddFilesResult {
            added: 0,
            rejected: vec![],
            canceled: true,
        };
    };

    // The paths come from our own dialog but are validated like any other input.
    paths.truncate(MAX_ADD_PATHS);

    let outcome = queue.add_files(&paths).await;

    AddFilesResult {
        added: outcome.added,
        rejected: outcome.rejected,
        canceled: false,
    }
}

/// Dropped paths: the queue validates each one (absolute, video extension, exists, regular
/// file, not empty, not already queued); rejections carry the file NAME only.
pub async fn add_paths(queue: &Arc<JobQueue>, paths: &[String]) -> AddFilesResult {
    let outcome = queue.add_files(paths).await;

    AddFilesResult {
        added: outcome.added,
        rejected: outcome.rejected,
        canceled: false,
    }
}

pub async fn job_action(queue: &Arc<JobQueue>, action: JobAction, id: &str) -> ActionResult {
    match action {
        JobAction::Cancel => queue.cancel(id).await,
        JobAction::Retry => queue.retry(id).await,
        JobAction::RetryRegister => queue.retry_register(id),
        JobAction::Resume => queue.resume(id),
        JobAction::Remove => queue.remove(id).await,
    }
}

/// Opens the embed URL of a registered video, only when it is https on the signed-in site.
pub fn open_embed(
    queue: &JobQueue,
    desktop: &dyn JobsDesktop,
    site_url: Option<&str>,
    id: &str,
    logger: &dyn Log,
) -> ActionResult {
    let job = queue.get_job(id);
    let Some(embed_url) = job.as_ref().and_then(|j| registered_field(j, "embed_url")) else {
        return ActionResult::err(NO_EMBED_URL);
    };

    if !is_embed_url_of_site(embed_url, site_url) {
        return ActionResult::err(FOREIGN_EMBED_URL);
    }

    match open_external_https(embed_url, |url| desktop.open_external(url)) {
        Ok(true) => ActionResult::Ok,
        Ok(false) => ActionResult::err(OPEN_FAILED),
        Err(error) => {
            logger.warn(
                "Could not open the embed URL",
                Some(json!({ "error": error })),
            );
            ActionResult::err(OPEN_FAILED)
        }
    }
}

/// The id ends up inside a quoted shortcode attribute: keep it strictly `[a-z0-9]{1,32}`.
fn is_friendly_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The `[hls_embed_vl id="..."]` shortcode of a video, or `None` when the public id is not
/// strictly `[a-z0-9]{1,32}`. Shared by the Queue copy and the Library quick action.
pub(super) fn embed_shortcode(public_id: &str) -> Option<String> {
    is_friendly_id(public_id).then(|| format!("[hls_embed_vl id=\"{public_id}\"]"))
}

/// Copies the embed URL or the `[hls_embed_vl id="..."]` shortcode of a registered video.
pub fn copy(
    queue: &JobQueue,
    desktop: &dyn JobsDesktop,
    id: &str,
    kind: CopyKind,
    logger: &dyn Log,
) -> ActionResult {
    let job = queue.get_job(id);
    let registered = job.as_ref().and_then(|j| {
        Some((
            registered_field(j, "embed_url")?,
            registered_field(j, "public_id")?,
        ))
    });
    let Some((embed_url, public_id)) = registered else {
        return ActionResult::err(NOT_REGISTERED);
    };
    let text = match kind {
        CopyKind::EmbedUrl => embed_url.to_string(),
        CopyKind::Shortcode => match embed_shortcode(public_id) {
            Some(shortcode) => shortcode,
            None => return ActionResult::err(INVALID_VIDEO_ID),
        },
    };

    match desktop.write_clipboard(&text) {
        Ok(()) => ActionResult::Ok,
        Err(error) => {
            logger.warn(
                "Could not write the clipboard",
                Some(json!({ "error": error })),
            );
            ActionResult::err(CLIPBOARD_FAILED)
        }
    }
}

/// The built-in site origin; the only host embed links may open (`auth.getSiteUrl()`).
pub(super) fn site_url(state: &AppState) -> Option<String> {
    Some(state.auth.get_site_url()).filter(|url| !url.is_empty())
}

// ---- Tauri side --------------------------------------------------------------------------

/// The real desktop: dialog plugin (from Rust only), arboard, ShellExecuteW / opener.
pub struct TauriJobsDesktop<R: Runtime> {
    pub window: WebviewWindow<R>,
}

#[async_trait]
impl<R: Runtime> JobsDesktop for TauriJobsDesktop<R> {
    async fn pick_video_files(&self) -> Option<Vec<String>> {
        let parent = self
            .window
            .app_handle()
            .get_webview_window(MAIN_WINDOW_LABEL)
            .unwrap_or_else(|| self.window.clone());

        // The blocking dialog must not run on the main thread or an async worker.
        tauri::async_runtime::spawn_blocking(move || {
            let picked = parent
                .dialog()
                .file()
                .set_parent(&parent)
                .set_title("Upload videos")
                .add_filter("Videos", &VIDEO_EXTENSIONS)
                .blocking_pick_files()?;

            Some(
                picked
                    .into_iter()
                    .filter_map(|p| p.into_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            )
        })
        .await
        .ok()
        .flatten()
    }

    async fn pick_image_file(&self) -> Option<String> {
        let parent = self
            .window
            .app_handle()
            .get_webview_window(MAIN_WINDOW_LABEL)
            .unwrap_or_else(|| self.window.clone());

        // The blocking dialog must not run on the main thread or an async worker.
        tauri::async_runtime::spawn_blocking(move || {
            let picked = parent
                .dialog()
                .file()
                .set_parent(&parent)
                .set_title("Choose a thumbnail image")
                .add_filter("Images", &["jpg", "jpeg", "png", "webp"])
                .blocking_pick_file()?;

            picked
                .into_path()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .await
        .ok()
        .flatten()
    }

    fn write_clipboard(&self, text: &str) -> Result<(), String> {
        crate::desktop::write_clipboard(text)
    }

    fn open_external(&self, url: &str) -> Result<(), String> {
        crate::desktop::open_url(url)
    }
}

#[tauri::command]
pub fn jobs_list(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<Vec<JobDto>, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "jobs:list", e))?;

    Ok(state.queue.list())
}

#[tauri::command]
pub async fn jobs_add_files<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AddFilesResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "jobs:add-files", e))?;

    Ok(add_files(&state.queue, &TauriJobsDesktop { window }).await)
}

#[tauri::command]
pub async fn jobs_add_paths(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AddFilesResult, IpcError> {
    let paths = parse_add_paths(payload).map_err(|e| rejected(&state, "jobs:add-paths", e))?;

    Ok(add_paths(&state.queue, &paths).await)
}

async fn id_command(
    state: &AppState,
    payload: Option<Value>,
    channel: &str,
    name: &str,
    action: JobAction,
) -> Result<ActionResult, IpcError> {
    let id = parse_job_id_payload(payload, name).map_err(|e| rejected(state, channel, e))?;

    Ok(job_action(&state.queue, action, &id).await)
}

#[tauri::command]
pub async fn jobs_cancel(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    id_command(&state, payload, "jobs:cancel", "cancel", JobAction::Cancel).await
}

#[tauri::command]
pub async fn jobs_retry(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    id_command(&state, payload, "jobs:retry", "retry", JobAction::Retry).await
}

#[tauri::command]
pub async fn jobs_retry_register(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    id_command(
        &state,
        payload,
        "jobs:retry-register",
        "retry-register",
        JobAction::RetryRegister,
    )
    .await
}

#[tauri::command]
pub async fn jobs_resume(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    id_command(&state, payload, "jobs:resume", "resume", JobAction::Resume).await
}

#[tauri::command]
pub async fn jobs_remove(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    id_command(&state, payload, "jobs:remove", "remove", JobAction::Remove).await
}

#[tauri::command]
pub fn jobs_clear_finished(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "jobs:clear-finished", e))?;

    Ok(state.queue.clear_finished())
}

/// Off the main thread: the OS call may take a moment.
#[tauri::command(async)]
pub fn jobs_open_embed<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let id = parse_job_id_payload(payload, "open-embed")
        .map_err(|e| rejected(&state, "jobs:open-embed", e))?;

    Ok(open_embed(
        &state.queue,
        &TauriJobsDesktop { window },
        site_url(&state).as_deref(),
        &id,
        &*state.logger,
    ))
}

#[tauri::command(async)]
pub fn jobs_copy<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let (id, kind) = parse_copy(payload).map_err(|e| rejected(&state, "jobs:copy", e))?;

    Ok(copy(
        &state.queue,
        &TauriJobsDesktop { window },
        &id,
        kind,
        &*state.logger,
    ))
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::dto::JobState;
    use crate::logger::testing::RecordingLogger;
    use crate::queue::testing::{record, signed_out, Harness};

    const EMBED: &str = "https://site.example.com/embed/abc123";
    const SITE: Option<&str> = Some("https://site.example.com");

    /// Shared with the videos tests (`ipc/videos.rs`).
    #[derive(Default)]
    pub(in crate::ipc) struct FakeDesktop {
        pub(in crate::ipc) picked: Option<Vec<String>>,
        pub(in crate::ipc) picked_image: Option<String>,
        pub(in crate::ipc) clipboard: Mutex<Vec<String>>,
        pub(in crate::ipc) opened: Mutex<Vec<String>>,
        pub(in crate::ipc) clipboard_fails: bool,
    }

    #[async_trait]
    impl JobsDesktop for FakeDesktop {
        async fn pick_video_files(&self) -> Option<Vec<String>> {
            self.picked.clone()
        }

        async fn pick_image_file(&self) -> Option<String> {
            self.picked_image.clone()
        }

        fn write_clipboard(&self, text: &str) -> Result<(), String> {
            if self.clipboard_fails {
                return Err("busy".into());
            }

            self.clipboard.lock().unwrap().push(text.to_string());
            Ok(())
        }

        fn open_external(&self, url: &str) -> Result<(), String> {
            self.opened.lock().unwrap().push(url.to_string());
            Ok(())
        }
    }

    fn registered_job(embed: &str, public_id: &str) -> crate::store::JobRecord {
        let mut job = record("j1", JobState::Done);
        job.public_id = Some(public_id.into());
        job.registered = Some(json!({ "id": 1, "public_id": public_id, "embed_url": embed }));
        job
    }

    fn harness_with(job: Option<crate::store::JobRecord>) -> Harness {
        let h = Harness::with(|o| {
            o.auth = signed_out(None);
            o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)];
        });
        h.push_jobs(job.into_iter().collect());
        h
    }

    #[tokio::test]
    async fn add_files_opens_the_dialog_and_enqueues_the_picked_paths() {
        let h = harness_with(None);
        let desktop = FakeDesktop {
            picked: Some(vec!["/v/a.mp4".into(), "/v/b.mp4".into()]),
            ..FakeDesktop::default()
        };

        assert_eq!(
            add_files(&h.queue, &desktop).await,
            AddFilesResult {
                added: 2,
                rejected: vec![],
                canceled: false
            }
        );
        assert_eq!(h.store.read(|d| d.jobs.len()), 2);
    }

    #[tokio::test]
    async fn add_files_reports_a_cancelled_or_empty_dialog() {
        let h = harness_with(None);

        for picked in [None, Some(vec![])] {
            let desktop = FakeDesktop {
                picked,
                ..FakeDesktop::default()
            };

            assert_eq!(
                add_files(&h.queue, &desktop).await,
                AddFilesResult {
                    added: 0,
                    rejected: vec![],
                    canceled: true
                }
            );
        }
        assert!(h.store.read(|d| d.jobs.is_empty()));
    }

    #[tokio::test]
    async fn add_files_caps_the_number_of_picked_paths() {
        let h = harness_with(None);
        let desktop = FakeDesktop {
            picked: Some(
                (0..MAX_ADD_PATHS + 5)
                    .map(|i| format!("/v/{i}.txt"))
                    .collect(),
            ),
            ..FakeDesktop::default()
        };
        let result = add_files(&h.queue, &desktop).await;

        assert_eq!(result.rejected.len(), MAX_ADD_PATHS);
    }

    #[tokio::test]
    async fn add_paths_lets_the_queue_validate_and_returns_file_names_only() {
        let h = harness_with(None);
        let result = add_paths(
            &h.queue,
            &[
                "/v/a.mp4".into(),
                "/home/user/secret/notes.txt".into(),
                "/v/missing.mp4".into(),
            ],
        )
        .await;

        assert_eq!(result.added, 1);
        assert!(!result.canceled);
        assert_eq!(
            result
                .rejected
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["notes.txt", "missing.mp4"]
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("/home"));
    }

    #[tokio::test]
    async fn routes_cancel_retry_retry_register_resume_and_remove() {
        let h = harness_with(None);
        h.add(&["/v/a.mp4"]).await;

        assert_eq!(
            job_action(&h.queue, JobAction::Cancel, "job-1").await,
            ActionResult::Ok
        );
        assert_eq!(h.job("job-1").state, JobState::Cancelled);
        assert_eq!(
            job_action(&h.queue, JobAction::Retry, "job-1").await,
            ActionResult::Ok
        );
        assert_eq!(h.job("job-1").state, JobState::Waiting);
        assert_eq!(
            job_action(&h.queue, JobAction::RetryRegister, "job-1").await,
            ActionResult::err(crate::queue::job_queue::CANNOT_REGISTER)
        );
        assert_eq!(
            job_action(&h.queue, JobAction::Resume, "job-1").await,
            ActionResult::err(crate::queue::job_queue::CANNOT_RESUME)
        );
        assert_eq!(
            job_action(&h.queue, JobAction::Remove, "job-1").await,
            ActionResult::err(crate::queue::job_queue::CANNOT_REMOVE)
        );
        job_action(&h.queue, JobAction::Cancel, "job-1").await;
        assert_eq!(
            job_action(&h.queue, JobAction::Remove, "job-1").await,
            ActionResult::Ok
        );
        assert!(h.queue.list().is_empty());
    }

    #[tokio::test]
    async fn copy_writes_the_embed_url_or_the_shortcode() {
        let h = harness_with(Some(registered_job(EMBED, "abc123")));
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            copy(&h.queue, &desktop, "j1", CopyKind::EmbedUrl, &log),
            ActionResult::Ok
        );
        assert_eq!(
            copy(&h.queue, &desktop, "j1", CopyKind::Shortcode, &log),
            ActionResult::Ok
        );
        assert_eq!(
            *desktop.clipboard.lock().unwrap(),
            [EMBED, "[hls_embed_vl id=\"abc123\"]"]
        );
    }

    #[tokio::test]
    async fn copy_refuses_unregistered_jobs_and_unsafe_public_ids() {
        let log = RecordingLogger::default();
        let mut unregistered = registered_job(EMBED, "abc123");
        unregistered.registered = None;
        let none = harness_with(Some(unregistered));
        let desktop = FakeDesktop::default();

        assert_eq!(
            copy(&none.queue, &desktop, "j1", CopyKind::EmbedUrl, &log),
            ActionResult::err(NOT_REGISTERED)
        );

        let unsafe_id = harness_with(Some(registered_job(EMBED, "a\"b")));
        assert_eq!(
            copy(&unsafe_id.queue, &desktop, "j1", CopyKind::Shortcode, &log),
            ActionResult::err(INVALID_VIDEO_ID)
        );
        assert!(desktop.clipboard.lock().unwrap().is_empty());

        let missing = harness_with(None);
        assert_eq!(
            copy(&missing.queue, &desktop, "zz", CopyKind::EmbedUrl, &log),
            ActionResult::err(NOT_REGISTERED)
        );

        let failing = FakeDesktop {
            clipboard_fails: true,
            ..FakeDesktop::default()
        };
        let ok = harness_with(Some(registered_job(EMBED, "abc123")));
        assert_eq!(
            copy(&ok.queue, &failing, "j1", CopyKind::EmbedUrl, &log),
            ActionResult::err(CLIPBOARD_FAILED)
        );
    }

    #[tokio::test]
    async fn open_embed_opens_an_https_embed_url_of_the_signed_in_site_only() {
        let log = RecordingLogger::default();
        let ok = harness_with(Some(registered_job(EMBED, "abc123")));
        let desktop = FakeDesktop::default();

        assert_eq!(
            open_embed(&ok.queue, &desktop, SITE, "j1", &log),
            ActionResult::Ok
        );
        assert_eq!(*desktop.opened.lock().unwrap(), [EMBED]);

        let refused = FakeDesktop::default();
        let cases = [
            (
                harness_with(Some(registered_job(
                    "https://evil.example.com/embed/abc123",
                    "abc123",
                ))),
                SITE,
                FOREIGN_EMBED_URL,
            ),
            (
                harness_with(Some(registered_job(
                    "http://site.example.com/embed/abc123",
                    "abc123",
                ))),
                SITE,
                FOREIGN_EMBED_URL,
            ),
            (
                harness_with(Some(registered_job(EMBED, "abc123"))),
                None,
                FOREIGN_EMBED_URL,
            ),
            (
                harness_with(Some(registered_job(
                    "https://user@site.example.com/embed/abc123",
                    "abc123",
                ))),
                SITE,
                OPEN_FAILED,
            ),
            (harness_with(None), SITE, NO_EMBED_URL),
        ];

        for (h, site, error) in cases {
            assert_eq!(
                open_embed(&h.queue, &refused, site, "j1", &log),
                ActionResult::err(error)
            );
        }
        assert!(refused.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn friendly_ids() {
        assert!(is_friendly_id("abc123"));
        assert!(!is_friendly_id(""));
        assert!(!is_friendly_id("ABC"));
        assert!(!is_friendly_id(&"a".repeat(33)));
        assert!(!is_friendly_id("a\"b"));
    }
}
