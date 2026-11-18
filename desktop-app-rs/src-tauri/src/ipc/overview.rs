//! `overview:get`: the dashboard numbers (video counts) through the site API.
//! The result is `{ ok: true, overview } | { ok: false, error }` with safe English error text;
//! the site's body, URL and token never reach the renderer.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::auth::rejected;
use super::validate::expect_no_args;
use super::IpcError;
use crate::api::overview::Overview;
use crate::api::{SiteApiError, SiteClient};
use crate::state::AppState;

/// `{ ok: true; overview: Overview } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OverviewGetResult {
    Ok { ok: bool, overview: Overview },
    Err { ok: bool, error: String },
}

impl OverviewGetResult {
    fn failed(error: SiteApiError) -> Self {
        Self::Err {
            ok: false,
            error: error.message,
        }
    }
}

pub(crate) async fn get_overview(client: &SiteClient) -> OverviewGetResult {
    match client.get_overview().await {
        Ok(overview) => OverviewGetResult::Ok { ok: true, overview },
        Err(error) => OverviewGetResult::failed(error),
    }
}

#[tauri::command]
pub async fn overview_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<OverviewGetResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "overview:get", e))?;

    Ok(get_overview(&state.site_client).await)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::api::overview::Overview;

    #[test]
    fn results_serialize_to_the_documented_shapes() {
        let overview = Overview::parse(&json!({
            "videos": { "total": 3, "ready": 2, "processing": 1, "failed": 0 },
            "system": null
        }))
        .unwrap();

        assert_eq!(
            serde_json::to_value(OverviewGetResult::Ok { ok: true, overview }).unwrap(),
            json!({
                "ok": true,
                "overview": {
                    "videos": { "total": 3, "ready": 2, "processing": 1, "failed": 0 }
                }
            })
        );
        assert_eq!(
            serde_json::to_value(OverviewGetResult::failed(SiteApiError::new("Nope."))).unwrap(),
            json!({ "ok": false, "error": "Nope." })
        );
    }
}
