//! Port of desktop-app/src/main/api/siteClient.test.ts against a real loopback HTTP server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::api::app_config::Resolution;
use crate::api::logs::{LogType, LogsReply};
use crate::api::test_server::{closed_port_url, Recorded, Reply, TestServer};
use crate::api::videos::{BulkDeleteOutcome, DeleteStatus, VideoStatus};
use crate::logger::testing::RecordingLogger;

fn config_body() -> Value {
    json!({
        "r2": {
            "access_key_id": "AKIA",
            "secret_access_key": "shh",
            "bucket": "b",
            "endpoint": "https://acct.r2.cloudflarestorage.com",
            "url": "https://cdn.example.com",
        },
        "transcode": { "resolution": "720", "segment_seconds": 6, "fps": null },
    })
}

struct Setup {
    client: SiteClient,
    server: TestServer,
    unauthorized: Arc<AtomicUsize>,
    token: Arc<Mutex<Option<Secret>>>,
    logger: Arc<RecordingLogger>,
}

struct Opts {
    base_url: Option<String>,
    token: Option<&'static str>,
    timeout: Duration,
    insecure_r2: bool,
    production: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            base_url: None,
            token: Some("tok-123"),
            timeout: DEFAULT_TIMEOUT,
            insecure_r2: false,
            production: false,
        }
    }
}

async fn setup_with(
    opts: Opts,
    respond: impl Fn(&Recorded, &Mutex<Option<Secret>>) -> Reply + Send + Sync + 'static,
) -> Setup {
    let token = Arc::new(Mutex::new(opts.token.map(Secret::from)));
    let server = {
        let token = Arc::clone(&token);
        TestServer::start(move |request| respond(request, &token)).await
    };
    let unauthorized = Arc::new(AtomicUsize::new(0));
    let logger = Arc::new(RecordingLogger::default());
    let base_url = opts
        .base_url
        .unwrap_or_else(|| format!("{}/", server.base_url));
    let options = SiteClientOptions {
        get_base_url: Arc::new(move || base_url.clone()),
        get_token: {
            let token = Arc::clone(&token);
            Arc::new(move || token.lock().unwrap().clone())
        },
        user_agent: "test-agent".into(),
        timeout: opts.timeout,
        on_unauthorized: {
            let unauthorized = Arc::clone(&unauthorized);
            Some(Arc::new(move || {
                unauthorized.fetch_add(1, Ordering::SeqCst);
            }))
        },
        logger: Some(logger.clone() as Arc<dyn crate::logger::Log>),
    };
    let client = if opts.production {
        SiteClient::new(options)
    } else {
        SiteClient::new_for_loopback_tests(options, opts.insecure_r2)
    };

    Setup {
        client,
        server,
        unauthorized,
        token,
        logger,
    }
}

async fn setup(respond: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Setup {
    setup_with(Opts::default(), move |request, _| respond(request)).await
}

fn password(text: &str) -> Secret {
    Secret::from(text)
}

// ---- login ----------------------------------------------------------------------------------

#[tokio::test]
async fn login_posts_credentials_without_a_token_and_returns_token_and_username() {
    let t = setup(|_| {
        Reply::json(
            200,
            json!({ "token": "1|abc", "user": { "username": "admin" } }),
        )
    })
    .await;

    let result = t
        .client
        .login("admin", &password("pw"), "My PC")
        .await
        .unwrap();

    assert_eq!(result.token.expose(), "1|abc");
    assert_eq!(result.username, "admin");

    let calls = t.server.requests();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert_eq!(calls[0].path, "/api/app/login");
    assert_eq!(
        calls[0].json(),
        json!({ "username": "admin", "password": "pw", "device_name": "My PC" })
    );
    assert_eq!(calls[0].header("authorization"), None);
    assert_eq!(calls[0].header("accept"), Some("application/json"));
    assert_eq!(calls[0].header("user-agent"), Some("test-agent"));
    assert_eq!(calls[0].header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn login_maps_422_and_429_to_errors_with_status_and_retry_after() {
    let a = setup(|_| Reply::json(422, json!({ "message": "x" }))).await;
    let error = a.client.login("a", &password("b"), "c").await.unwrap_err();
    assert_eq!(error.status, Some(422));

    let b = setup(|_| Reply::json_with(429, json!({}), &[("Retry-After", "42")])).await;
    let error = b.client.login("a", &password("b"), "c").await.unwrap_err();
    assert_eq!(error.status, Some(429));
    assert_eq!(error.retry_after_seconds, Some(42));

    // A failed login is not an "expired session".
    assert_eq!(a.unauthorized.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn login_ignores_a_malformed_retry_after() {
    for value in ["soon", "1234567", "-1", "1.5"] {
        let value = value.to_string();
        let t = setup(move |_| Reply::json_with(429, json!({}), &[("Retry-After", &value)])).await;
        let error = t.client.login("a", &password("b"), "c").await.unwrap_err();

        assert_eq!(error.retry_after_seconds, None);
    }
}

#[tokio::test]
async fn login_rejects_an_invalid_success_body() {
    for body in [
        json!({ "token": "" }),
        json!({ "token": "1|abc" }),
        json!({ "token": "1|abc", "user": {} }),
        json!({ "token": "1|abc", "user": { "username": "" } }),
        json!({ "token": 5, "user": { "username": "a" } }),
        json!([]),
    ] {
        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.login("a", &password("b"), "c").await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_response"));
        assert_eq!(
            error.message,
            "The site sent an unexpected sign-in response."
        );
    }
}

#[tokio::test]
async fn login_failure_message_has_the_status() {
    let t = setup(|_| Reply::json(500, json!({ "error": "boom" }))).await;
    let error = t.client.login("a", &password("b"), "c").await.unwrap_err();

    assert_eq!(error.message, "Sign-in failed (HTTP 500).");
    assert_eq!(error.code.as_deref(), Some("boom"));
    assert!(!error.network);
}

// ---- logout ---------------------------------------------------------------------------------

#[tokio::test]
async fn logout_sends_the_bearer_token_and_accepts_204_and_200() {
    for status in [204, 200] {
        let t = setup(move |_| Reply::empty(status, &[])).await;

        t.client.logout().await.unwrap();

        let calls = t.server.requests();
        assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
        assert_eq!(calls[0].path, "/api/app/logout");
        assert_eq!(calls[0].method, "POST");
    }
}

#[tokio::test]
async fn logout_fails_on_other_statuses() {
    let t = setup(|_| Reply::json(500, json!({}))).await;
    let error = t.client.logout().await.unwrap_err();

    assert_eq!(error.status, Some(500));
    assert_eq!(error.message, "Sign-out failed (HTTP 500).");
}

// ---- getConfig ------------------------------------------------------------------------------

#[tokio::test]
async fn get_config_parses_the_config() {
    let t = setup(|_| Reply::json(200, config_body())).await;
    let config = t.client.get_config().await.unwrap();

    assert_eq!(config.r2.bucket, "b");
    assert_eq!(config.transcode.resolution, Resolution::P720);
    assert_eq!(config.transcode.segment_seconds, 6.0);
    assert_eq!(config.transcode.fps, None);

    let calls = t.server.requests();
    assert_eq!(calls[0].method, "GET");
    assert!(calls[0].body.is_empty());
    assert_eq!(calls[0].header("content-type"), None);
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
}

#[tokio::test]
async fn get_config_reports_409_r2_not_configured_with_its_code() {
    let t = setup(|_| Reply::json(409, json!({ "error": "r2_not_configured" }))).await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.status, Some(409));
    assert_eq!(error.code.as_deref(), Some("r2_not_configured"));
}

#[tokio::test]
async fn get_config_rejects_malformed_config_bodies() {
    let mut bad_resolution = config_body();
    bad_resolution["transcode"] = json!({ "resolution": "999", "segment_seconds": 6, "fps": null });

    for body in [
        json!({}),
        json!({ "r2": {}, "transcode": {} }),
        bad_resolution,
    ] {
        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.get_config().await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_response"));
        assert_eq!(error.message, "The site sent an invalid configuration.");
    }
}

#[tokio::test]
async fn get_config_tolerates_non_json_bodies() {
    let t = setup(|_| Reply::text(502, "<html>oops</html>")).await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.status, Some(502));
    assert_eq!(error.code, None);
    assert_eq!(
        error.message,
        "Could not load the site configuration (HTTP 502)."
    );
}

#[tokio::test]
async fn get_config_calls_on_unauthorized_on_401_once_and_only_for_the_current_token() {
    let a = setup(|_| Reply::json(401, json!({ "message": "Unauthenticated." }))).await;
    let error = a.client.get_config().await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!(a.unauthorized.load(Ordering::SeqCst), 1);

    let b = setup_with(
        Opts {
            token: Some("old"),
            ..Opts::default()
        },
        |_, token| {
            *token.lock().unwrap() = Some(Secret::from("new"));
            Reply::json(401, json!({}))
        },
    )
    .await;
    let error = b.client.get_config().await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!(b.unauthorized.load(Ordering::SeqCst), 0);
    assert_eq!(
        b.token
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.expose().to_string()),
        Some("new".to_string())
    );
}

#[tokio::test]
async fn get_config_rejects_unsafe_r2_locations() {
    let cases: [(&str, Value); 6] = [
        (
            "http endpoint",
            json!({ "endpoint": "http://acct.r2.cloudflarestorage.com" }),
        ),
        (
            "http public url",
            json!({ "url": "http://cdn.example.com" }),
        ),
        (
            "http localhost when not allowed",
            json!({ "endpoint": "http://localhost:9000" }),
        ),
        (
            "endpoint with credentials",
            json!({ "endpoint": "https://u:p@acct.example.com" }),
        ),
        ("non-url endpoint", json!({ "endpoint": "not a url" })),
        ("blank bucket", json!({ "bucket": "   " })),
    ];

    for (name, patch) in cases {
        let mut body = config_body();

        for (key, value) in patch.as_object().unwrap() {
            body["r2"][key] = value.clone();
        }

        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.get_config().await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_r2_location"), "{name}");
        assert!(t
            .logger
            .messages()
            .contains(&"Refusing the site config.".to_string()));
    }
}

#[tokio::test]
async fn get_config_allows_a_localhost_r2_endpoint_only_when_insecure_localhost_is_allowed() {
    let mut body = config_body();
    body["r2"]["endpoint"] = json!("http://127.0.0.1:9000");
    body["r2"]["url"] = json!("http://localhost/x");

    let t = setup_with(
        Opts {
            insecure_r2: true,
            ..Opts::default()
        },
        move |_, _| Reply::json(200, body.clone()),
    )
    .await;

    assert_eq!(
        t.client.get_config().await.unwrap().r2.endpoint,
        "http://127.0.0.1:9000"
    );
}

#[tokio::test]
async fn get_config_fails_with_401_without_a_request_when_there_is_no_token() {
    let t = setup_with(
        Opts {
            token: None,
            ..Opts::default()
        },
        |_, _| Reply::json(200, config_body()),
    )
    .await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.status, Some(401));
    assert_eq!(error.code.as_deref(), Some("not_signed_in"));
    assert_eq!(error.message, "You are not signed in.");
    assert!(t.server.requests().is_empty());
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 0);
}

