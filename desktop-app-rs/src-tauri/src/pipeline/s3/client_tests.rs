//! R2 client against the loopback fake S3 server (signature checked by the server). Port of
//! steps/s3Client.test.ts plus the HTTP-level behaviors the SDK gave the TS for free.

use std::time::Duration;

use super::*;
use crate::pipeline::testing::fake_s3_server::{
    options, Fail, FakeS3Server, RequestType, TEST_ACCESS_KEY, TEST_SECRET_KEY,
};

const BUCKET: &str = "test-bucket";

fn r2(endpoint: &str) -> AppConfigR2 {
    AppConfigR2 {
        access_key_id: Secret::from(TEST_ACCESS_KEY),
        secret_access_key: Secret::from(TEST_SECRET_KEY),
        bucket: BUCKET.into(),
        endpoint: endpoint.into(),
        url: "https://cdn.example.com".into(),
    }
}

fn client(server: &FakeS3Server, purpose: ClientPurpose) -> R2Client {
    client_with(server, purpose, Duration::from_secs(10))
}

fn client_with(server: &FakeS3Server, purpose: ClientPurpose, socket: Duration) -> R2Client {
    R2Client::with_options(
        &r2(&server.endpoint),
        purpose,
        R2ClientOptions::loopback_for_tests(socket),
    )
    .unwrap()
}

fn file_with(bytes: usize) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.bin");
    let data: Vec<u8> = (0..bytes).map(|i| (i % 251) as u8).collect();

    std::fs::write(&path, data).unwrap();

    (dir, path)
}

async fn put(
    client: &R2Client,
    key: &str,
    path: &std::path::Path,
    length: u64,
    cancel: &CancellationToken,
) -> Result<(), StoreError> {
    client
        .put_file(
            PutFileRequest {
                bucket: BUCKET,
                key,
                path,
                content_length: length,
                content_type: "video/mp2t",
                on_bytes: None,
            },
            cancel,
        )
        .await
}

#[test]
fn never_retries_uploads_and_keeps_3_attempts_for_cleanup() {
    let r2 = r2("https://acct.r2.cloudflarestorage.com");

    assert_eq!(
        R2Client::new(&r2, ClientPurpose::Upload)
            .unwrap()
            .max_attempts(),
        1
    );
    assert_eq!(
        R2Client::new(&r2, ClientPurpose::Cleanup)
            .unwrap()
            .max_attempts(),
        3
    );
    assert_eq!(max_attempts(ClientPurpose::Upload), 1);
    assert_eq!(max_attempts(ClientPurpose::Cleanup), 3);
}

#[test]
fn times_out_a_stalled_connection_15_s_to_connect_60_s_socket_inactivity() {
    assert_eq!(CONNECTION_TIMEOUT, Duration::from_secs(15));
    assert_eq!(SOCKET_TIMEOUT, Duration::from_secs(60));

    for purpose in [ClientPurpose::Upload, ClientPurpose::Cleanup] {
        let client = R2Client::new(&r2("https://acct.r2.cloudflarestorage.com"), purpose).unwrap();

        assert_eq!(client.socket_timeout(), SOCKET_TIMEOUT);
        assert_eq!(
            R2ClientOptions::default().connect_timeout,
            CONNECTION_TIMEOUT
        );
    }
}

#[test]
fn refuses_non_https_endpoints_in_production() {
    for endpoint in [
        "http://acct.r2.cloudflarestorage.com",
        "http://127.0.0.1:9",
        "ftp://x",
        "https://user:pw@acct.r2.cloudflarestorage.com",
        "https://acct.r2.cloudflarestorage.com/?x=1",
        "not a url",
        "",
    ] {
        assert!(
            matches!(
                R2Client::new(&r2(endpoint), ClientPurpose::Upload),
                Err(StoreError::Local(_))
            ),
            "{endpoint}"
        );
    }

    // The loopback test option still refuses http for anything but loopback.
    assert!(R2Client::with_options(
        &r2("http://example.com"),
        ClientPurpose::Upload,
        R2ClientOptions::loopback_for_tests(SOCKET_TIMEOUT)
    )
    .is_err());
}

