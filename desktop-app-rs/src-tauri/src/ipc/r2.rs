//! `r2:*` commands: the site's R2 storage settings (view, save, test the saved connection).
//!
//! Results are `{ ok: true, ... } | { ok: false, error }` with safe English text. The site only
//! returns the last four characters of the access key and a `has_secret` flag. The key and the
//! secret typed by the user are write-only: validated here, sent once to the site, wiped when
//! dropped; they never reach a log, an error message or a result.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::auth::rejected;
use super::validate::{expect_no_args, parse_r2_save, r2_input_problems};
use super::IpcError;
use crate::api::r2::{R2Input, R2Status};
use crate::api::SiteClient;
use crate::state::AppState;

pub const BUSY_MESSAGE: &str =
    "Wait for the running jobs to finish before changing the R2 settings.";

/// `{ ok: true; status: R2Status } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum R2GetResult {
    Ok { ok: bool, status: R2Status },
    Err { ok: bool, error: String },
}

/// `{ ok: true; status } | { ok: false; error; fieldErrors? }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum R2SaveResult {
    Ok {
        ok: bool,
        status: R2Status,
    },
    Err {
        ok: bool,
        error: String,
        #[serde(rename = "fieldErrors", skip_serializing_if = "BTreeMap::is_empty")]
        field_errors: BTreeMap<String, String>,
    },
}

impl R2SaveResult {
    fn failed(error: impl Into<String>, field_errors: BTreeMap<String, String>) -> Self {
        Self::Err {
            ok: false,
            error: error.into(),
            field_errors,
        }
    }
}

/// `{ ok: true } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum R2TestResult {
    Ok { ok: bool },
    Err { ok: bool, error: String },
}

pub(crate) async fn get_r2(client: &SiteClient) -> R2GetResult {
    match client.get_r2().await {
        Ok(status) => R2GetResult::Ok { ok: true, status },
        Err(error) => R2GetResult::Err {
            ok: false,
            error: error.message,
        },
    }
}

/// Refuses while videos are processing (`running > 0`) and when the form values are invalid
/// (nothing is sent then), otherwise saves through the site.
pub(crate) async fn save_r2(client: &SiteClient, running: u32, input: &R2Input) -> R2SaveResult {
    if running > 0 {
        return R2SaveResult::failed(BUSY_MESSAGE, BTreeMap::new());
    }

    let problems = r2_input_problems(input);

    if !problems.is_empty() {
        return R2SaveResult::failed("Please fix the highlighted fields.", problems);
    }

    match client.set_r2(input).await {
        Ok(status) => R2SaveResult::Ok { ok: true, status },
        Err(failure) => R2SaveResult::failed(failure.error.message, failure.field_errors),
    }
}

pub(crate) async fn test_r2(client: &SiteClient) -> R2TestResult {
    match client.test_r2().await {
        Ok(outcome) if outcome.ok => R2TestResult::Ok { ok: true },
        Ok(outcome) => R2TestResult::Err {
            ok: false,
            error: outcome
                .error
                .unwrap_or_else(|| "The connection test failed.".to_string()),
        },
        Err(error) => R2TestResult::Err {
            ok: false,
            error: error.message,
        },
    }
}

#[tauri::command]
pub async fn r2_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<R2GetResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "r2:get", e))?;

    Ok(get_r2(&state.site_client).await)
}

