use serde_json::Value;
use tauri::{Manager, Runtime, State, WebviewWindow};

use super::auth::rejected;
use super::notices::{
    dev_app_dir, is_regular_file, notices_path, notices_result, open_notices, NoticesOutcome,
};
use super::validate::expect_no_args;
use super::IpcError;
use crate::dto::{ActionResult, DiagnosticsDto};
use crate::ffmpeg::FfmpegStatus;
use crate::logger::Log;
use crate::os_open::open_folder;
use crate::state::AppState;

/// Electron-style platform name (`process.platform`) for the renderer.
pub fn platform_name(os: &str) -> &str {
    match os {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub fn build_diagnostics(ffmpeg: &FfmpegStatus) -> DiagnosticsDto {
    DiagnosticsDto {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: platform_name(std::env::consts::OS).to_string(),
        // `checked: false` until the background startup self check has finished.
        ffmpeg: ffmpeg.get(),
    }
}

#[tauri::command]
pub fn app_get_version(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<String, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "app:get-version", e))?;

    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub fn app_open_logs_folder(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "app:open-logs-folder", e))?;

    Ok(open_logs_folder(&state))
}

fn open_logs_folder(state: &AppState) -> ActionResult {
    // The folder is created on the first log line; make sure it exists before opening it.
    let opened =
        std::fs::create_dir_all(&state.logs_dir).and_then(|()| open_folder(&state.logs_dir));

    match opened {
        Ok(()) => ActionResult::Ok,
        Err(error) => {
            state.logger.warn(
                "Could not open the logs folder",
                Some(serde_json::json!({ "error": crate::logger::error_to_value(&error) })),
            );
            ActionResult::err("Could not open the logs folder.")
        }
    }
}

/// Opens the bundled third-party notices file (`ipc/notices.rs`). Off the main thread: the OS
/// call may take a moment.
#[tauri::command(async)]
pub fn app_open_notices<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "app:open-notices", e))?;

    let resources = window
        .app_handle()
        .path()
        .resource_dir()
        .unwrap_or_default();
    let path = notices_path(!cfg!(debug_assertions), &resources, &dev_app_dir());
    let outcome = open_notices(&path, is_regular_file, crate::desktop::open_path);

    if outcome != NoticesOutcome::Opened {
        state.logger.warn(
            "Could not open the notices file",
            Some(serde_json::json!({ "outcome": format!("{outcome:?}") })),
        );
    }

    Ok(notices_result(outcome))
}

#[tauri::command]
pub fn diagnostics_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<DiagnosticsDto, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "diagnostics:get", e))?;

    Ok(build_diagnostics(&state.ffmpeg))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::dto::FfmpegDiagnostics;

    #[test]
    fn version_is_the_package_version() {
        assert_eq!(
            build_diagnostics(&FfmpegStatus::new()).app_version,
            env!("CARGO_PKG_VERSION")
        );
    }

    #[test]
    fn diagnostics_report_the_finished_self_check() {
        let status = FfmpegStatus::new();
        status.set(FfmpegDiagnostics {
            checked: true,
            ok: false,
            version: None,
            missing: vec!["ffmpeg:version".into()],
        });

        let dto = build_diagnostics(&status);

        assert!(dto.ffmpeg.checked && !dto.ffmpeg.ok);
        assert_eq!(dto.ffmpeg.missing, vec!["ffmpeg:version".to_string()]);
    }

    #[test]
    fn diagnostics_report_unchecked_ffmpeg() {
        let dto = build_diagnostics(&FfmpegStatus::new());

        assert_eq!(dto.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!dto.platform.is_empty());
        assert!(!dto.ffmpeg.checked && !dto.ffmpeg.ok);
        assert!(dto.ffmpeg.version.is_none() && dto.ffmpeg.missing.is_empty());
    }

    #[test]
    fn platform_names_match_electron() {
        assert_eq!(platform_name("macos"), "darwin");
        assert_eq!(platform_name("windows"), "win32");
        assert_eq!(platform_name("linux"), "linux");
    }
}