#[tokio::test]
async fn puts_path_style_with_a_streamed_body_and_no_checksum_headers() {
    let server = FakeS3Server::start(options(BUCKET)).await;
    let client = client(&server, ClientPurpose::Upload);
    let (_dir, path) = file_with(200_000);
    let progress = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&progress);
    let key = "2026/03/05/x-ab12cd34ef56/segment 000+a.ts";

    client
        .put_file(
            PutFileRequest {
                bucket: BUCKET,
                key,
                path: &path,
                content_length: 200_000,
                content_type: "video/mp2t",
                on_bytes: Some(Arc::new(move |n| seen.lock().unwrap().push(n))),
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    let objects = server.objects();

    assert_eq!(objects.get(key).unwrap(), &std::fs::read(&path).unwrap());

    let request = &server.requests()[0];

    assert_eq!(request.method, "PUT");
    assert_eq!(request.signature_ok, Some(true));
    assert!(request
        .target
        .starts_with(&format!("/{BUCKET}/2026/03/05/")));
    assert!(request.target.contains("segment%20000%2Ba.ts"));
    assert_eq!(request.header("content-type"), Some("video/mp2t"));
    assert_eq!(request.header("content-length"), Some("200000"));
    assert_eq!(
        request.header("x-amz-content-sha256"),
        Some("UNSIGNED-PAYLOAD")
    );
    assert!(request
        .header("authorization")
        .unwrap()
        .contains("/auto/s3/aws4_request"));

    for absent in [
        "transfer-encoding",
        "content-encoding",
        "x-amz-sdk-checksum-algorithm",
        "x-amz-checksum-crc32",
        "x-amz-trailer",
        "x-amz-decoded-content-length",
        "x-amz-acl",
        "cache-control",
        "expect",
    ] {
        assert_eq!(request.header(absent), None, "{absent}");
    }

    let progress = progress.lock().unwrap().clone();

    assert!(progress.len() >= 3);
    assert!(progress.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(progress.last(), Some(&200_000));
}

#[tokio::test]
async fn never_sends_the_secret() {
    let server = FakeS3Server::start(options(BUCKET)).await;
    let client = client(&server, ClientPurpose::Upload);
    let (_dir, path) = file_with(10);

    put(&client, "a.ts", &path, 10, &CancellationToken::new())
        .await
        .unwrap();

    for request in server.requests() {
        for (_, value) in &request.headers {
            assert!(!value.contains(TEST_SECRET_KEY));
        }

        assert!(!request.target.contains(TEST_SECRET_KEY));
    }
}

#[tokio::test]
async fn lists_every_page_with_sizes_and_deletes_with_content_md5() {
    let mut opts = options(BUCKET);

    opts.undeletable = vec!["p/c".into()];

    let server = FakeS3Server::start(opts).await;

    for (key, size) in [("p/a", 1), ("p/b", 22), ("p/c", 3), ("q/x", 4)] {
        server.put_object(key, &vec![0; size]);
    }

    let client = client(&server, ClientPurpose::Cleanup);
    let first = client
        .list_page(BUCKET, "p/", Some(2), None, None)
        .await
        .unwrap();

    assert_eq!(first.keys().collect::<Vec<_>>(), ["p/a", "p/b"]);
    assert_eq!(first.objects[1].size, Some(22));

    let second = client
        .list_page(BUCKET, "p/", Some(2), first.next_token.as_deref(), None)
        .await
        .unwrap();

    assert_eq!(second.keys().collect::<Vec<_>>(), ["p/c"]);
    assert_eq!(second.next_token, None);

    let failures = client
        .delete_keys(BUCKET, &["p/a".into(), "p/b".into(), "p/c".into()])
        .await
        .unwrap();

    assert_eq!(failures, 1);
    assert_eq!(
        server.objects().keys().cloned().collect::<Vec<_>>(),
        ["p/c", "q/x"]
    );

    let requests = server.requests();

    assert!(requests.iter().all(|r| r.signature_ok == Some(true)));
    assert!(requests[0].target.contains("prefix=p%2F"));
    assert!(requests[0].target.contains("max-keys=2"));
    assert_eq!(requests.last().unwrap().kind, RequestType::Delete);
    assert!(requests.last().unwrap().header("content-md5").is_some());
}

#[tokio::test]
async fn maps_http_errors_with_their_s3_code() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|r, _| {
        Some(if r.kind == RequestType::Put {
            Fail::Status(403, "AccessDenied")
        } else {
            Fail::Status(503, "SlowDown")
        })
    }));

    let server = FakeS3Server::start(opts).await;
    let (_dir, path) = file_with(5);
    let upload = client(&server, ClientPurpose::Upload);

    assert_eq!(
        put(&upload, "a.ts", &path, 5, &CancellationToken::new()).await,
        Err(StoreError::Http {
            status: 403,
            code: Some("AccessDenied".into())
        })
    );
    assert_eq!(
        upload.list_page(BUCKET, "p/", None, None, None).await,
        Err(StoreError::Http {
            status: 503,
            code: Some("SlowDown".into())
        })
    );
}