// ---- response size limit --------------------------------------------------------------------

#[tokio::test]
async fn reads_a_normal_multi_chunk_body() {
    let text = serde_json::to_vec(&config_body()).unwrap();
    let half = text.len() / 2;
    let chunks = vec![text[..half].to_vec(), text[half..].to_vec()];
    let t = setup(move |_| Reply::Chunks {
        status: 200,
        chunks: chunks.clone(),
    })
    .await;

    assert_eq!(t.client.get_config().await.unwrap().r2.bucket, "b");
}

#[tokio::test]
async fn aborts_as_soon_as_the_limit_is_exceeded_without_reading_the_rest() {
    let t = setup(|_| Reply::Endless {
        chunk_size: 600 * 1024,
    })
    .await;
    let error = t.client.get_config().await.unwrap_err();

    assert!(error.network);
    assert_eq!(
        error.message,
        "The response from the site could not be read."
    );

    // The client hung up: the server's writes start failing soon after.
    for _ in 0..200 {
        if t.server.endless_stopped.load(Ordering::SeqCst) {
            break;
        }

        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert!(t.server.endless_stopped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn accepts_a_body_of_exactly_1_mb_but_rejects_one_byte_more() {
    let ok = setup(|_| Reply::Chunks {
        status: 200,
        chunks: vec![vec![b' '; MAX_BODY_BYTES]],
    })
    .await;
    let error = ok.client.get_config().await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_response"));

    let over = setup(|_| Reply::Chunks {
        status: 200,
        chunks: vec![vec![b' '; MAX_BODY_BYTES], vec![b' ']],
    })
    .await;
    let error = over.client.get_config().await.unwrap_err();
    assert!(error.network);

    let declared = setup(|_| Reply::Full {
        status: 200,
        headers: vec![],
        body: vec![b' '; MAX_BODY_BYTES + 1],
    })
    .await;
    assert!(declared.client.get_config().await.unwrap_err().network);
}

// ---- safety rules ---------------------------------------------------------------------------

#[tokio::test]
async fn refuses_to_follow_redirects_and_never_retries_elsewhere() {
    let t = setup(|_| Reply::empty(302, &[("Location", "https://evil.example/")])).await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.code.as_deref(), Some("unexpected_redirect"));
    assert_eq!(error.status, Some(302));
    assert!(error.network);
    assert_eq!(
        error.message,
        "The site sent an unexpected redirect. Check the site URL."
    );
    assert_eq!(t.server.requests().len(), 1);
}

#[tokio::test]
async fn refuses_insecure_and_invalid_base_urls_without_sending_anything() {
    for url in [
        "http://site.example.com",
        "http://localhost:8000",
        "",
        "https://u:p@x.com",
    ] {
        let t = setup_with(
            Opts {
                base_url: Some(url.into()),
                production: true,
                ..Opts::default()
            },
            |_, _| Reply::json(200, config_body()),
        )
        .await;
        let error = t.client.get_config().await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_site_url"), "{url}");
        assert!(t.server.requests().is_empty());
    }
}

#[tokio::test]
async fn the_production_client_never_talks_plain_http_even_to_loopback() {
    let t = setup_with(
        Opts {
            production: true,
            ..Opts::default()
        },
        |_, _| Reply::json(200, config_body()),
    )
    .await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.code.as_deref(), Some("invalid_site_url"));
    assert!(t.server.requests().is_empty());
}

#[tokio::test]
async fn the_loopback_test_client_uses_only_the_origin_of_the_base_url() {
    let t = setup_with(Opts::default(), |_, _| Reply::json(200, config_body())).await;
    let base = format!("{}/ignored/path?x=1", t.server.base_url);
    let options = SiteClientOptions {
        get_base_url: Arc::new(move || base.clone()),
        get_token: Arc::new(|| Some(Secret::from("tok"))),
        user_agent: "ua".into(),
        timeout: DEFAULT_TIMEOUT,
        on_unauthorized: None,
        logger: None,
    };
    let client = SiteClient::new_for_loopback_tests(options, false);

    client.get_config().await.unwrap();

    assert_eq!(t.server.requests()[0].path, "/api/app/config");
}

#[test]
fn request_origin_rules() {
    assert_eq!(
        request_origin("https://A.example.com/x", false).unwrap(),
        "https://a.example.com"
    );
    assert!(request_origin("http://localhost:8000", false).is_err());
    assert!(request_origin("http://127.0.0.1:8000", false).is_err());
    assert_eq!(
        request_origin("http://localhost:8000/x", true).unwrap(),
        "http://localhost:8000"
    );
    assert!(request_origin("http://localhost.evil.com", true).is_err());
    assert!(request_origin("http://u:p@localhost", true).is_err());
    assert!(request_origin("http://example.com", true).is_err());
}

#[tokio::test]
async fn times_out() {
    let t = setup_with(
        Opts {
            timeout: Duration::from_millis(200),
            ..Opts::default()
        },
        |_, _| Reply::Hang,
    )
    .await;
    let error = t.client.get_config().await.unwrap_err();

    assert_eq!(error.code.as_deref(), Some("timeout"));
    assert!(error.network);
    assert_eq!(error.message, "The site did not respond in time.");
}

#[tokio::test]
async fn reports_network_errors_as_network_failures() {
    let url = closed_port_url().await;
    let t = setup_with(
        Opts {
            base_url: Some(url),
            ..Opts::default()
        },
        |_, _| Reply::json(200, config_body()),
    )
    .await;
    let error = t.client.get_config().await.unwrap_err();

    assert!(error.network);
    assert_eq!(error.code.as_deref(), Some("network"));
    assert_eq!(
        error.message,
        "Could not reach the site. Check your internet connection."
    );
    assert!(t
        .logger
        .messages()
        .contains(&"Site request failed.".to_string()));
}

#[tokio::test]
async fn never_puts_the_token_or_password_into_error_messages_or_logs() {
    let t = setup(|request| {
        if request.path == "/api/app/login" {
            Reply::json(422, json!({ "token": "tok-123" }))
        } else {
            Reply::json(500, json!({ "error": "boom", "token": "tok-123" }))
        }
    })
    .await;

    let config_error = t.client.get_config().await.unwrap_err();
    let login_error = t
        .client
        .login("admin", &password("hunter2-password"), "pc")
        .await
        .unwrap_err();

    for text in [
        config_error.message.clone(),
        format!("{config_error:?}"),
        login_error.message.clone(),
        format!("{login_error:?}"),
        t.logger.text(),
    ] {
        assert!(!text.contains("tok-123"), "{text}");
        assert!(!text.contains("hunter2-password"), "{text}");
    }
}

#[tokio::test]
async fn login_result_debug_is_redacted() {
    let t = setup(|_| {
        Reply::json(
            200,
            json!({ "token": "1|abcdefghijklmnopqrstuvwxyz", "user": { "username": "admin" } }),
        )
    })
    .await;
    let result = t.client.login("a", &password("b"), "c").await.unwrap();

    assert!(!format!("{result:?}").contains("abcdefghij"));
}

#[test]
fn user_agent_names_the_app_version_and_platform() {
    let agent = user_agent("1.2.3");

    assert!(agent.starts_with("HLS-R2-Studio/1.2.3 ("));
    assert!(agent.ends_with(')'));
}

// ---- register -------------------------------------------------------------------------------

mod register_tests {
    use super::*;
    use crate::pipeline::register::{
        build_register_payload, BuildRegisterPayloadInput, RegisterFailure, RegisterPayload,
        RegisterRequestError, RegisteredVideo,
    };

    fn payload() -> RegisterPayload {
        build_register_payload(&BuildRegisterPayloadInput {
            public_id: "abcdefghij12".into(),
            prefix: "2026/03/05/clip-abcdefghij12/".into(),
            original_filename: "clip.mp4".into(),
            original_size_bytes: 10,
            duration: Some(1.5),
            has_thumbnail: false,
            storyboard_grids: vec![],
            output: None,
        })
    }

    fn registered_body() -> Value {
        json!({ "id": 5, "public_id": "abcdefghij12", "embed_url": "https://site.example.com/embed/x" })
    }

    fn expected() -> RegisteredVideo {
        RegisteredVideo {
            id: 5,
            public_id: "abcdefghij12".into(),
            embed_url: "https://site.example.com/embed/x".into(),
        }
    }

    async fn failure_of(t: &Setup) -> RegisterFailure {
        let error: RegisterRequestError = t.client.register(&payload()).await.unwrap_err();

        error.failure
    }

    #[tokio::test]
    async fn returns_the_registered_video_on_201_and_200() {
        for status in [200, 201] {
            let t = setup(move |_| Reply::json(status, registered_body())).await;

            assert_eq!(t.client.register(&payload()).await.unwrap(), expected());

            let calls = t.server.requests();

            assert_eq!(calls[0].method, "POST");
            assert_eq!(calls[0].path, "/api/app/videos");
            assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
            assert_eq!(calls[0].header("content-type"), Some("application/json"));
            assert_eq!(calls[0].json()["public_id"], "abcdefghij12");
            assert_eq!(calls[0].json()["thumbnail_path"], Value::Null);
            // The token never reaches the log.
            assert!(!t.logger.text().contains("tok-123"));
            assert!(!t.logger.text().contains("abcdefghij12"));
        }
    }

    #[tokio::test]
    async fn fails_with_a_register_request_error_for_http_errors() {
        for (status, code, retry_after) in [
            (401, None, None),
            (409, Some("public_id_conflict"), None),
            (422, Some("playlist_not_found"), None),
            (429, None, Some(7)),
            (503, Some("storage_unavailable"), None),
        ] {
            let t = setup(move |_| {
                let headers: Vec<(&str, String)> = retry_after
                    .map(|s: u64| vec![("Retry-After", s.to_string())])
                    .unwrap_or_default();
                let headers: Vec<(&str, &str)> =
                    headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
                let body = code.map_or_else(|| json!({}), |c| json!({ "error": c }));

                Reply::json_with(status, body, &headers)
            })
            .await;

            assert_eq!(
                failure_of(&t).await,
                RegisterFailure::Http {
                    status,
                    error_code: code.map(str::to_string),
                    retry_after_seconds: retry_after.map(|s| s as f64),
                },
                "{status}"
            );
            assert_eq!(
                t.unauthorized.load(Ordering::SeqCst),
                usize::from(status == 401),
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn maps_transport_failures_and_bad_2xx_bodies_to_a_network_failure() {
        let url = closed_port_url().await;
        let t = setup_with(
            Opts {
                base_url: Some(url),
                ..Opts::default()
            },
            |_, _| Reply::json(200, json!({})),
        )
        .await;

        assert_eq!(failure_of(&t).await, RegisterFailure::Network);

        for body in [
            json!({ "nope": true }),
            json!({ "id": 1.5, "public_id": "a", "embed_url": "b" }),
            json!({ "id": 1, "public_id": "", "embed_url": "b" }),
            json!({ "id": "1", "public_id": "a", "embed_url": "b" }),
            json!([]),
        ] {
            let t = setup(move |_| Reply::json(201, body.clone())).await;
            let error = t.client.register(&payload()).await.unwrap_err();

            assert_eq!(error.failure, RegisterFailure::Network);
            assert_eq!(error.message, "invalid register response");
        }

        let t = setup(|_| Reply::empty(302, &[("Location", "https://evil.example.com/")])).await;

        assert_eq!(failure_of(&t).await, RegisterFailure::Network);
    }

    #[tokio::test]
    async fn maps_a_missing_token_to_an_http_401_failure() {
        let t = setup_with(
            Opts {
                token: None,
                ..Opts::default()
            },
            |_, _| Reply::json(200, json!({})),
        )
        .await;

        assert_eq!(
            failure_of(&t).await,
            RegisterFailure::Http {
                status: 401,
                error_code: Some("not_signed_in".into()),
                retry_after_seconds: None,
            }
        );
        assert!(t.server.requests().is_empty());
    }

    #[tokio::test]
    async fn works_through_the_register_client_trait() {
        use crate::pipeline::register::RegisterClient;

        let t = setup(|_| Reply::json(201, registered_body())).await;
        let client: &dyn RegisterClient = &t.client;

        assert_eq!(client.register(&payload()).await.unwrap(), expected());
    }
}

// ---- videos (list + detail) -----------------------------------------------------------------

fn list_item(id: i64, status: &str) -> Value {
    json!({
        "id": id,
        "public_id": format!("abcdefghij{id:02}"),
        "title": "My clip",
        "original_filename": "my clip.mp4",
        "original_size_bytes": 1234,
        "status": status,
        "duration": 12.5,
        "output_width": 1280,
        "output_height": 720,
        "output_codec": "h264",
        "disk_prefix": "2026/11/03/clip-abcdefghij12/",
        "playlist_path": "2026/11/03/clip-abcdefghij12/playlist.m3u8",
        "thumbnail_path": null,
        "custom_image_path": null,
        "storyboards": [],
        "embed_url": "https://site.example/embed/abcdefghij12",
        "created_at": "2026-11-03T10:00:00+00:00",
        "future_field": { "ignored": true },
    })
}

fn detail_body(status: &str) -> Value {
    json!({
        "id": 12,
        "public_id": "abcdefghij12",
        "title": "My clip",
        "original_filename": "my clip.mp4",
        "original_size_bytes": 1234,
        "status": status,
        "stage": status,
        "progress": 100,
        "error": null,
        "duration": 12.5,
        "output_width": 1280,
        "output_height": 720,
        "output_fps": 30.0,
        "output_bitrate_kbps": 2500,
        "output_codec": "h264",
        "embed_url": "https://site.example/embed/abcdefghij12",
        "playlist_url": "https://cdn.example.com/p.m3u8",
        "thumbnail_url": null,
        "has_custom_image": false,
        "custom_image_url": null,
        "storyboards": [],
        "embed_storyboard": null,
        "created_at": "2026-11-03T10:00:00+00:00",
        "updated_at": "2026-11-03T10:05:00+00:00",
    })
}

#[tokio::test]
async fn list_videos_sends_encoded_query_and_parses_the_page() {
    let t = setup(|_| {
        Reply::json(
            200,
            json!({
                "data": [list_item(1, "ready"), list_item(2, "brand_new_status")],
                "meta": { "page": 2, "per_page": 10, "total": 12, "last_page": 2 },
            }),
        )
    })
    .await;
    let page = t
        .client
        .list_videos(2, 10, Some("  a b&c#é=1  "))
        .await
        .unwrap();

    assert_eq!(page.meta.total, 12);
    assert_eq!(page.data.len(), 2);
    assert_eq!(page.data[0].status, VideoStatus::Ready);
    assert_eq!(
        page.data[1].status,
        VideoStatus::Unknown("brand_new_status".into())
    );
    assert_eq!(page.data[0].thumbnail_path, None);
    assert!(page.data[0].storyboards.is_empty());

    let calls = t.server.requests();
    assert_eq!(calls[0].method, "GET");
    assert_eq!(
        calls[0].path,
        "/api/app/videos?page=2&per_page=10&q=a+b%26c%23%C3%A9%3D1"
    );
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));

    // The search text is not logged.
    let logs = t.logger.text();
    assert!(logs.contains("/api/app/videos") && !logs.contains("%C3%A9") && !logs.contains("q="));

    let no_query = setup(|_| {
        Reply::json(
            200,
            json!({ "data": [], "meta": { "page": 1, "per_page": 24, "total": 0, "last_page": 1 } }),
        )
    })
    .await;
    no_query
        .client
        .list_videos(1, 24, Some("  "))
        .await
        .unwrap();
    assert_eq!(
        no_query.server.requests()[0].path,
        "/api/app/videos?page=1&per_page=24"
    );
}

#[tokio::test]
async fn list_videos_rejects_oversized_and_malformed_answers() {
    let items: Vec<Value> = (1..=51).map(|id| list_item(id, "ready")).collect();
    let too_many = setup(move |_| {
        Reply::json(
            200,
            json!({ "data": items, "meta": { "page": 1, "per_page": 50, "total": 51, "last_page": 2 } }),
        )
    })
    .await;
    let error = too_many.client.list_videos(1, 50, None).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_response"));

    let malformed = setup(|_| Reply::json(200, json!({ "data": "x" }))).await;
    let error = malformed.client.list_videos(1, 24, None).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_response"));
}

#[tokio::test]
async fn get_video_parses_ready_and_failed_details() {
    let t = setup(|_| Reply::json(200, detail_body("ready"))).await;
    let video = t.client.get_video(12).await.unwrap();

    assert_eq!(t.server.requests()[0].path, "/api/app/videos/12");
    assert_eq!(video.status, VideoStatus::Ready);
    assert_eq!(video.thumbnail_url, None);
    assert_eq!(video.error, None);
    assert_eq!(video.output_fps, Some(30.0));
    assert_eq!(
        video.playlist_url.as_deref(),
        Some("https://cdn.example.com/p.m3u8")
    );
    assert!(video.storyboards.is_empty());

    let mut failed = detail_body("failed");
    failed["error"] =
        json!({ "message": "boom", "detail": "d", "failed_at": "2026-11-03T10:01:00+00:00" });
    failed["playlist_url"] = json!("http://insecure.example/p.m3u8");
    failed["storyboards"] =
        json!({ "3x3": { "url": "https://cdn.example.com/s.jpg", "columns": 3, "count": 9 } });
    let t = setup(move |_| Reply::json(200, failed.clone())).await;
    let video = t.client.get_video(12).await.unwrap();

    assert_eq!(video.status, VideoStatus::Failed);
    assert_eq!(video.error.unwrap().message.as_deref(), Some("boom"));
    // Only https URLs are kept.
    assert_eq!(video.playlist_url, None);
    assert_eq!(video.storyboards["3x3"].count, Some(9));
}

#[tokio::test]
async fn video_reads_map_failures_to_safe_errors() {
    let not_found = setup(|_| Reply::json(404, json!({ "error": "not_found" }))).await;
    let error = not_found.client.get_video(99).await.unwrap_err();
    assert_eq!(error.status, Some(404));
    assert_eq!(error.code.as_deref(), Some("not_found"));
    assert_eq!(error.message, "Video not found.");

    let busy = setup(|_| {
        Reply::json_with(
            429,
            json!({ "message": "secret server text" }),
            &[("Retry-After", "7")],
        )
    })
    .await;
    let error = busy.client.list_videos(1, 24, None).await.unwrap_err();
    assert_eq!(error.retry_after_seconds, Some(7));
    assert!(!error.message.contains("secret"));

    let broken = setup(|_| Reply::text(500, "<html>stack trace /var/www</html>")).await;
    let error = broken.client.list_videos(1, 24, None).await.unwrap_err();
    assert_eq!(error.message, "Could not load the videos (HTTP 500).");
}

#[tokio::test]
async fn video_reads_report_401_through_on_unauthorized_and_need_a_token() {
    let t = setup(|_| Reply::json(401, json!({ "message": "Unauthenticated." }))).await;
    let error = t.client.get_video(1).await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 1);
    t.client.list_videos(1, 24, None).await.unwrap_err();
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 2);

    let signed_out = setup_with(
        Opts {
            token: None,
            ..Opts::default()
        },
        |_, _| Reply::json(200, json!({})),
    )
    .await;
    let error = signed_out.client.get_video(1).await.unwrap_err();
    assert!(error.has_code("not_signed_in"));
    assert!(signed_out.server.requests().is_empty());
}

