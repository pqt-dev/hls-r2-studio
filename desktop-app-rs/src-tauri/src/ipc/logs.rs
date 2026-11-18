//! `logs:get`: the site's Logs page data through the site API, either the summary (no `type`) or
//! one paginated type. The result is `{ ok: true, view, ... } | { ok: false, error }` with safe
//! English error text; the site's body, URL and token never reach the renderer.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::auth::rejected;
use super::validate::{parse_logs_get, LogsGetInput};
use super::IpcError;
use crate::api::logs::{LogCounts, LogItem, LogsReply};
use crate::api::videos::VideoListMeta;
use crate::api::{SiteApiError, SiteClient};
use crate::state::AppState;

/// `{ ok: true; view: 'summary'; counts; success; error; processing }`
/// `| { ok: true; view: 'page'; counts; data; meta } | { ok: false; error }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LogsGetResult {
    Summary {
        ok: bool,
        view: &'static str,
        counts: LogCounts,
        success: Vec<LogItem>,
        error: Vec<LogItem>,
        processing: Vec<LogItem>,
    },
    Page {
        ok: bool,
        view: &'static str,
        counts: LogCounts,
        data: Vec<LogItem>,
        meta: VideoListMeta,
    },
    Err {
        ok: bool,
        error: String,
    },
}

impl LogsGetResult {
    fn failed(error: SiteApiError) -> Self {
        Self::Err {
            ok: false,
            error: error.message,
        }
    }
}

pub(crate) async fn get_logs(client: &SiteClient, input: LogsGetInput) -> LogsGetResult {
    match client
        .get_logs(input.log_type, input.page, input.per_page)
        .await
    {
        Ok(LogsReply::Summary(summary)) => LogsGetResult::Summary {
            ok: true,
            view: "summary",
            counts: summary.counts,
            success: summary.success,
            error: summary.error,
            processing: summary.processing,
        },
        Ok(LogsReply::Page(page)) => LogsGetResult::Page {
            ok: true,
            view: "page",
            counts: page.counts,
            data: page.data,
            meta: page.meta,
        },
        Err(error) => LogsGetResult::failed(error),
    }
}

#[tauri::command]
pub async fn logs_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<LogsGetResult, IpcError> {
    let input = parse_logs_get(payload).map_err(|e| rejected(&state, "logs:get", e))?;

    Ok(get_logs(&state.site_client, input).await)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn item() -> LogItem {
        serde_json::from_value(json!({
            "id": 1, "public_id": "abc", "title": "T", "status": "failed",
            "error_message": "boom", "failed_at": "2026-11-03T10:00:00+00:00"
        }))
        .unwrap()
    }

    fn counts() -> LogCounts {
        LogCounts {
            total: 3,
            success: 1,
            error: 1,
            processing: 1,
        }
    }

    #[test]
    fn results_serialize_camel_case_with_a_view_tag() {
        let summary = serde_json::to_value(LogsGetResult::Summary {
            ok: true,
            view: "summary",
            counts: counts(),
            success: vec![],
            error: vec![item()],
            processing: vec![],
        })
        .unwrap();

        assert_eq!(summary["view"], "summary");
        assert_eq!(summary["error"][0]["publicId"], "abc");
        assert_eq!(summary["error"][0]["errorMessage"], "boom");
        assert_eq!(summary["error"][0]["failedAt"], "2026-11-03T10:00:00+00:00");
        assert_eq!(summary["error"][0]["originalFilename"], json!(null));
        assert_eq!(summary["counts"]["total"], 3);

        let page = serde_json::to_value(LogsGetResult::Page {
            ok: true,
            view: "page",
            counts: counts(),
            data: vec![item()],
            meta: VideoListMeta {
                page: 1,
                per_page: 24,
                total: 1,
                last_page: 1,
            },
        })
        .unwrap();

        assert_eq!(page["view"], "page");
        assert_eq!(page["meta"]["perPage"], 24);
        assert_eq!(page["meta"]["lastPage"], 1);
        assert_eq!(
            serde_json::to_value(LogsGetResult::failed(SiteApiError::new("Nope."))).unwrap(),
            json!({ "ok": false, "error": "Nope." })
        );
    }
}
