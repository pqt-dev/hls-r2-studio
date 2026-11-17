//! S3 client for Cloudflare R2 (port of steps/s3Client.ts): region `auto`, path-style
//! addressing, SigV4 (`sigv4.rs`) over the app's reqwest/rustls(ring) stack.
//!
//! - Credentials come from the config (`Secret`s, RAM only); they are never logged, never part
//!   of `Debug` output (this type has no `Debug`) and never serialized. Only the HMAC key
//!   derivation sees the secret.
//! - A connection that cannot be opened within [`CONNECTION_TIMEOUT`] fails as a network error.
//! - Socket inactivity: when no byte moves in either direction for [`SOCKET_TIMEOUT`] (no body
//!   chunk taken by the connection, no response byte), the request fails as a network error.
//!   A slow but moving upload is never cut (there is no total-time limit).
//! - Checksums only when the API requires them (R2 does not accept the newer default CRC32
//!   trailer on streamed uploads): `PutObject` sends `UNSIGNED-PAYLOAD` with a fixed
//!   `Content-Length` (no `aws-chunked`, no `x-amz-checksum-*`); `DeleteObjects` sends the
//!   `Content-MD5` the API requires.
//! - `Upload` purpose: exactly one attempt per call (a streamed body cannot be replayed; the
//!   upload step retries). `Cleanup` purpose: list/delete get up to 3 attempts on network
//!   failures (the SDK's standard retry: full-jitter exponential backoff from 100 ms).
//! - Bodies are streamed from the file in 64 KiB chunks (never buffered whole), with a
//!   byte-progress callback; a cancellation token stops a call at once.
//! - Redirects are never followed (a 3xx is an HTTP error); no proxy from the environment.
//! - Like the SDK, a client learns a signing clock offset from the server `Date` header when
//!   the local clock is 5 min or more off, so the next attempt is not refused as skewed.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use http_body::{Body as HttpBody, Frame, SizeHint};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH};
use reqwest::Method;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::sigv4::{authorization, canonical_query, sha256_hex, uri_encode, SigningInput};
use super::{sigv4, xml};
use crate::api::AppConfigR2;
use crate::pipeline::deps::{
    ClientPurpose, ListPage, ObjectStore, ObjectStoreFactory, OnBytes, PutFileRequest, StoreError,
};
use crate::pipeline::upload::classify_error::{classify_upload_error, UploadErrorClass};
use crate::secure::Secret;

pub const REGION: &str = "auto";
const SERVICE: &str = "s3";
pub const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(60);
/// Answers larger than this are refused (a 1000-key listing is far below it).
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const BODY_CHUNK: usize = 64 * 1024;
const RETRY_BASE_MS: f64 = 100.0;
const RETRY_CAP_MS: f64 = 20_000.0;

/// Attempts per call: 1 for uploads, 3 for the replayable list/delete cleanup calls.
pub fn max_attempts(purpose: ClientPurpose) -> u32 {
    match purpose {
        ClientPurpose::Upload => 1,
        ClientPurpose::Cleanup => 3,
    }
}

#[derive(Clone, Copy)]
pub struct R2ClientOptions {
    pub connect_timeout: Duration,
    pub socket_timeout: Duration,
    /// Tests only: allow `http://127.0.0.1` / `http://localhost` endpoints (the loopback mock).
    allow_loopback_http: bool,
}

impl Default for R2ClientOptions {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECTION_TIMEOUT,
            socket_timeout: SOCKET_TIMEOUT,
            allow_loopback_http: false,
        }
    }
}

impl R2ClientOptions {
    #[cfg(test)]
    pub fn loopback_for_tests(socket_timeout: Duration) -> Self {
        Self {
            connect_timeout: CONNECTION_TIMEOUT,
            socket_timeout,
            allow_loopback_http: true,
        }
    }
}

/// Activity of one request: when a byte last moved, and a local (file) error if the body hit
/// one (so it is not mistaken for a network failure).
struct Activity {
    start: Instant,
    last_ms: AtomicU64,
    local_error: Mutex<Option<String>>,
}