// ---- videos (rename + delete + bulk delete) ------------------------------------------------

#[tokio::test]
async fn update_video_title_puts_the_trimmed_title_and_returns_the_detail() {
    let t = setup(|request| {
        let mut body = detail_body("ready");
        body["title"] = request.json()["title"].clone();
        Reply::json(200, body)
    })
    .await;
    let video = t
        .client
        .update_video_title(12, "  New name  ")
        .await
        .unwrap();

    assert_eq!(video.title, "New name");
    assert_eq!(video.status, VideoStatus::Ready);

    let calls = t.server.requests();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "PUT");
    assert_eq!(calls[0].path, "/api/app/videos/12");
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
    assert_eq!(calls[0].header("content-type"), Some("application/json"));
    assert_eq!(calls[0].json(), json!({ "title": "New name" }));

    // The title is never logged.
    assert!(!t.logger.text().contains("New name"));
}

#[tokio::test]
async fn update_video_title_counts_characters_and_rejects_bad_titles_without_a_request() {
    let t = setup(|_| Reply::json(200, detail_body("ready"))).await;

    // 255 two-byte characters are accepted (510 bytes).
    t.client
        .update_video_title(12, &"\u{0111}".repeat(255))
        .await
        .unwrap();
    assert_eq!(t.server.requests().len(), 1);

    for (title, message) in [
        ("", "Title is required."),
        ("   \t ", "Title is required."),
        (
            &"a".repeat(256)[..],
            "Title is too long (255 characters at most).",
        ),
        ("a\u{7}b", "Title is invalid."),
        ("a\nb", "Title is invalid."),
    ] {
        let error = t.client.update_video_title(12, title).await.unwrap_err();
        assert_eq!(error.message, message, "{title:?}");
    }

    assert_eq!(t.server.requests().len(), 1);
}

