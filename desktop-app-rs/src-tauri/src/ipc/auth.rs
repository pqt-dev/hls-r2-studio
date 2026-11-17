//! `auth:*` commands (port of the auth part of desktop-app/src/main/ipc/authHandlers.ts).
//! Every input is validated like the Electron handlers; a validation failure is logged and the
//! renderer only gets a generic rejection (`IpcError::RequestFailed`).

use serde_json::Value;
use tauri::State;

use super::validate::{expect_no_args, parse_login, IpcValidationError};
use super::IpcError;
use crate::dto::AuthState;
use crate::logger::Log;
use crate::state::AppState;

/// Logs a rejected payload (the message never contains a value) and hides the details.
pub(crate) fn rejected(state: &AppState, channel: &str, error: IpcValidationError) -> IpcError {
    state.logger.error(
        "IPC handler failed",
        Some(serde_json::json!({ "channel": channel, "error": error.0 })),
    );

    IpcError::RequestFailed
}

#[tauri::command]
pub fn auth_get_state(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AuthState, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "auth:get-state", e))?;

    Ok(state.auth.get_state())
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AuthState, IpcError> {
    // The password is moved into a zeroizing `Secret` here and never logged.
    let input = parse_login(payload).map_err(|e| rejected(&state, "auth:login", e))?;

    Ok(state
        .auth
        .login(&input.username, input.password, input.stay_signed_in)
        .await)
}

#[tauri::command]
pub async fn auth_logout(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AuthState, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "auth:logout", e))?;

    Ok(state.auth.logout().await)
}

#[tauri::command]
pub async fn auth_reload_config(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<AuthState, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "auth:reload-config", e))?;

    Ok(state.auth.reload_config().await)
}