/// After a successful save the site config is re-fetched (the queue uses the new credentials
/// from then on) and the queue is kicked. The values are never kept in the state.
#[tauri::command]
pub async fn r2_save(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<R2SaveResult, IpcError> {
    let input = parse_r2_save(payload).map_err(|e| rejected(&state, "r2:save", e))?;
    let running = state.queue.summary().running;
    let result = save_r2(&state.site_client, running, &input).await;

    // The key and the secret are wiped here, before anything else is awaited.
    drop(input);

    if matches!(result, R2SaveResult::Ok { .. }) {
        state.auth.reload_config().await;
        state.queue.kick();
    }

    Ok(result)
}

#[tauri::command]
pub async fn r2_test(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<R2TestResult, IpcError> {
    expect_no_args(payload.as_ref()).map_err(|e| rejected(&state, "r2:test", e))?;

    Ok(test_r2(&state.site_client).await)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::api::r2::{parse_r2_status, R2Input};
    use crate::api::test_server::{Reply, TestServer};
    use crate::api::SiteClientOptions;
    use crate::secure::Secret;
    use std::sync::Arc;

    fn status_body() -> Value {
        json!({
            "configured": true, "source": "database",
            "endpoint": "https://acct.r2.cloudflarestorage.com", "bucket": "media",
            "url": "https://cdn.example.com", "access_key_last4": "wxyz", "has_secret": true
        })
    }

    async fn client_for(server: &TestServer) -> SiteClient {
        let base = format!("{}/", server.base_url);

        SiteClient::new_for_loopback_tests(
            SiteClientOptions {
                get_base_url: Arc::new(move || base.clone()),
                get_token: Arc::new(|| Some(Secret::from("tok"))),
                user_agent: "test".into(),
                timeout: std::time::Duration::from_secs(5),
                on_unauthorized: None,
                logger: None,
            },
            false,
        )
    }

    fn input(endpoint: &str, bucket: &str) -> R2Input {
        R2Input {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            url: "https://cdn.example.com".into(),
            access_key_id: Some(Secret::from("AKIAKEY")),
            secret_access_key: Some(Secret::from("s3cr3t-value")),
        }
    }

    #[test]
    fn results_serialize_to_the_documented_shapes_without_secrets() {
        let status = parse_r2_status(&status_body()).unwrap();

        assert_eq!(
            serde_json::to_value(R2SaveResult::Ok { ok: true, status }).unwrap(),
            json!({
                "ok": true,
                "status": {
                    "configured": true, "source": "database",
                    "endpoint": "https://acct.r2.cloudflarestorage.com", "bucket": "media",
                    "url": "https://cdn.example.com", "accessKeyLast4": "wxyz", "hasSecret": true
                }
            })
        );
        assert_eq!(
            serde_json::to_value(R2SaveResult::failed("Nope.", BTreeMap::new())).unwrap(),
            json!({ "ok": false, "error": "Nope." })
        );
        assert_eq!(
            serde_json::to_value(R2SaveResult::failed(
                "Fix.",
                BTreeMap::from([("bucket".to_string(), "Enter the bucket name.".to_string())])
            ))
            .unwrap(),
            json!({ "ok": false, "error": "Fix.", "fieldErrors": { "bucket": "Enter the bucket name." } })
        );
        assert_eq!(
            serde_json::to_value(R2TestResult::Ok { ok: true }).unwrap(),
            json!({ "ok": true })
        );
    }

    #[tokio::test]
    async fn save_is_refused_while_jobs_run_and_sends_nothing() {
        let server = TestServer::start(|_| Reply::json(200, status_body())).await;
        let client = client_for(&server).await;
        let result = save_r2(&client, 1, &input("https://a.example.com", "media")).await;

        assert_eq!(result, R2SaveResult::failed(BUSY_MESSAGE, BTreeMap::new()));
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn save_with_invalid_values_returns_field_errors_and_sends_nothing() {
        let server = TestServer::start(|_| Reply::json(200, status_body())).await;
        let client = client_for(&server).await;
        let result = save_r2(&client, 0, &input("http://a.example.com", "")).await;
        let R2SaveResult::Err { field_errors, .. } = result else {
            panic!("expected a failure");
        };

        assert!(field_errors.contains_key("endpoint") && field_errors.contains_key("bucket"));
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn save_and_test_go_through_the_site() {
        let server = TestServer::start(|request| {
            if request.path.ends_with("/test") {
                Reply::json(200, json!({ "ok": false, "error": "Access Denied" }))
            } else {
                Reply::json(200, status_body())
            }
        })
        .await;
        let client = client_for(&server).await;

        assert!(matches!(
            save_r2(&client, 0, &input("https://a.example.com", "media")).await,
            R2SaveResult::Ok { ok: true, .. }
        ));
        assert_eq!(
            test_r2(&client).await,
            R2TestResult::Err {
                ok: false,
                error: "Access Denied".into()
            }
        );
        assert!(matches!(
            get_r2(&client).await,
            R2GetResult::Ok { ok: true, .. }
        ));
    }
}