#[tokio::test]
async fn update_video_title_maps_422_404_and_429_to_safe_errors() {
    let invalid = setup(|_| {
        Reply::json(
            422,
            json!({ "message": "secret server text", "errors": { "title": ["secret"] } }),
        )
    })
    .await;
    let error = invalid
        .client
        .update_video_title(12, "x")
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(422));
    assert_eq!(error.message, "Title is invalid.");

    let gone = setup(|_| Reply::json(404, json!({ "error": "not_found" }))).await;
    let error = gone.client.update_video_title(12, "x").await.unwrap_err();
    assert_eq!(error.status, Some(404));
    assert_eq!(error.message, "Video not found.");

    let busy = setup(|_| {
        Reply::json_with(
            429,
            json!({ "message": "secret server text" }),
            &[("Retry-After", "9")],
        )
    })
    .await;
    let error = busy.client.update_video_title(12, "x").await.unwrap_err();
    assert_eq!(error.retry_after_seconds, Some(9));
    assert_eq!(
        error.message,
        "Too many requests. Please try again in a moment."
    );

    let broken = setup(|_| Reply::json(200, json!({ "unexpected": true }))).await;
    let error = broken.client.update_video_title(12, "x").await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_response"));
}

#[tokio::test]
async fn delete_video_parses_deleted_skipped_and_failed() {
    for (status, expected) in [
        ("deleted", DeleteStatus::Deleted),
        ("skipped", DeleteStatus::Skipped),
        ("failed", DeleteStatus::Failed),
    ] {
        let t = setup(move |_| {
            Reply::json(
                200,
                json!({ "status": status, "message": format!("  Message for {status}.\u{7} ") }),
            )
        })
        .await;
        let outcome = t.client.delete_video(12).await.unwrap();

        assert_eq!(outcome.status, expected);
        assert_eq!(outcome.message, format!("Message for {status}."));

        let calls = t.server.requests();
        assert_eq!(calls[0].method, "DELETE");
        assert_eq!(calls[0].path, "/api/app/videos/12");
        assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
        assert!(calls[0].body.is_empty());
    }
}