#[tokio::test]
async fn an_upload_is_sent_exactly_once_even_on_a_503() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Status(503, "InternalError"))));

    let server = FakeS3Server::start(opts).await;
    let (_dir, path) = file_with(5);

    for purpose in [ClientPurpose::Upload, ClientPurpose::Cleanup] {
        let client = client(&server, purpose);

        assert!(put(&client, "a.ts", &path, 5, &CancellationToken::new())
            .await
            .is_err());
    }

    assert_eq!(server.puts().len(), 2);
}

#[tokio::test]
async fn cleanup_calls_get_3_attempts_on_network_failures_upload_clients_one() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|r, serial| {
        (r.kind == RequestType::List && serial <= 2).then_some(Fail::Destroy)
    }));

    let server = FakeS3Server::start(opts).await;
    let cleanup = client(&server, ClientPurpose::Cleanup);

    assert!(cleanup
        .list_page(BUCKET, "p/", None, None, None)
        .await
        .is_ok());
    assert_eq!(server.requests().len(), 3);

    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Destroy)));

    let failing = FakeS3Server::start(opts).await;
    let upload = client(&failing, ClientPurpose::Upload);

    assert!(matches!(
        upload.list_page(BUCKET, "p/", None, None, None).await,
        Err(StoreError::Network(_))
    ));
    assert_eq!(failing.requests().len(), 1);

    let cleanup = client(&failing, ClientPurpose::Cleanup);

    assert!(matches!(
        cleanup.delete_keys(BUCKET, &["p/a".into()]).await,
        Err(StoreError::Network(_))
    ));
    assert_eq!(failing.requests().len(), 4);
}

#[tokio::test]
async fn a_403_is_not_retried_by_the_cleanup_client() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Status(403, "AccessDenied"))));

    let server = FakeS3Server::start(opts).await;
    let cleanup = client(&server, ClientPurpose::Cleanup);

    assert!(cleanup
        .list_page(BUCKET, "p/", None, None, None)
        .await
        .is_err());
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn a_dropped_connection_and_a_refused_one_are_network_errors() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Destroy)));

    let server = FakeS3Server::start(opts).await;
    let (_dir, path) = file_with(5);
    let upload = client(&server, ClientPurpose::Upload);

    assert!(matches!(
        put(&upload, "a.ts", &path, 5, &CancellationToken::new()).await,
        Err(StoreError::Network(_))
    ));

    let closed = crate::api::test_server::closed_port_url().await;
    let refused = R2Client::with_options(
        &r2(&closed),
        ClientPurpose::Upload,
        R2ClientOptions::loopback_for_tests(SOCKET_TIMEOUT),
    )
    .unwrap();

    assert!(matches!(
        put(&refused, "a.ts", &path, 5, &CancellationToken::new()).await,
        Err(StoreError::Network(_))
    ));
}