impl Activity {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            start: Instant::now(),
            last_ms: AtomicU64::new(0),
            local_error: Mutex::new(None),
        })
    }

    fn touch(&self) {
        let elapsed = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);

        self.last_ms.fetch_max(elapsed, Ordering::SeqCst);
    }

    fn idle(&self) -> Duration {
        let now = self.start.elapsed();
        let last = Duration::from_millis(self.last_ms.load(Ordering::SeqCst));

        now.saturating_sub(last)
    }

    fn set_local_error(&self, message: String) {
        self.local_error
            .lock()
            .expect("activity lock")
            .get_or_insert(message);
    }

    fn local_error(&self) -> Option<String> {
        self.local_error.lock().expect("activity lock").clone()
    }
}

/// Returns once nothing moved for `limit`.
async fn idle_watch(activity: &Activity, limit: Duration) {
    loop {
        let idle = activity.idle();

        if idle >= limit {
            return;
        }

        tokio::time::sleep(limit - idle).await;
    }
}

async fn cancelled(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Exact-length request body read from a file, chunk by chunk.
struct FileBody {
    file: tokio::fs::File,
    remaining: u64,
    sent: u64,
    buffer: Vec<u8>,
    activity: Arc<Activity>,
    on_bytes: Option<OnBytes>,
}

impl HttpBody for FileBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = self.get_mut();

        if this.remaining == 0 {
            return Poll::Ready(None);
        }

        let want = usize::try_from(this.remaining.min(BODY_CHUNK as u64)).unwrap_or(BODY_CHUNK);

        this.buffer.resize(want, 0);

        let mut read = ReadBuf::new(&mut this.buffer[..want]);

        match Pin::new(&mut this.file).poll_read(cx, &mut read) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => {
                this.activity
                    .set_local_error(format!("reading the file failed: {error}"));

                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(Ok(())) => {
                let count = read.filled().len();

                if count == 0 {
                    this.activity
                        .set_local_error("the file is shorter than its size".into());

                    return Poll::Ready(Some(Err(io::Error::from(io::ErrorKind::UnexpectedEof))));
                }

                let chunk = Bytes::copy_from_slice(&this.buffer[..count]);

                this.remaining -= count as u64;
                this.sent += count as u64;
                this.activity.touch();

                if let Some(on_bytes) = &this.on_bytes {
                    on_bytes(this.sent);
                }

                Poll::Ready(Some(Ok(Frame::data(chunk))))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

enum RequestBody {
    Empty,
    Bytes(Vec<u8>),
    File(FileBody),
}

struct Call<'a> {
    method: Method,
    /// Object key, or `None` for a bucket-level call.
    key: Option<&'a str>,
    query: Vec<(&'a str, String)>,
    /// Extra signed headers (lower-case names).
    headers: Vec<(&'static str, String)>,
    body: RequestBody,
}

/// R2 (S3 API) client. Create one per use and drop it when done (`destroy()` in the TS).
pub struct R2Client {
    http: reqwest::Client,
    /// `scheme://host[:port]` + endpoint path without the trailing `/`.
    base: String,
    base_path: String,
    host: String,
    access_key_id: Secret,
    secret_access_key: Secret,
    max_attempts: u32,
    socket_timeout: Duration,
    /// Correction of the local clock for signing (ms), learned from the server `Date` header
    /// when the clocks differ by 5 min or more (the SDK's `systemClockOffset`).
    clock_offset_ms: AtomicI64,
}

/// Clocks this far apart make S3 refuse a signature (`RequestTimeTooSkewed`).
const CLOCK_SKEW_LIMIT_MS: i64 = 5 * 60 * 1000;

/// The new signing offset after an answer that carried `Date: server_date` (the SDK's
/// `getUpdatedSystemClockOffset`): unchanged unless the corrected clock is 5 min or more off.
pub fn updated_clock_offset(server_date: Option<&str>, local_ms: i64, offset_ms: i64) -> i64 {
    let Some(server_ms) = server_date
        .and_then(|d| chrono::DateTime::parse_from_rfc2822(d.trim()).ok())
        .map(|d| d.timestamp_millis())
    else {
        return offset_ms;
    };

    if (local_ms + offset_ms - server_ms).abs() >= CLOCK_SKEW_LIMIT_MS {
        server_ms - local_ms
    } else {
        offset_ms
    }
}

impl R2Client {
    pub fn new(r2: &AppConfigR2, purpose: ClientPurpose) -> Result<Self, StoreError> {
        Self::with_options(r2, purpose, R2ClientOptions::default())
    }

    pub fn with_options(
        r2: &AppConfigR2,
        purpose: ClientPurpose,
        options: R2ClientOptions,
    ) -> Result<Self, StoreError> {
        let invalid = || StoreError::Local("The R2 endpoint is not a valid https URL.".into());
        let url = Url::parse(r2.endpoint.trim()).map_err(|_| invalid())?;
        let loopback = options.allow_loopback_http
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));

        if !(url.scheme() == "https" || loopback)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }

        let host_name = url
            .host_str()
            .filter(|h| !h.is_empty())
            .ok_or_else(invalid)?;
        let host = match url.port() {
            Some(port) => format!("{host_name}:{port}"),
            None => host_name.to_string(),
        };
        let base_path = url.path().trim_end_matches('/').to_string();

        crate::api::site_client::ensure_crypto_provider();

        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!loopback)
            .no_proxy()
            .connect_timeout(options.connect_timeout)
            .build()
            .map_err(|_| StoreError::Local("Could not set up the R2 client.".into()))?;

        Ok(Self {
            http,
            base: format!("{}://{host}", url.scheme()),
            base_path,
            host,
            access_key_id: r2.access_key_id.clone(),
            secret_access_key: r2.secret_access_key.clone(),
            max_attempts: max_attempts(purpose),
            socket_timeout: options.socket_timeout,
            clock_offset_ms: AtomicI64::new(0),
        })
    }

    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    pub fn socket_timeout(&self) -> Duration {
        self.socket_timeout
    }

    /// One HTTP exchange: signed, watched for inactivity, cancellable. Returns the status and
    /// the (bounded) body of a 2xx answer; anything else is an error.
    async fn send(
        &self,
        bucket: &str,
        call: Call<'_>,
        activity: Arc<Activity>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<u8>, StoreError> {
        let mut uri = format!("{}/{}", self.base_path, uri_encode(bucket, false));

        // Path style: `/<bucket>/<key>` for objects, `/<bucket>` for bucket calls (like the SDK).
        if let Some(key) = call.key {
            uri.push('/');
            uri.push_str(&uri_encode(key, true));
        }

        let query_pairs: Vec<(&str, &str)> =
            call.query.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let query = canonical_query(&query_pairs);
        let url = if query.is_empty() {
            format!("{}{uri}", self.base)
        } else {
            format!("{}{uri}?{query}", self.base)
        };
        let payload_hash = match &call.body {
            RequestBody::Empty => sha256_hex(b""),
            RequestBody::Bytes(bytes) => sha256_hex(bytes),
            RequestBody::File(_) => sigv4::UNSIGNED_PAYLOAD.to_string(),
        };
        let signing_now = Utc::now()
            + chrono::Duration::milliseconds(self.clock_offset_ms.load(Ordering::SeqCst));
        let amz_date = signing_now.format("%Y%m%dT%H%M%SZ").to_string();
        let mut signed: Vec<(&str, &str)> = vec![
            ("host", &self.host),
            ("x-amz-content-sha256", &payload_hash),
            ("x-amz-date", &amz_date),
        ];

        signed.extend(call.headers.iter().map(|(n, v)| (*n, v.as_str())));

        let auth = authorization(&SigningInput {
            method: call.method.as_str(),
            canonical_uri: &uri,
            canonical_query: &query,
            headers: &signed,
            payload_hash: &payload_hash,
            region: REGION,
            service: SERVICE,
            amz_date: &amz_date,
            access_key_id: self.access_key_id.expose(),
            secret_access_key: self.secret_access_key.expose(),
        });
        let mut headers = HeaderMap::new();
        let bad = |_| StoreError::Local("Invalid R2 request header.".into());

        for (name, value) in &signed {
            if *name == "host" {
                continue;
            }

            headers.insert(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| StoreError::Local("Invalid R2 request header.".into()))?,
                HeaderValue::from_str(value).map_err(bad)?,
            );
        }

        let mut auth_value = HeaderValue::from_str(&auth).map_err(bad)?;

        auth_value.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, auth_value);

        let request = self.http.request(call.method, &url).headers(headers);
        let request = match call.body {
            RequestBody::Empty => request,
            RequestBody::Bytes(bytes) => request.header(CONTENT_LENGTH, bytes.len()).body(bytes),
            RequestBody::File(body) => request
                .header(CONTENT_LENGTH, body.remaining)
                .body(reqwest::Body::wrap(body)),
        };

        activity.touch();

        let exchange = async {
            let response = request
                .send()
                .await
                .map_err(|e| transport_error(e, &activity))?;

            activity.touch();

            let status = response.status().as_u16();
            let server_date = response
                .headers()
                .get(reqwest::header::DATE)
                .and_then(|v| v.to_str().ok());
            let offset = self.clock_offset_ms.load(Ordering::SeqCst);

            self.clock_offset_ms.store(
                updated_clock_offset(server_date, Utc::now().timestamp_millis(), offset),
                Ordering::SeqCst,
            );
            let mut response = response;
            let mut body = Vec::new();

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| transport_error(e, &activity))?
            {
                activity.touch();

                if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(StoreError::Local("The R2 answer was too large.".into()));
                }

                body.extend_from_slice(&chunk);
            }

            if (200..300).contains(&status) {
                Ok(body)
            } else {
                Err(StoreError::Http {
                    status,
                    code: xml::error_code(&String::from_utf8_lossy(&body)),
                })
            }
        };

        tokio::select! {
            biased;
            () = cancelled(cancel) => Err(StoreError::Cancelled),
            result = exchange => result,
            () = idle_watch(&activity, self.socket_timeout) => Err(StoreError::Network(format!(
                "socket timeout: no data moved for {} ms",
                self.socket_timeout.as_millis()
            ))),
        }
    }

    /// A replayable call with the purpose's attempt budget (network failures only).
    async fn send_replayable(
        &self,
        bucket: &str,
        make: impl Fn() -> Call<'static>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<u8>, StoreError> {
        let mut attempt = 1;

        loop {
            let result = self.send(bucket, make(), Activity::new(), cancel).await;

            match result {
                Err(error)
                    if attempt < self.max_attempts
                        && error != StoreError::Cancelled
                        && classify_upload_error(&error, cancel) == UploadErrorClass::Network =>
                {
                    let ceiling = (RETRY_BASE_MS * 2f64.powi(attempt as i32)).min(RETRY_CAP_MS);
                    let wait = Duration::from_millis((ceiling * random_fraction()) as u64);

                    tokio::select! {
                        () = cancelled(cancel) => return Err(StoreError::Cancelled),
                        () = tokio::time::sleep(wait) => {}
                    }

                    attempt += 1;
                }
                other => return other,
            }
        }
    }
}