#[tokio::test]
async fn delete_video_caps_the_message_and_rejects_unknown_statuses() {
    let long = setup(|_| {
        Reply::json(
            200,
            json!({ "status": "deleted", "message": "m".repeat(5000) }),
        )
    })
    .await;
    assert_eq!(
        long.client.delete_video(1).await.unwrap().message.len(),
        300
    );

    let no_message = setup(|_| Reply::json(200, json!({ "status": "skipped" }))).await;
    assert!(!no_message
        .client
        .delete_video(1)
        .await
        .unwrap()
        .message
        .is_empty());

    for body in [
        json!({ "status": "exploded", "message": "x" }),
        json!({ "message": "x" }),
        json!({ "status": 5 }),
    ] {
        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.delete_video(1).await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_response"));
    }
}

#[tokio::test]
async fn delete_video_maps_404_and_other_failures_to_safe_errors() {
    let gone = setup(|_| Reply::json(404, json!({ "error": "not_found" }))).await;
    let error = gone.client.delete_video(1).await.unwrap_err();
    assert_eq!(error.status, Some(404));
    assert_eq!(error.message, "Video not found.");

    let broken = setup(|_| Reply::text(500, "<html>/var/www stack trace</html>")).await;
    let error = broken.client.delete_video(1).await.unwrap_err();
    assert_eq!(error.message, "Could not delete the video (HTTP 500).");
}

