use serde_json::Value;
use tauri::{Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::auth::rejected;
use super::validate::{expect_no_args, parse_settings_patch};
use super::IpcError;
use crate::dto::{PickDirectoryResult, SettingsDto, SettingsResult};
use crate::settings::is_absolute_native;
use crate::state::AppState;
use crate::window::MAIN_WINDOW_LABEL;

#[tauri::command]
pub fn settings_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<SettingsDto, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "settings:get", e))?;

    Ok(state.settings.get())
}

/// Validates and saves. `async` so the folder check runs off the main thread.
#[tauri::command(async)]
pub fn settings_set(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<SettingsResult, IpcError> {
    // Unknown keys (such as `siteUrl`) are rejected; details are only logged.
    let patch = parse_settings_patch(payload).map_err(|e| rejected(&state, "settings:set", e))?;

    Ok(state.settings.set(&patch))
}

/// Native folder dialog. Nothing is saved here: the renderer saves the path with `settings_set`,
/// which validates it again. The dialog is opened from Rust, so the dialog plugin needs no
/// capability for the webview.
#[tauri::command(async)]
pub fn settings_pick_directory<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<PickDirectoryResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "settings:pick-directory", e))?;

    Ok(pick_directory(window))
}

fn pick_directory<R: Runtime>(window: WebviewWindow<R>) -> PickDirectoryResult {
    let parent = window
        .app_handle()
        .get_webview_window(MAIN_WINDOW_LABEL)
        .unwrap_or(window);
    let picked = parent
        .dialog()
        .file()
        .set_parent(&parent)
        .set_title("Choose temporary folder")
        .blocking_pick_folder();

    // Only an absolute path from our own dialog is handed back.
    match picked.and_then(|p| p.into_path().ok()) {
        Some(path) => {
            let text = path.to_string_lossy().into_owned();

            if text.is_empty() || !is_absolute_native(&text) {
                PickDirectoryResult::Canceled
            } else {
                PickDirectoryResult::Picked(text)
            }
        }
        None => PickDirectoryResult::Canceled,
    }
}