/// A uniform value in [0, 1) from the OS-seeded `RandomState` (no extra dependency).
fn random_fraction() -> f64 {
    use std::hash::{BuildHasher, Hasher, RandomState};

    (RandomState::new().build_hasher().finish() >> 11) as f64 / (1u64 << 53) as f64
}

/// Text of an error and its sources, without the request URL (it names the account).
fn error_chain(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(&error);

    while let Some(inner) = source {
        let text = inner.to_string();

        if !parts.contains(&text) {
            parts.push(text);
        }

        source = inner.source();
    }

    parts.join(": ")
}

fn transport_error(error: reqwest::Error, activity: &Activity) -> StoreError {
    if let Some(local) = activity.local_error() {
        return StoreError::Local(local);
    }

    if error.is_builder() {
        return StoreError::Local(error_chain(error));
    }

    StoreError::Network(error_chain(error))
}

fn content_md5(data: &[u8]) -> String {
    use base64_lite::encode;
    use md5::{Digest, Md5};

    encode(&Md5::digest(data))
}

/// Minimal standard base64 (with padding) for the 16-byte `Content-MD5`.
mod base64_lite {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(data: &[u8]) -> String {
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

        for chunk in data.chunks(3) {
            let b = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);

            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }

        out
    }
}

#[async_trait]
impl ObjectStore for R2Client {
    async fn list_page(
        &self,
        bucket: &str,
        prefix: &str,
        max_keys: Option<usize>,
        token: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Result<ListPage, StoreError> {
        let prefix = prefix.to_string();
        let token = token.map(str::to_string);
        let body = self
            .send_replayable(
                bucket,
                || {
                    let mut query =
                        vec![("list-type", "2".to_string()), ("prefix", prefix.clone())];

                    if let Some(max) = max_keys {
                        query.push(("max-keys", max.to_string()));
                    }

                    if let Some(token) = &token {
                        query.push(("continuation-token", token.clone()));
                    }

                    Call {
                        method: Method::GET,
                        key: None,
                        query,
                        headers: vec![],
                        body: RequestBody::Empty,
                    }
                },
                cancel,
            )
            .await?;

        xml::parse_list(&String::from_utf8_lossy(&body))
            .ok_or_else(|| StoreError::Local("The R2 listing could not be read.".into()))
    }

    async fn delete_keys(&self, bucket: &str, keys: &[String]) -> Result<usize, StoreError> {
        let body = xml::delete_body(keys);
        let md5 = content_md5(body.as_bytes());
        let answer = self
            .send_replayable(
                bucket,
                || Call {
                    method: Method::POST,
                    key: None,
                    query: vec![("delete", String::new())],
                    headers: vec![
                        ("content-md5", md5.clone()),
                        ("content-type", "application/xml".to_string()),
                    ],
                    body: RequestBody::Bytes(body.clone().into_bytes()),
                },
                None,
            )
            .await?;

        Ok(xml::delete_failures(&String::from_utf8_lossy(&answer)))
    }

    async fn put_file(
        &self,
        request: PutFileRequest<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), StoreError> {
        let file = tokio::fs::File::open(request.path)
            .await
            .map_err(|e| StoreError::Local(format!("opening the file failed: {}", e.kind())))?;
        let activity = Activity::new();
        let body = FileBody {
            file,
            remaining: request.content_length,
            sent: 0,
            buffer: Vec::new(),
            activity: Arc::clone(&activity),
            on_bytes: request.on_bytes.clone(),
        };
        let call = Call {
            method: Method::PUT,
            key: Some(request.key),
            query: vec![],
            headers: vec![("content-type", request.content_type.to_string())],
            body: RequestBody::File(body),
        };

        // Exactly one attempt, whatever the purpose: the body is a stream.
        self.send(request.bucket, call, activity, Some(cancel))
            .await
            .map(|_| ())
    }
}

/// Production factory (`createR2Client`).
pub struct R2ClientFactory {
    options: R2ClientOptions,
}

impl R2ClientFactory {
    pub fn new() -> Self {
        Self {
            options: R2ClientOptions::default(),
        }
    }

    #[cfg(test)]
    pub fn with_options(options: R2ClientOptions) -> Self {
        Self { options }
    }
}

impl Default for R2ClientFactory {
    fn default() -> Self {
        Self::new()
    }
}

impl ObjectStoreFactory for R2ClientFactory {
    fn create(
        &self,
        r2: &AppConfigR2,
        purpose: ClientPurpose,
    ) -> Result<Arc<dyn ObjectStore>, StoreError> {
        Ok(Arc::new(R2Client::with_options(r2, purpose, self.options)?))
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