#[tokio::test]
async fn bulk_delete_sends_deduped_ids_and_parses_the_counts() {
    let t = setup(|_| {
        Reply::json(
            200,
            json!({ "deleted": 2, "failed": 1, "skipped": 1, "message": "Deleted 2 videos (1 skipped: still processing)." }),
        )
    })
    .await;
    let outcome = t.client.bulk_delete_videos(&[3, 1, 3, 2, 1]).await.unwrap();

    assert_eq!(
        outcome,
        BulkDeleteOutcome {
            deleted: 2,
            failed: 1,
            skipped: 1,
            message: "Deleted 2 videos (1 skipped: still processing).".into(),
        }
    );

    let calls = t.server.requests();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "DELETE");
    assert_eq!(calls[0].path, "/api/app/videos/bulk-destroy");
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
    assert_eq!(calls[0].header("content-type"), Some("application/json"));
    assert_eq!(calls[0].json(), json!({ "selected_ids": [3, 1, 2] }));
}

#[tokio::test]
async fn bulk_delete_accepts_exactly_100_and_rejects_other_sizes_before_any_request() {
    let t = setup(|_| {
        Reply::json(
            200,
            json!({ "deleted": 100, "failed": 0, "skipped": 0, "message": "ok" }),
        )
    })
    .await;
    let hundred: Vec<i64> = (1..=100).collect();

    t.client.bulk_delete_videos(&hundred).await.unwrap();
    assert_eq!(t.server.requests().len(), 1);

    // 100 distinct ids plus duplicates are still 100.
    let mut with_duplicates = hundred.clone();
    with_duplicates.extend([1, 2, 3]);
    t.client.bulk_delete_videos(&with_duplicates).await.unwrap();
    assert_eq!(t.server.requests().len(), 2);

    let too_many: Vec<i64> = (1..=101).collect();

    for ids in [too_many, vec![], vec![0], vec![5, -1]] {
        let error = t.client.bulk_delete_videos(&ids).await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_selection"), "{ids:?}");
    }

    assert_eq!(t.server.requests().len(), 2);
}

#[tokio::test]
async fn bulk_delete_maps_422_and_rejects_invalid_answers() {
    let unknown = setup(|_| {
        Reply::json(
            422,
            json!({ "message": "secret", "errors": { "selected_ids.0": ["secret"] } }),
        )
    })
    .await;
    let error = unknown.client.bulk_delete_videos(&[1]).await.unwrap_err();
    assert_eq!(error.status, Some(422));
    assert!(error.message.contains("no longer exist"));
    assert!(!error.message.contains("secret"));

    for body in [
        json!({ "deleted": 1 }),
        json!({ "deleted": -1, "failed": 0, "skipped": 0 }),
        json!({ "deleted": "1", "failed": 0, "skipped": 0 }),
        json!({ "deleted": 4294967296u64, "failed": 0, "skipped": 0 }),
    ] {
        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.bulk_delete_videos(&[1]).await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_response"));
    }

    // A missing message falls back to the counts.
    let t = setup(|_| Reply::json(200, json!({ "deleted": 1, "failed": 0, "skipped": 0 }))).await;
    let outcome = t.client.bulk_delete_videos(&[1]).await.unwrap();
    assert_eq!(outcome.message, "Deleted 1, failed 0, skipped 0.");
}

#[tokio::test]
async fn video_writes_report_401_and_never_leak_secrets_urls_or_bodies() {
    let t = setup(|_| Reply::json(401, json!({ "message": "Unauthenticated." }))).await;

    t.client.update_video_title(1, "x").await.unwrap_err();
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 1);
    t.client.delete_video(1).await.unwrap_err();
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 2);
    t.client.bulk_delete_videos(&[1]).await.unwrap_err();
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 3);

    let signed_out = setup_with(
        Opts {
            token: None,
            ..Opts::default()
        },
        |_, _| Reply::json(200, json!({})),
    )
    .await;

    assert!(signed_out
        .client
        .update_video_title(1, "x")
        .await
        .unwrap_err()
        .has_code("not_signed_in"));
    assert!(signed_out
        .client
        .delete_video(1)
        .await
        .unwrap_err()
        .has_code("not_signed_in"));
    assert!(signed_out
        .client
        .bulk_delete_videos(&[1])
        .await
        .unwrap_err()
        .has_code("not_signed_in"));
    assert!(signed_out.server.requests().is_empty());

    let leaky = setup(|_| {
        Reply::json(
            500,
            json!({ "message": "SQLSTATE tok-123 http://internal.example/secret" }),
        )
    })
    .await;
    let errors = [
        leaky
            .client
            .update_video_title(1, "Secret title")
            .await
            .unwrap_err(),
        leaky.client.delete_video(1).await.unwrap_err(),
        leaky.client.bulk_delete_videos(&[1]).await.unwrap_err(),
    ];

    for error in errors {
        for needle in [
            "SQLSTATE",
            "tok-123",
            "internal.example",
            "127.0.0.1",
            "Secret title",
        ] {
            assert!(
                !error.message.contains(needle),
                "{needle}: {}",
                error.message
            );
        }
    }

    let logs = leaky.logger.text();
    assert!(
        !logs.contains("tok-123")
            && !logs.contains("Secret title")
            && !logs.contains("selected_ids")
    );
}

// ---- custom thumbnail ---------------------------------------------------------------------

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    bytes.extend_from_slice(b"\r\n--not-the-boundary\r\n");
    bytes
}

#[tokio::test]
async fn set_video_image_posts_a_well_formed_multipart_and_returns_the_https_url() {
    use crate::api::image_upload::ImageKind;

    let t = setup(|_| {
        Reply::json(
            200,
            json!({ "label": "Custom image", "url": "https://cdn.example.com/v/custom.png?v=1" }),
        )
    })
    .await;
    let data = png_bytes();
    let url = t
        .client
        .set_video_image(12, &data, ImageKind::Png)
        .await
        .unwrap();

    assert_eq!(
        url.as_deref(),
        Some("https://cdn.example.com/v/custom.png?v=1")
    );

    let calls = t.server.requests();
    let call = &calls[0];

    assert_eq!(
        (call.method.as_str(), call.path.as_str()),
        ("POST", "/api/app/videos/12/image")
    );
    assert_eq!(call.header("authorization"), Some("Bearer tok-123"));

    let content_type = call.header("content-type").unwrap();
    let boundary = content_type
        .strip_prefix("multipart/form-data; boundary=")
        .expect(content_type);
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"thumbnail.png\"\r\nContent-Type: image/png\r\n\r\n"
    );
    let tail = format!("\r\n--{boundary}--\r\n");

    assert!(call.body.starts_with(head.as_bytes()));
    assert!(call.body.ends_with(tail.as_bytes()));
    assert_eq!(
        &call.body[head.len()..call.body.len() - tail.len()],
        &data[..]
    );
    assert_eq!(
        call.header("content-length"),
        Some(call.body.len().to_string().as_str())
    );
}

#[tokio::test]
async fn set_video_image_names_each_type_and_drops_a_non_https_url() {
    use crate::api::image_upload::ImageKind;

    let t = setup(|_| Reply::json(200, json!({ "url": "http://cdn.example.com/x.jpg" }))).await;

    for (kind, name, mime) in [
        (ImageKind::Jpeg, "thumbnail.jpg", "image/jpeg"),
        (ImageKind::Png, "thumbnail.png", "image/png"),
        (ImageKind::Webp, "thumbnail.webp", "image/webp"),
    ] {
        assert_eq!(t.client.set_video_image(1, b"x", kind).await.unwrap(), None);

        let body = String::from_utf8(t.server.requests().last().unwrap().body.clone()).unwrap();

        assert!(body.contains(&format!("filename=\"{name}\"")), "{body}");
        assert!(
            body.contains(&format!("Content-Type: {mime}\r\n")),
            "{body}"
        );
    }
}

