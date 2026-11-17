//! The real `QuitDeps`: native confirm dialog (dialog plugin, called from Rust only), the queue's
//! bounded shutdown, the store flush and `AppHandle::exit`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::quit::{
    QuitDeps, KEEP_WORKING_BUTTON, QUIT_BUTTON, QUIT_DIALOG_MESSAGE, QUIT_DIALOG_TITLE,
};
use crate::logger::Log;
use crate::queue::JobQueue;
use crate::store::AppStore;
use crate::window::MAIN_WINDOW_LABEL;

pub struct TauriQuitDeps<R: Runtime> {
    pub app: AppHandle<R>,
    pub queue: Arc<JobQueue>,
    pub store: Arc<AppStore>,
    pub logger: Arc<dyn Log>,
}

#[async_trait]
impl<R: Runtime> QuitDeps for TauriQuitDeps<R> {
    fn has_active_jobs(&self) -> bool {
        self.queue.has_active_jobs()
    }

    async fn confirm(&self) -> bool {
        let app = self.app.clone();

        // A blocking native dialog must not run on an async worker.
        tauri::async_runtime::spawn_blocking(move || {
            let mut dialog = app
                .dialog()
                .message(QUIT_DIALOG_MESSAGE)
                .title(QUIT_DIALOG_TITLE)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    QUIT_BUTTON.to_string(),
                    KEEP_WORKING_BUTTON.to_string(),
                ));

            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                dialog = dialog.parent(&window);
            }

            dialog.blocking_show()
        })
        .await
        // A failed dialog never quits: keep working.
        .unwrap_or(false)
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.queue.shutdown().await;

        Ok(())
    }

    async fn flush(&self) {
        let store = Arc::clone(&self.store);

        // `flush` blocks until the file is written: keep it off the async workers.
        let _ = tauri::async_runtime::spawn_blocking(move || store.flush()).await;
    }

    fn quit(&self) {
        self.app.exit(0);
    }

    fn on_error(&self, error: &str) {
        self.logger
            .error("Shutdown failed", Some(json!({ "error": error })));
    }
}