#[tokio::test]
async fn a_stalled_connection_fails_after_the_socket_timeout() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Stall)));

    let server = FakeS3Server::start(opts).await;
    // Large enough to fill the socket buffers, so the body stops moving.
    let (_dir, path) = file_with(16 * 1024 * 1024);
    let upload = client_with(&server, ClientPurpose::Upload, Duration::from_millis(400));
    let started = std::time::Instant::now();
    let result = put(
        &upload,
        "a.ts",
        &path,
        16 * 1024 * 1024,
        &CancellationToken::new(),
    )
    .await;

    assert!(
        matches!(&result, Err(StoreError::Network(m)) if m.contains("socket timeout")),
        "{result:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(10));

    // A small body that never gets an answer times out the same way.
    let (_dir, small) = file_with(10);

    assert!(matches!(
        put(&upload, "b.ts", &small, 10, &CancellationToken::new()).await,
        Err(StoreError::Network(_))
    ));
}

#[tokio::test]
async fn a_slow_but_moving_upload_is_never_cut() {
    let mut opts = options(BUCKET);

    opts.recv_buffer = Some(16 * 1024);
    opts.fail_when = Some(Box::new(|r, _| {
        (r.kind == RequestType::Put).then_some(Fail::SlowRead {
            chunk: 64 * 1024,
            every: Duration::from_millis(25),
        })
    }));

    let server = FakeS3Server::start(opts).await;
    // ~8 MB at ~2.6 MB/s: longer than the 2 s inactivity limit, but always moving. (The limit
    // has to cover draining the kernel socket buffers after the last chunk was handed over,
    // exactly like a socket-level timeout.)
    let size = 8 * 1024 * 1024;
    let (_dir, path) = file_with(size);
    let upload = client_with(&server, ClientPurpose::Upload, Duration::from_secs(2));
    let started = std::time::Instant::now();

    put(
        &upload,
        "slow.ts",
        &path,
        size as u64,
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert!(started.elapsed() > Duration::from_millis(2500));
    assert_eq!(server.objects().get("slow.ts").map(Vec::len), Some(size));
}

#[tokio::test(start_paused = true)]
async fn the_inactivity_watch_only_fires_when_nothing_moves() {
    let activity = Activity::new();
    let limit = Duration::from_millis(200);
    let watch = idle_watch(&activity, limit);

    tokio::pin!(watch);

    // 50 touches 100 ms apart: 5 s of activity, far beyond the limit, never idle for 200 ms.
    for _ in 0..50 {
        tokio::select! {
            () = &mut watch => panic!("fired while bytes were moving"),
            () = tokio::time::sleep(Duration::from_millis(100)) => activity.touch(),
        }
    }

    let quiet = tokio::time::Instant::now();

    (&mut watch).await;

    let fired_after = quiet.elapsed();

    assert!(fired_after >= Duration::from_millis(200), "{fired_after:?}");
    assert!(fired_after <= Duration::from_millis(210), "{fired_after:?}");
}

#[tokio::test]
async fn cancelling_stops_a_request_at_once() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Stall)));

    let server = FakeS3Server::start(opts).await;
    let (_dir, path) = file_with(10);
    let upload = client(&server, ClientPurpose::Upload);
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
    });

    let started = std::time::Instant::now();

    assert_eq!(
        put(&upload, "a.ts", &path, 10, &cancel).await,
        Err(StoreError::Cancelled)
    );
    assert!(started.elapsed() < Duration::from_secs(5));

    let listing = CancellationToken::new();

    listing.cancel();

    assert_eq!(
        upload
            .list_page(BUCKET, "p/", None, None, Some(&listing))
            .await,
        Err(StoreError::Cancelled)
    );
}

#[tokio::test]
async fn local_file_problems_are_local_errors() {
    let server = FakeS3Server::start(options(BUCKET)).await;
    let upload = client(&server, ClientPurpose::Upload);
    let dir = tempfile::tempdir().unwrap();

    assert!(matches!(
        put(
            &upload,
            "a.ts",
            &dir.path().join("missing.ts"),
            5,
            &CancellationToken::new()
        )
        .await,
        Err(StoreError::Local(_))
    ));

    let (_dir, short) = file_with(10);

    assert!(matches!(
        put(&upload, "b.ts", &short, 100, &CancellationToken::new()).await,
        Err(StoreError::Local(_))
    ));
    assert!(server.objects().is_empty());
}