#[tokio::test]
async fn set_video_image_maps_failures_to_safe_errors() {
    use crate::api::image_upload::ImageKind;

    let rejected = "The image was rejected by the server. Use a JPG, PNG or WebP image up to 5 MB.";
    let cases: Vec<(u16, Value, &str)> = vec![
        (404, json!({ "error": "not_found" }), "Video not found."),
        (
            422,
            json!({ "message": "secret", "errors": { "image": ["secret"] } }),
            rejected,
        ),
        (413, json!({}), rejected),
        (
            422,
            json!({ "error": "no_storage_folder", "message": "secret" }),
            "This video has no storage folder yet.",
        ),
        (
            500,
            json!({ "error": "image_store_failed", "message": "SQLSTATE /var/www tok-123" }),
            "Could not save the image.",
        ),
        (502, json!({}), "Could not save the image (HTTP 502)."),
        (
            401,
            json!({}),
            "Your session has expired. Please sign in again.",
        ),
    ];

    for (status, body, message) in cases {
        let t = setup(move |_| Reply::json(status, body.clone())).await;
        let error = t
            .client
            .set_video_image(3, b"x", ImageKind::Jpeg)
            .await
            .unwrap_err();

        assert_eq!(error.status, Some(status));
        assert_eq!(error.message, message);

        let logs = t.logger.text();

        assert!(
            !logs.contains("tok-123") && !logs.contains("SQLSTATE"),
            "{logs}"
        );
    }

    let busy = setup(|_| Reply::json_with(429, json!({}), &[("Retry-After", "12")])).await;
    let error = busy
        .client
        .set_video_image(3, b"x", ImageKind::Jpeg)
        .await
        .unwrap_err();

    assert_eq!(error.retry_after_seconds, Some(12));
    assert_eq!(
        error.message,
        "Too many requests. Please try again in a moment."
    );

    let unauthorized = setup(|_| Reply::json(401, json!({}))).await;

    unauthorized
        .client
        .set_video_image(3, b"x", ImageKind::Jpeg)
        .await
        .unwrap_err();
    assert_eq!(unauthorized.unauthorized.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn delete_video_image_succeeds_and_maps_failures() {
    let ok = setup(|_| Reply::json(200, json!({ "ok": true }))).await;

    ok.client.delete_video_image(9).await.unwrap();

    let call = &ok.server.requests()[0];

    assert_eq!(
        (call.method.as_str(), call.path.as_str()),
        ("DELETE", "/api/app/videos/9/image")
    );

    let none =
        setup(|_| Reply::json(404, json!({ "error": "no_custom_image", "message": "x" }))).await;
    let error = none.client.delete_video_image(9).await.unwrap_err();

    assert!(error.has_code("no_custom_image"));
    assert_eq!(error.message, "No custom thumbnail to remove.");

    let gone = setup(|_| Reply::json(404, json!({ "error": "not_found" }))).await;
    let error = gone.client.delete_video_image(9).await.unwrap_err();

    assert!(!error.has_code("no_custom_image"));
    assert_eq!(error.message, "Video not found.");

    let broken = setup(|_| {
        Reply::json(
            500,
            json!({ "error": "image_delete_failed", "message": "SQLSTATE" }),
        )
    })
    .await;

    assert_eq!(
        broken
            .client
            .delete_video_image(9)
            .await
            .unwrap_err()
            .message,
        "Could not remove the image."
    );

    let busy = setup(|_| Reply::json_with(429, json!({}), &[("Retry-After", "3")])).await;
    let error = busy.client.delete_video_image(9).await.unwrap_err();

    assert_eq!(error.retry_after_seconds, Some(3));

    let expired = setup(|_| Reply::json(401, json!({}))).await;

    expired.client.delete_video_image(9).await.unwrap_err();
    assert_eq!(expired.unauthorized.load(Ordering::SeqCst), 1);
}

// ---- overview + logs ------------------------------------------------------------------------

fn overview_body() -> Value {
    json!({
        "videos": { "total": 5, "ready": 2, "processing": 2, "failed": 1 },
        // The site may still send this: it must simply be ignored.
        "system": { "cpu_percent": 12, "future_field": 1 },
    })
}

#[tokio::test]
async fn get_overview_parses_the_documented_answer() {
    let t = setup(|_| Reply::json(200, overview_body())).await;
    let overview = t.client.get_overview().await.unwrap();

    assert_eq!(overview.videos.total, 5);
    assert_eq!(overview.videos.processing, 2);

    assert_eq!(overview.videos.ready, 2);
    assert_eq!(overview.videos.failed, 1);

    let calls = t.server.requests();

    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "GET");
    assert_eq!(calls[0].path, "/api/app/overview");
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
}

#[tokio::test]
async fn get_overview_maps_failures_to_safe_errors() {
    let t = setup(|_| Reply::json(401, json!({ "message": "Unauthenticated." }))).await;
    let error = t.client.get_overview().await.unwrap_err();

    assert_eq!(error.status, Some(401));
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 1);

    let busy = setup(|_| {
        Reply::json_with(
            429,
            json!({ "message": "secret server text" }),
            &[("Retry-After", "9")],
        )
    })
    .await;
    let error = busy.client.get_overview().await.unwrap_err();

    assert_eq!(error.status, Some(429));
    assert_eq!(error.retry_after_seconds, Some(9));
    assert!(!error.message.contains("secret"));

    let broken = setup(|_| Reply::text(500, "<html>stack trace /var/www tok-123</html>")).await;
    let error = broken.client.get_overview().await.unwrap_err();

    assert_eq!(error.message, "Could not load the overview (HTTP 500).");
    assert!(!broken.logger.text().contains("stack trace"));
    assert!(!broken.logger.text().contains("tok-123"));

    for body in [
        json!({ "videos": { "total": -1, "ready": 0, "processing": 0, "failed": 0 } }),
        json!({ "videos": null }),
        json!([]),
    ] {
        let t = setup(move |_| Reply::json(200, body.clone())).await;
        let error = t.client.get_overview().await.unwrap_err();

        assert_eq!(error.code.as_deref(), Some("invalid_response"));
        assert_eq!(error.message, "The site sent an unexpected overview.");
    }

    let signed_out = setup_with(
        Opts {
            token: None,
            ..Opts::default()
        },
        |_, _| Reply::json(200, overview_body()),
    )
    .await;
    let error = signed_out.client.get_overview().await.unwrap_err();

    assert!(error.has_code("not_signed_in"));
    assert!(signed_out.server.requests().is_empty());
}

fn log_item(id: i64, status: &str) -> Value {
    json!({
        "id": id,
        "public_id": format!("abcdefghij{id:02}"),
        "title": "My clip",
        "original_filename": "my clip.mp4",
        "status": status,
        "stage": status,
        "progress": 40,
        "error_message": null,
        "error_detail": null,
        "failed_at": null,
        "created_at": "2026-11-03T10:00:00+00:00",
        "updated_at": "2026-11-03T10:05:00+00:00",
        "future_field": { "ignored": true },
    })
}

