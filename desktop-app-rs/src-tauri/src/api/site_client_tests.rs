//! Port of desktop-app/src/main/api/siteClient.test.ts against a real loopback HTTP server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::api::app_config::Resolution;
use crate::api::test_server::{closed_port_url, Recorded, Reply, TestServer};
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