#[tokio::test]
async fn never_follows_a_redirect() {
    let mut opts = options(BUCKET);

    opts.fail_when = Some(Box::new(|_, _| Some(Fail::Redirect)));

    let server = FakeS3Server::start(opts).await;
    let cleanup = client(&server, ClientPurpose::Cleanup);

    assert_eq!(
        cleanup.list_page(BUCKET, "p/", None, None, None).await,
        Err(StoreError::Http {
            status: 301,
            code: None
        })
    );
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn the_factory_creates_independent_clients() {
    let server = FakeS3Server::start(options(BUCKET)).await;
    let factory =
        R2ClientFactory::with_options(R2ClientOptions::loopback_for_tests(SOCKET_TIMEOUT));
    let store = factory
        .create(&r2(&server.endpoint), ClientPurpose::Cleanup)
        .unwrap();
    store.list_page(BUCKET, "", None, None, None).await.unwrap();

    assert_eq!(server.requests().len(), 1);
    assert!(R2ClientFactory::new()
        .create(&r2("http://example.com"), ClientPurpose::Upload)
        .is_err());
}

#[test]
fn base64_and_md5_match_known_values() {
    assert_eq!(content_md5(b""), "1B2M2Y8AsgTpgAmY7PhCfg==");
    assert_eq!(base64_lite::encode(b"f"), "Zg==");
    assert_eq!(base64_lite::encode(b"fo"), "Zm8=");
    assert_eq!(base64_lite::encode(b"foo"), "Zm9v");
    assert_eq!(base64_lite::encode(b"foobar"), "Zm9vYmFy");
}

#[test]
fn learns_a_clock_offset_only_when_the_clocks_are_5_minutes_apart() {
    let server = "Thu, 05 Mar 2026 10:00:00 GMT";
    let server_ms = chrono::DateTime::parse_from_rfc2822(server)
        .unwrap()
        .timestamp_millis();

    // 10 minutes behind: the offset makes up the difference.
    assert_eq!(
        updated_clock_offset(Some(server), server_ms - 600_000, 0),
        600_000
    );
    // 4 minutes apart: unchanged.
    assert_eq!(
        updated_clock_offset(Some(server), server_ms - 240_000, 0),
        0
    );
    // An already corrected clock stays as it is.
    assert_eq!(
        updated_clock_offset(Some(server), server_ms - 600_000, 600_000),
        600_000
    );
    // No or a broken Date header: unchanged.
    assert_eq!(updated_clock_offset(None, 0, 7), 7);
    assert_eq!(updated_clock_offset(Some("yesterday"), 0, 7), 7);
}

#[tokio::test]
async fn signs_the_next_request_with_the_server_clock_after_a_skewed_answer() {
    let mut opts = options(BUCKET);

    opts.date = Some("Tue, 05 Mar 2030 10:00:00 GMT".into());
    opts.fail_when = Some(Box::new(|_, serial| {
        (serial == 1).then_some(Fail::Status(403, "RequestTimeTooSkewed"))
    }));

    let server = FakeS3Server::start(opts).await;
    let (_dir, path) = file_with(5);
    let upload = client(&server, ClientPurpose::Upload);
    let cancel = CancellationToken::new();

    assert!(put(&upload, "a.ts", &path, 5, &cancel).await.is_err());
    put(&upload, "a.ts", &path, 5, &cancel).await.unwrap();

    let requests = server.requests();

    assert!(!requests[0]
        .header("x-amz-date")
        .unwrap()
        .starts_with("2030"));
    assert!(requests[1]
        .header("x-amz-date")
        .unwrap()
        .starts_with("20300305T"));
    assert_eq!(requests[1].signature_ok, Some(true));
}