fn log_counts() -> Value {
    json!({ "total": 6, "success": 3, "error": 2, "processing": 1 })
}

fn summary_body() -> Value {
    json!({
        "counts": log_counts(),
        "success": [log_item(1, "ready")],
        "error": [log_item(2, "failed"), log_item(3, "failed")],
        "processing": [log_item(4, "processing")],
    })
}

fn page_body(items: Vec<Value>) -> Value {
    json!({
        "counts": log_counts(),
        "data": items,
        "meta": { "page": 2, "per_page": 10, "total": 12, "last_page": 2 },
    })
}

#[tokio::test]
async fn get_logs_without_type_returns_the_summary_and_sends_no_paging() {
    let t = setup(|_| Reply::json(200, summary_body())).await;
    let reply = t.client.get_logs(None, Some(3), Some(9)).await.unwrap();
    let LogsReply::Summary(summary) = reply else {
        panic!("expected the summary shape");
    };

    assert_eq!(summary.counts.total, 6);
    assert_eq!(summary.counts.error, 2);
    assert_eq!(summary.success.len(), 1);
    assert_eq!(summary.error.len(), 2);
    assert_eq!(summary.processing[0].progress, Some(40));
    assert_eq!(summary.success[0].status, VideoStatus::Ready);

    let calls = t.server.requests();

    assert_eq!(calls[0].method, "GET");
    assert_eq!(calls[0].path, "/api/app/logs");
    assert_eq!(calls[0].header("authorization"), Some("Bearer tok-123"));
}

#[tokio::test]
async fn get_logs_with_a_type_returns_the_paginated_shape_for_each_type() {
    for log_type in [LogType::Success, LogType::Error, LogType::Processing] {
        let t = setup(|_| Reply::json(200, page_body(vec![log_item(1, "ready")]))).await;
        let reply = t.client.get_logs(Some(log_type), Some(2), Some(10)).await;
        let Ok(LogsReply::Page(page)) = reply else {
            panic!("expected the paginated shape");
        };

        assert_eq!(page.meta.total, 12);
        assert_eq!(page.meta.per_page, 10);
        assert_eq!(page.data.len(), 1);
        assert_eq!(
            t.server.requests()[0].path,
            format!(
                "/api/app/logs?type={}&page=2&per_page=10",
                log_type.as_str()
            )
        );
    }

    let t = setup(|_| Reply::json(200, page_body(vec![]))).await;

    t.client
        .get_logs(Some(LogType::Error), None, None)
        .await
        .unwrap();
    assert_eq!(t.server.requests()[0].path, "/api/app/logs?type=error");
}

#[tokio::test]
async fn get_logs_rejects_the_wrong_shape_for_the_request() {
    let t = setup(|_| Reply::json(200, summary_body())).await;
    let error = t
        .client
        .get_logs(Some(LogType::Error), None, None)
        .await
        .unwrap_err();

    assert_eq!(error.code.as_deref(), Some("invalid_response"));

    let t = setup(|_| Reply::json(200, page_body(vec![]))).await;
    let error = t.client.get_logs(None, None, None).await.unwrap_err();

    assert_eq!(error.code.as_deref(), Some("invalid_response"));
    assert_eq!(error.message, "The site sent an unexpected logs response.");

    let t = setup(|_| Reply::json(200, json!({ "counts": { "total": -1 } }))).await;

    assert!(t.client.get_logs(None, None, None).await.is_err());
}

#[tokio::test]
async fn get_logs_tolerates_unknown_status_and_sanitizes_text() {
    let mut item = log_item(1, "brand_new_status\u{7}");
    item["title"] = json!(format!("T\u{0}itle{}", "x".repeat(400)));
    item["original_filename"] = json!("f".repeat(400));
    item["error_message"] = json!("m".repeat(2500));
    item["error_detail"] = json!(format!("line1\nline2\u{1b}[0m\t{}", "d".repeat(2500)));
    item["progress"] = json!(180.7);

    let t = setup(move |_| Reply::json(200, page_body(vec![item.clone()]))).await;
    let Ok(LogsReply::Page(page)) = t.client.get_logs(Some(LogType::Error), None, None).await
    else {
        panic!("expected the paginated shape");
    };
    let row = &page.data[0];

    assert_eq!(row.status, VideoStatus::Unknown("brand_new_status".into()));
    assert!(row.title.starts_with("Titlexx"));
    assert_eq!(row.title.chars().count(), 255);
    assert_eq!(row.original_filename.as_deref().map(str::len), Some(255));
    assert_eq!(row.error_message.as_deref().map(str::len), Some(2000));
    assert_eq!(row.progress, Some(100));

    let detail = row.error_detail.as_deref().unwrap();

    assert!(detail.starts_with("line1\nline2[0m\tddd"));
    assert_eq!(detail.chars().count(), 2000);
    assert!(!detail.contains('\u{1b}'));
}

#[tokio::test]
async fn get_logs_enforces_the_list_size_caps() {
    let many = |count: i64| -> Vec<Value> { (1..=count).map(|id| log_item(id, "ready")).collect() };

    let mut over = summary_body();
    over["processing"] = json!(many(51));
    let t = setup(move |_| Reply::json(200, over.clone())).await;

    assert_eq!(
        t.client
            .get_logs(None, None, None)
            .await
            .unwrap_err()
            .code
            .as_deref(),
        Some("invalid_response")
    );

    let mut at_limit = summary_body();
    at_limit["processing"] = json!(many(50));
    let t = setup(move |_| Reply::json(200, at_limit.clone())).await;

    assert!(t.client.get_logs(None, None, None).await.is_ok());

    let t = setup(move |_| Reply::json(200, page_body(many(51)))).await;

    assert_eq!(
        t.client
            .get_logs(Some(LogType::Success), None, Some(50))
            .await
            .unwrap_err()
            .code
            .as_deref(),
        Some("invalid_response")
    );
}

#[tokio::test]
async fn get_logs_maps_failures_to_safe_errors_without_leaking_secrets() {
    let t = setup(|_| Reply::json(401, json!({ "message": "Unauthenticated." }))).await;

    t.client.get_logs(None, None, None).await.unwrap_err();
    assert_eq!(t.unauthorized.load(Ordering::SeqCst), 1);

    let busy = setup(|_| {
        Reply::json_with(
            429,
            json!({ "message": "secret server text" }),
            &[("Retry-After", "4")],
        )
    })
    .await;
    let error = busy
        .client
        .get_logs(Some(LogType::Error), Some(1), Some(5))
        .await
        .unwrap_err();

    assert_eq!(error.retry_after_seconds, Some(4));
    assert!(!error.message.contains("secret"));

    let broken =
        setup(|_| Reply::text(500, "<html>trace /var/www tok-123 secret-body</html>")).await;
    let error = broken
        .client
        .get_logs(Some(LogType::Success), None, None)
        .await
        .unwrap_err();
    let base_url = broken.server.base_url.clone();

    assert_eq!(error.message, "Could not load the logs (HTTP 500).");
    assert!(!error.message.contains(&base_url));

    let logs = broken.logger.text();

    assert!(!logs.contains("tok-123") && !logs.contains("secret-body"));
}
