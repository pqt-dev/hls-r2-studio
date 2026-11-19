//! HTTP client for the site API (spec 3.5). Port of desktop-app/src/main/api/siteClient.ts.
//!
//! Rules (same as the Electron client):
//! - The origin comes from the built-in site URL and is validated again on every request
//!   (https only; see `site_url::normalize`).
//! - Redirects are never followed: a 3xx could carry the Bearer token to another host.
//! - One timeout (default 30 s) covers the whole exchange, body included.
//! - Bodies larger than 1 MB are refused while streaming; nothing larger is buffered.
//! - No retries. Error messages are safe English text; bodies and tokens are never logged.
//! - Any 401 on an authenticated call whose token is still the current one calls
//!   `on_unauthorized` exactly once.
//! - `register()` (POST /api/app/videos) reuses `send()`; its failures are `RegisterRequestError`s
//!   so the pipeline can classify them (`pipeline::register::map_register_error`).

use std::sync::{Arc, Once};
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use zeroize::Zeroizing;

use super::app_config::{parse_app_config, r2_location_problem, AppConfig};
use super::error::SiteApiError;
use super::image_upload::{build_multipart, ImageKind};
use super::logs::{LogType, LogsPage, LogsReply, LogsSummary};
use super::overview::Overview;
use super::r2::{
    parse_field_errors, parse_r2_status, parse_r2_test, R2Input, R2SaveError, R2Status,
    R2TestOutcome,
};
use super::videos::{
    clean_url, normalize_video_title, BulkDeleteOutcome, VideoDeleteOutcome, VideoDetail,
    VideoPage, VideoSort, MAX_BULK_DELETE, MAX_LIST_ITEMS, MAX_VIDEOS_PER_PAGE, TITLE_INVALID,
};
use crate::logger::Log;
use crate::pipeline::register::{
    RegisterClient, RegisterFailure, RegisterPayload, RegisterRequestError, RegisteredVideo,
};
use crate::secure::Secret;
use crate::site_url;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Responses larger than this are treated as invalid (the API only returns tiny JSON).
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

const IMAGE_REJECTED: &str =
    "The image was rejected by the server. Use a JPG, PNG or WebP image up to 5 MB.";

pub type GetBaseUrl = Arc<dyn Fn() -> String + Send + Sync>;
pub type GetToken = Arc<dyn Fn() -> Option<Secret> + Send + Sync>;
pub type OnUnauthorized = Arc<dyn Fn() + Send + Sync>;

pub struct SiteClientOptions {
    /// Current site URL (validated again on every request).
    pub get_base_url: GetBaseUrl,
    pub get_token: GetToken,
    pub user_agent: String,
    pub timeout: Duration,
    /// Called once for ANY 401 on an authenticated call whose token is still the current one.
    pub on_unauthorized: Option<OnUnauthorized>,
    pub logger: Option<Arc<dyn Log>>,
}

/// `HLS-R2-Studio/<version> (<platform>)`, like the Electron app.
pub fn user_agent(version: &str) -> String {
    format!(
        "HLS-R2-Studio/{version} ({})",
        crate::ipc::platform_name(std::env::consts::OS)
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoginResult {
    pub token: Secret,
    pub username: String,
}

/// One HTTP answer. The body may hold a token (sign-in), so it is wiped when dropped.
struct RawResponse {
    status: u16,
    body: Zeroizing<Vec<u8>>,
    retry_after_seconds: Option<u64>,
}

impl RawResponse {
    /// JSON of the body; `Null` when empty or not JSON.
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

fn parse_retry_after(header: Option<&HeaderValue>) -> Option<u64> {
    let text = header?.to_str().ok()?.trim();

    if text.is_empty() || text.len() > 6 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    text.parse().ok()
}

fn error_code_of(body: &Value) -> Option<String> {
    body.get("error")?.as_str().map(str::to_string)
}

/// A header value backed by a buffer that is wiped when the request is dropped.
fn secret_header(value: Zeroizing<Vec<u8>>) -> Option<HeaderValue> {
    let mut header = HeaderValue::from_maybe_shared(Bytes::from_owner(value)).ok()?;
    header.set_sensitive(true);

    Some(header)
}

/// Appends `chunk`, growing into a fresh zeroizing buffer so no stale copy is left behind.
fn push_wiped(buffer: &mut Zeroizing<Vec<u8>>, chunk: &[u8]) {
    let needed = buffer.len() + chunk.len();

    if needed > buffer.capacity() {
        let capacity = needed.max(buffer.capacity() * 2).min(MAX_BODY_BYTES);
        let mut bigger = Zeroizing::new(Vec::with_capacity(capacity));

        bigger.extend_from_slice(buffer);
        *buffer = bigger;
    }

    buffer.extend_from_slice(chunk);
}

const LOOPBACK_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

/// The request origin. Production: `site_url::normalize` (https only). Loopback tests may also
/// use `http://localhost` / `http://127.0.0.1`.
fn request_origin(raw: &str, allow_loopback_http: bool) -> Result<String, String> {
    if allow_loopback_http {
        if let Ok(url) = Url::parse(raw.trim()) {
            if url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h))
            {
                return Ok(url.origin().ascii_serialization());
            }
        }
    }

    site_url::normalize(raw)
}

pub(crate) fn ensure_crypto_provider() {
    static INSTALL: Once = Once::new();

    // `ring` instead of reqwest's default aws-lc-rs: no cmake/NASM needed to build on Windows.
    // Err only means another provider is already installed, which is fine.
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
    device_name: &'a str,
}

#[derive(Deserialize)]
struct LoginUser {
    #[serde(default)]
    username: Option<String>,
}

#[derive(Deserialize)]
struct LoginBody {
    #[serde(default)]
    token: Option<Secret>,
    #[serde(default)]
    user: Option<LoginUser>,
}

enum Failure {
    Send(String),
    Read(String),
}

pub struct SiteClient {
    http: Result<reqwest::Client, String>,
    options: SiteClientOptions,
    /// Tests only: allows `http://` for loopback base URLs (the mock server).
    allow_loopback_http: bool,
    /// Tests only: allows `http://localhost` R2 locations (`allowInsecureLocalhost` in TS).
    allow_insecure_r2_localhost: bool,
}

impl SiteClient {
    pub fn new(options: SiteClientOptions) -> Self {
        Self::build(options, false, false)
    }

    /// Loopback mock-server tests only: `https_only` would refuse the plain-http test server.
    /// Production code cannot reach this constructor.
    #[cfg(test)]
    pub fn new_for_loopback_tests(
        options: SiteClientOptions,
        allow_insecure_r2_localhost: bool,
    ) -> Self {
        Self::build(options, true, allow_insecure_r2_localhost)
    }

    fn build(
        options: SiteClientOptions,
        allow_loopback_http: bool,
        allow_insecure_r2_localhost: bool,
    ) -> Self {
        ensure_crypto_provider();

        let http = reqwest::Client::builder()
            // A redirect could carry the Bearer token to another host: never follow.
            .redirect(reqwest::redirect::Policy::none())
            .https_only(!allow_loopback_http)
            // Like the Electron app's Node fetch: no proxy from the environment.
            .no_proxy()
            .build()
            .map_err(|e| e.to_string());

        Self {
            http,
            options,
            allow_loopback_http,
            allow_insecure_r2_localhost,
        }
    }

    fn warn(&self, message: &str, meta: Value) {
        if let Some(logger) = &self.options.logger {
            logger.warn(message, Some(meta));
        }
    }

    fn debug(&self, message: &str, meta: Value) {
        if let Some(logger) = &self.options.logger {
            logger.debug(message, Some(meta));
        }
    }

    /// One HTTP exchange. Transport problems and redirects become `SiteApiError`s; any HTTP
    /// status is returned as is.
    async fn send(
        &self,
        method: Method,
        path: &str,
        auth: bool,
        body: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<RawResponse, SiteApiError> {
        self.send_typed(method, path, auth, body, "application/json")
            .await
    }

    /// `send` with an explicit request `Content-Type` (multipart uploads). The type is a
    /// value built by this crate, never user input.
    async fn send_typed(
        &self,
        method: Method,
        path: &str,
        auth: bool,
        body: Option<Zeroizing<Vec<u8>>>,
        content_type: &str,
    ) -> Result<RawResponse, SiteApiError> {
        let origin = request_origin(&(self.options.get_base_url)(), self.allow_loopback_http)
            .map_err(|message| SiteApiError::new(message).code("invalid_site_url"))?;
        let token = (self.options.get_token)();

        if auth && token.is_none() {
            return Err(SiteApiError::new("You are not signed in.")
                .status(401)
                .code("not_signed_in"));
        }

        let method_name = method.as_str().to_string();
        // The query string (e.g. a search text) is never logged.
        let log_path = path.split('?').next().unwrap_or(path);
        let network_error = |reason: String| {
            self.warn(
                "Site request failed.",
                json!({ "method": method_name, "path": log_path, "error": reason }),
            );

            SiteApiError::new("Could not reach the site. Check your internet connection.")
                .code("network")
                .network()
        };

        let http = match &self.http {
            Ok(http) => http,
            Err(reason) => return Err(network_error(reason.clone())),
        };

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

        if let Ok(agent) = HeaderValue::from_str(&self.options.user_agent) {
            headers.insert(USER_AGENT, agent);
        }

        if let (true, Some(token)) = (auth, &token) {
            let mut value = Zeroizing::new(Vec::with_capacity(7 + token.len()));
            value.extend_from_slice(b"Bearer ");
            value.extend_from_slice(token.expose().as_bytes());

            // A token with bytes that are not allowed in a header can never authenticate.
            let Some(header) = secret_header(value) else {
                return Err(SiteApiError::new("You are not signed in.")
                    .status(401)
                    .code("not_signed_in"));
            };
            headers.insert(AUTHORIZATION, header);
        }

        let mut request = http
            .request(method, format!("{origin}{path}"))
            .headers(headers);

        if let Some(body) = body {
            let Ok(content_type) = HeaderValue::from_str(content_type) else {
                return Err(
                    SiteApiError::new("Could not build the request.").code("invalid_request")
                );
            };

            request = request
                .header(CONTENT_TYPE, content_type)
                .body(Bytes::from_owner(body));
        }

        let exchange = async {
            let response = request
                .send()
                .await
                .map_err(|e| Failure::Send(e.to_string()))?;
            let status = response.status();

            if status.is_redirection() {
                return Ok((status, None, Zeroizing::new(Vec::new())));
            }

            let retry_after = parse_retry_after(response.headers().get("retry-after"));
            let body = read_limited(response).await.map_err(Failure::Read)?;

            Ok((status, retry_after, body))
        };

        let (status, retry_after_seconds, body) =
            match tokio::time::timeout(self.options.timeout, exchange).await {
                Err(_elapsed) => {
                    self.warn(
                        "Site request failed.",
                        json!({ "method": method_name, "path": log_path, "error": "timeout" }),
                    );

                    return Err(SiteApiError::new("The site did not respond in time.")
                        .code("timeout")
                        .network());
                }
                Ok(Err(Failure::Send(reason))) => return Err(network_error(reason)),
                Ok(Err(Failure::Read(_reason))) => {
                    return Err(
                        SiteApiError::new("The response from the site could not be read.")
                            .code("network")
                            .network(),
                    );
                }
                Ok(Ok(result)) => result,
            };

        if status.is_redirection() {
            self.warn(
                "Site answered with a redirect; refusing to follow.",
                json!({ "method": method_name, "path": log_path, "status": status.as_u16() }),
            );

            return Err(SiteApiError::new(
                "The site sent an unexpected redirect. Check the site URL.",
            )
            .status(status.as_u16())
            .code("unexpected_redirect")
            .network());
        }

        self.debug(
            "Site request done.",
            json!({ "method": method_name, "path": log_path, "status": status.as_u16() }),
        );

        if status == StatusCode::UNAUTHORIZED && auth && token.is_some() {
            let still_current = (self.options.get_token)() == token;

            if still_current {
                if let Some(on_unauthorized) = &self.options.on_unauthorized {
                    on_unauthorized();
                }
            }
        }

        Ok(RawResponse {
            status: status.as_u16(),
            body,
            retry_after_seconds,
        })
    }

    fn http_error(raw: &RawResponse, fallback: String) -> SiteApiError {
        SiteApiError {
            message: fallback,
            status: Some(raw.status),
            code: error_code_of(&raw.json()),
            retry_after_seconds: raw.retry_after_seconds,
            network: false,
        }
    }

    pub async fn login(
        &self,
        username: &str,
        password: &Secret,
        device_name: &str,
    ) -> Result<LoginResult, SiteApiError> {
        let request = LoginRequest {
            username,
            password: password.expose(),
            device_name,
        };
        // Worst case every char is escaped as \uXXXX: reserve enough so the buffer never grows
        // (a reallocation would leave an unwiped copy of the password behind).
        let capacity = 64 + 6 * (username.len() + password.len() + device_name.len());
        let mut body = Zeroizing::new(Vec::with_capacity(capacity));

        serde_json::to_writer(&mut *body, &request)
            .map_err(|_| SiteApiError::new("Sign-in failed."))?;

        let raw = self
            .send(Method::POST, "/api/app/login", false, Some(body))
            .await?;

        if raw.status != 200 {
            return Err(Self::http_error(
                &raw,
                format!("Sign-in failed (HTTP {}).", raw.status),
            ));
        }

        let invalid = || {
            SiteApiError::new("The site sent an unexpected sign-in response.")
                .status(raw.status)
                .code("invalid_response")
        };
        let parsed: LoginBody = serde_json::from_slice(&raw.body).map_err(|_| invalid())?;

        match (parsed.token, parsed.user.and_then(|u| u.username)) {
            (Some(token), Some(username)) if !token.is_empty() && !username.is_empty() => {
                Ok(LoginResult { token, username })
            }
            _ => Err(invalid()),
        }
    }

    pub async fn logout(&self) -> Result<(), SiteApiError> {
        let raw = self
            .send(Method::POST, "/api/app/logout", true, None)
            .await?;

        if raw.status != 204 && raw.status != 200 {
            return Err(Self::http_error(
                &raw,
                format!("Sign-out failed (HTTP {}).", raw.status),
            ));
        }

        Ok(())
    }

    pub async fn get_config(&self) -> Result<AppConfig, SiteApiError> {
        let raw = self
            .send(Method::GET, "/api/app/config", true, None)
            .await?;

        if raw.status != 200 {
            return Err(Self::http_error(
                &raw,
                format!(
                    "Could not load the site configuration (HTTP {}).",
                    raw.status
                ),
            ));
        }

        let Some(config) = parse_app_config(raw.json()) else {
            return Err(SiteApiError::new("The site sent an invalid configuration.")
                .status(raw.status)
                .code("invalid_response"));
        };

        if let Some(problem) = r2_location_problem(&config.r2, self.allow_insecure_r2_localhost) {
            self.warn("Refusing the site config.", json!({ "problem": problem }));

            return Err(SiteApiError::new(problem)
                .status(raw.status)
                .code("invalid_r2_location"));
        }

        Ok(config)
    }

    /// `GET /api/app/r2`: the site's R2 settings without the key or the secret.
    pub async fn get_r2(&self) -> Result<R2Status, SiteApiError> {
        let raw = self.send(Method::GET, "/api/app/r2", true, None).await?;

        Self::r2_status_check(&raw, "Could not load the R2 settings")?;

        parse_r2_status(&raw.json()).ok_or_else(|| Self::r2_invalid(&raw))
    }

    /// `PUT /api/app/r2`. The key and the secret are only sent when given (`None` = keep the
    /// stored value). The request body is a wiped buffer and is never logged; a 422 becomes
    /// per-field messages that cannot contain the submitted values.
    pub async fn set_r2(&self, input: &R2Input) -> Result<R2Status, R2SaveError> {
        #[derive(Serialize)]
        struct Body<'a> {
            endpoint: &'a str,
            bucket: &'a str,
            url: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            access_key_id: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            secret_access_key: Option<&'a str>,
        }

        let key = input.access_key_id.as_ref().map(Secret::expose);
        let secret = input.secret_access_key.as_ref().map(Secret::expose);
        let body = Body {
            endpoint: &input.endpoint,
            bucket: &input.bucket,
            url: &input.url,
            access_key_id: key,
            secret_access_key: secret,
        };
        // Worst case every char is escaped as \uXXXX: reserve enough so the buffer never grows
        // (a reallocation would leave an unwiped copy of the secret behind).
        let text_len = input.endpoint.len()
            + input.bucket.len()
            + input.url.len()
            + key.map_or(0, str::len)
            + secret.map_or(0, str::len);
        let mut bytes = Zeroizing::new(Vec::with_capacity(256 + 6 * text_len));

        serde_json::to_writer(&mut *bytes, &body)
            .map_err(|_| SiteApiError::new("Could not save the R2 settings."))?;

        let raw = self
            .send(Method::PUT, "/api/app/r2", true, Some(bytes))
            .await?;

        if raw.status == 422 {
            let submitted: Vec<&str> = key.into_iter().chain(secret).collect();
            let field_errors = parse_field_errors(&raw.json(), &submitted);
            let message = if field_errors.is_empty() {
                "The site rejected the R2 settings."
            } else {
                "Please fix the highlighted fields."
            };

            return Err(R2SaveError {
                error: Self::http_error(&raw, message.to_string()),
                field_errors,
            });
        }

        Self::r2_status_check(&raw, "Could not save the R2 settings")?;

        Ok(parse_r2_status(&raw.json()).ok_or_else(|| Self::r2_invalid(&raw))?)
    }

    /// `POST /api/app/r2/test`: tests the SAVED settings. A failed test is an `Ok` outcome with
    /// `ok: false` and the site's (sanitized, capped) reason; only transport/HTTP problems are
    /// errors.
    pub async fn test_r2(&self) -> Result<R2TestOutcome, SiteApiError> {
        let raw = self
            .send(Method::POST, "/api/app/r2/test", true, None)
            .await?;

        Self::r2_status_check(&raw, "Could not test the R2 connection")?;

        parse_r2_test(&raw.json()).ok_or_else(|| Self::r2_invalid(&raw))
    }

    fn r2_invalid(raw: &RawResponse) -> SiteApiError {
        SiteApiError::new("The site sent an unexpected R2 response.")
            .status(raw.status)
            .code("invalid_response")
    }

    /// Non-200 answers of the R2 calls: 403 (not an admin) and 404 (older site) have their own
    /// messages; the rest follows `video_status_check`.
    fn r2_status_check(raw: &RawResponse, failure: &str) -> Result<(), SiteApiError> {
        match raw.status {
            403 => Err(Self::http_error(
                raw,
                "Only site administrators can manage the R2 settings.".to_string(),
            )),
            _ => Self::video_status_check(
                raw,
                failure,
                "This site does not support R2 settings yet. Update the site.",
            ),
        }
    }

    /// `GET /api/app/videos?page=&per_page=&q=&sort=` (one page of the cloud library). The search
    /// text is URL-encoded and never logged; the answer is parsed, size-capped and sanitized.
    /// `per_page` must be within `1..=MAX_VIDEOS_PER_PAGE` (the site's contract): anything else is
    /// a caller bug and fails with `invalid_per_page` before any request is sent (no clamping).
    pub async fn list_videos(
        &self,
        page: u32,
        per_page: u32,
        query: Option<&str>,
        sort: VideoSort,
        status: Option<&str>,
    ) -> Result<VideoPage, SiteApiError> {
        if !(1..=MAX_VIDEOS_PER_PAGE).contains(&per_page) {
            return Err(SiteApiError::new(format!(
                "The video list page size must be between 1 and {MAX_VIDEOS_PER_PAGE}."
            ))
            .code("invalid_per_page"));
        }

        let path = videos_list_path(page, per_page, query, sort, status);
        let raw = self.send(Method::GET, &path, true, None).await?;

        Self::video_status_check(
            &raw,
            "Could not load the videos",
            "Could not load the videos.",
        )?;

        let mut parsed: VideoPage = serde_json::from_slice(&raw.body).map_err(|_| {
            SiteApiError::new("The site sent an unexpected video list.")
                .status(raw.status)
                .code("invalid_response")
        })?;

        if parsed.data.len() > MAX_LIST_ITEMS {
            return Err(SiteApiError::new("The site sent an unexpected video list.")
                .status(raw.status)
                .code("invalid_response"));
        }

        parsed.sanitize();

        Ok(parsed)
    }

    /// `GET /api/app/overview`: video counts (tolerant parsing, see
    /// `Overview::parse`).
    pub async fn get_overview(&self) -> Result<Overview, SiteApiError> {
        let raw = self
            .send(Method::GET, "/api/app/overview", true, None)
            .await?;

        Self::video_status_check(
            &raw,
            "Could not load the overview",
            "Could not load the overview.",
        )?;

        Overview::parse(&raw.json()).ok_or_else(|| {
            SiteApiError::new("The site sent an unexpected overview.")
                .status(raw.status)
                .code("invalid_response")
        })
    }

    /// `GET /api/app/logs`. Without `log_type` the summary shape is returned (`page` and
    /// `per_page` are not sent); with it, one paginated page. A body of the other shape is an
    /// invalid response.
    pub async fn get_logs(
        &self,
        log_type: Option<LogType>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<LogsReply, SiteApiError> {
        let path = logs_path(log_type, page, per_page);
        let raw = self.send(Method::GET, &path, true, None).await?;

        Self::video_status_check(&raw, "Could not load the logs", "Could not load the logs.")?;

        let invalid = || {
            SiteApiError::new("The site sent an unexpected logs response.")
                .status(raw.status)
                .code("invalid_response")
        };

        if log_type.is_some() {
            let mut parsed: LogsPage = serde_json::from_slice(&raw.body).map_err(|_| invalid())?;

            if !parsed.within_limits() {
                return Err(invalid());
            }

            parsed.sanitize();

            Ok(LogsReply::Page(parsed))
        } else {
            let mut parsed: LogsSummary =
                serde_json::from_slice(&raw.body).map_err(|_| invalid())?;

            if !parsed.within_limits() {
                return Err(invalid());
            }

            parsed.sanitize();

            Ok(LogsReply::Summary(parsed))
        }
    }

    /// `GET /api/app/videos/{id}`. `id` is a positive integer (validated by the caller).
    pub async fn get_video(&self, id: i64) -> Result<VideoDetail, SiteApiError> {
        let path = format!("/api/app/videos/{id}");
        let raw = self.send(Method::GET, &path, true, None).await?;

        Self::video_status_check(&raw, "Could not load the video", "Video not found.")?;

        let mut parsed: VideoDetail = serde_json::from_slice(&raw.body).map_err(|_| {
            SiteApiError::new("The site sent an unexpected video response.")
                .status(raw.status)
                .code("invalid_response")
        })?;

        parsed.sanitize();

        Ok(parsed)
    }

    /// `PUT /api/app/videos/{id}` with `{"title"}`; returns the updated detail. The title is
    /// trimmed and checked first (no request when it is invalid). The body is never logged.
    pub async fn update_video_title(
        &self,
        id: i64,
        title: &str,
    ) -> Result<VideoDetail, SiteApiError> {
        let title = normalize_video_title(title)
            .map_err(|message| SiteApiError::new(message).code("invalid_title"))?;
        let body = serde_json::to_vec(&json!({ "title": title }))
            .map_err(|_| SiteApiError::new("Could not rename the video."))?;
        let path = format!("/api/app/videos/{id}");
        let raw = self
            .send(Method::PUT, &path, true, Some(Zeroizing::new(body)))
            .await?;

        Self::video_write_check(
            &raw,
            "Could not rename the video",
            "Video not found.",
            Some(TITLE_INVALID),
        )?;

        let mut parsed: VideoDetail = serde_json::from_slice(&raw.body).map_err(|_| {
            SiteApiError::new("The site sent an unexpected video response.")
                .status(raw.status)
                .code("invalid_response")
        })?;

        parsed.sanitize();

        Ok(parsed)
    }

    /// `DELETE /api/app/videos/{id}`. The outcome (`deleted|skipped|failed`) is in the body of
    /// an HTTP 200; the server message is sanitized and length-capped.
    pub async fn delete_video(&self, id: i64) -> Result<VideoDeleteOutcome, SiteApiError> {
        let path = format!("/api/app/videos/{id}");
        let raw = self.send(Method::DELETE, &path, true, None).await?;

        Self::video_write_check(&raw, "Could not delete the video", "Video not found.", None)?;

        VideoDeleteOutcome::parse(&raw.json()).ok_or_else(|| {
            SiteApiError::new("The site sent an unexpected delete response.")
                .status(raw.status)
                .code("invalid_response")
        })
    }

    /// `POST /api/app/videos/{id}/image` (multipart field `image`). `bytes` were already checked
    /// (size, sniffed `kind`) by the caller; the file name and content type sent are built from
    /// `kind`. Returns the new custom image URL, kept only when it is `https://`.
    pub async fn set_video_image(
        &self,
        id: i64,
        bytes: &[u8],
        kind: ImageKind,
    ) -> Result<Option<String>, SiteApiError> {
        let (body, content_type) = build_multipart(kind, bytes).ok_or_else(|| {
            SiteApiError::new("Could not save the image.").code("invalid_request")
        })?;
        let path = format!("/api/app/videos/{id}/image");
        let raw = self
            .send_typed(
                Method::POST,
                &path,
                true,
                Some(Zeroizing::new(body)),
                &content_type,
            )
            .await?;

        match raw.status {
            200 => {}
            422 if error_code_of(&raw.json()).as_deref() == Some("no_storage_folder") => {
                return Err(Self::http_error(
                    &raw,
                    "This video has no storage folder yet.".to_string(),
                ));
            }
            413 | 422 => {
                return Err(Self::http_error(&raw, IMAGE_REJECTED.to_string()));
            }
            500 => {
                return Err(Self::http_error(
                    &raw,
                    "Could not save the image.".to_string(),
                ))
            }
            _ => Self::video_status_check(&raw, "Could not save the image", "Video not found.")?,
        }

        let mut url = raw
            .json()
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string);

        clean_url(&mut url);

        Ok(url)
    }

    /// `DELETE /api/app/videos/{id}/image`. A 404 `no_custom_image` has its own message and
    /// code so the UI can tell it apart from an unknown video.
    pub async fn delete_video_image(&self, id: i64) -> Result<(), SiteApiError> {
        let path = format!("/api/app/videos/{id}/image");
        let raw = self.send(Method::DELETE, &path, true, None).await?;

        match raw.status {
            200 => Ok(()),
            404 if error_code_of(&raw.json()).as_deref() == Some("no_custom_image") => Err(
                Self::http_error(&raw, "No custom thumbnail to remove.".to_string()),
            ),
            500 => Err(Self::http_error(
                &raw,
                "Could not remove the image.".to_string(),
            )),
            _ => Self::video_status_check(&raw, "Could not remove the image", "Video not found."),
        }
    }

    /// `DELETE /api/app/videos/bulk-destroy` with `{"selected_ids": [...]}`. Ids are de-duplicated
    /// (order kept); 1..=100 distinct positive ids are required, else nothing is sent.
    pub async fn bulk_delete_videos(&self, ids: &[i64]) -> Result<BulkDeleteOutcome, SiteApiError> {
        let mut unique: Vec<i64> = Vec::with_capacity(ids.len());

        for id in ids {
            if !unique.contains(id) {
                unique.push(*id);
            }
        }

        if unique.is_empty() || unique.len() > MAX_BULK_DELETE || unique.iter().any(|id| *id < 1) {
            return Err(
                SiteApiError::new("Select between 1 and 100 videos.").code("invalid_selection")
            );
        }

        let body = serde_json::to_vec(&json!({ "selected_ids": unique }))
            .map_err(|_| SiteApiError::new("Could not delete the videos."))?;
        let raw = self
            .send(
                Method::DELETE,
                "/api/app/videos/bulk-destroy",
                true,
                Some(Zeroizing::new(body)),
            )
            .await?;

        Self::video_write_check(
            &raw,
            "Could not delete the videos",
            "Video not found.",
            Some("Some of the selected videos no longer exist. Refresh the list and try again."),
        )?;

        BulkDeleteOutcome::parse(&raw.json()).ok_or_else(|| {
            SiteApiError::new("The site sent an unexpected delete response.")
                .status(raw.status)
                .code("invalid_response")
        })
    }

    /// Like `video_status_check`, plus a fixed message for 422 (validation), when given.
    fn video_write_check(
        raw: &RawResponse,
        failure: &str,
        not_found: &str,
        invalid: Option<&str>,
    ) -> Result<(), SiteApiError> {
        match (raw.status, invalid) {
            (422, Some(message)) => Err(Self::http_error(raw, message.to_string())),
            _ => Self::video_status_check(raw, failure, not_found),
        }
    }

    /// Non-200 answers of the video read calls become safe, body-free messages.
    fn video_status_check(
        raw: &RawResponse,
        failure: &str,
        not_found: &str,
    ) -> Result<(), SiteApiError> {
        let message = match raw.status {
            200 => return Ok(()),
            401 => "Your session has expired. Please sign in again.".to_string(),
            404 => not_found.to_string(),
            429 => "Too many requests. Please try again in a moment.".to_string(),
            status => format!("{failure} (HTTP {status})."),
        };

        Err(Self::http_error(raw, message))
    }

    /// `POST /api/app/videos`. Any failure is a `RegisterRequestError`; the request body and
    /// the token are never logged.
    pub async fn register(
        &self,
        payload: &RegisterPayload,
    ) -> Result<RegisteredVideo, RegisterRequestError> {
        let body = serde_json::to_vec(payload)
            .map_err(|_| RegisterRequestError::new(RegisterFailure::Network))?;
        let raw = self
            .send(
                Method::POST,
                "/api/app/videos",
                true,
                Some(Zeroizing::new(body)),
            )
            .await
            .map_err(|error| RegisterRequestError::new(register_failure_of(&error)))?;

        if raw.status == 200 || raw.status == 201 {
            // A 2xx without a usable body: the API is idempotent, so retrying is safe.
            return parse_registered(&raw.json()).ok_or_else(|| {
                RegisterRequestError::with_message(
                    RegisterFailure::Network,
                    "invalid register response",
                )
            });
        }

        Err(RegisterRequestError::new(RegisterFailure::Http {
            status: raw.status,
            error_code: error_code_of(&raw.json()),
            retry_after_seconds: raw.retry_after_seconds.map(|s| s as f64),
        }))
    }
}

#[async_trait::async_trait]
impl RegisterClient for SiteClient {
    async fn register(
        &self,
        payload: &RegisterPayload,
    ) -> Result<RegisteredVideo, RegisterRequestError> {
        SiteClient::register(self, payload).await
    }
}

/// `/api/app/logs` (summary) or `/api/app/logs?type=&page=&per_page=`.
fn logs_path(log_type: Option<LogType>, page: Option<u32>, per_page: Option<u32>) -> String {
    let Some(log_type) = log_type else {
        return "/api/app/logs".to_string();
    };
    let mut params = url::form_urlencoded::Serializer::new(String::new());

    params.append_pair("type", log_type.as_str());

    if let Some(page) = page {
        params.append_pair("page", &page.to_string());
    }

    if let Some(per_page) = per_page {
        params.append_pair("per_page", &per_page.to_string());
    }

    format!("/api/app/logs?{}", params.finish())
}

/// `/api/app/videos?page=&per_page=[&q=]`; the search text is trimmed and form-encoded.
fn videos_list_path(
    page: u32,
    per_page: u32,
    query: Option<&str>,
    sort: VideoSort,
    status: Option<&str>,
) -> String {
    let mut params = url::form_urlencoded::Serializer::new(String::new());

    params.append_pair("page", &page.to_string());
    params.append_pair("per_page", &per_page.to_string());

    if let Some(text) = query.map(str::trim).filter(|text| !text.is_empty()) {
        params.append_pair("q", text);
    }

    // The default order is not sent, so an older site that has no `sort` keeps working.
    if sort != VideoSort::Newest {
        params.append_pair("sort", sort.as_param());
    }

    // Only sent when a filter is chosen: a site that does not know `status` is never asked.
    if let Some(status) = status {
        params.append_pair("status", status);
    }

    format!("/api/app/videos?{}", params.finish())
}

/// A site error that carries a 401 `not_signed_in` becomes an HTTP failure; everything else is
/// "network" (no usable answer).
fn register_failure_of(error: &SiteApiError) -> RegisterFailure {
    if error.status == Some(401) && error.has_code("not_signed_in") {
        return RegisterFailure::Http {
            status: 401,
            error_code: error.code.clone(),
            retry_after_seconds: None,
        };
    }

    RegisterFailure::Network
}

/// `{ id: integer, public_id: non-empty string, embed_url: non-empty string }`.
fn parse_registered(body: &Value) -> Option<RegisteredVideo> {
    let id = body.get("id")?.as_f64()?;
    let public_id = body.get("public_id")?.as_str()?;
    let embed_url = body.get("embed_url")?.as_str()?;

    if id.fract() != 0.0 || !id.is_finite() || id.abs() > 9_007_199_254_740_991.0 {
        return None;
    }

    if public_id.is_empty() || embed_url.is_empty() {
        return None;
    }

    Some(RegisteredVideo {
        id: id as i64,
        public_id: public_id.to_string(),
        embed_url: embed_url.to_string(),
    })
}

/// Reads the body chunk by chunk and stops (dropping the connection) as soon as more than
/// `MAX_BODY_BYTES` arrived, so a huge or endless response is never buffered.
async fn read_limited(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>, String> {
    let expected = response
        .content_length()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(4096)
        .min(MAX_BODY_BYTES);
    let mut body = Zeroizing::new(Vec::with_capacity(expected));

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("response too large".into());
        }

        push_wiped(&mut body, &chunk);
    }

    Ok(body)
}

#[async_trait::async_trait]
impl crate::auth::AuthClient for SiteClient {
    async fn login(
        &self,
        username: &str,
        password: &Secret,
        device_name: &str,
    ) -> Result<LoginResult, SiteApiError> {
        SiteClient::login(self, username, password, device_name).await
    }

    async fn logout(&self) -> Result<(), SiteApiError> {
        SiteClient::logout(self).await
    }
}

#[async_trait::async_trait]
impl crate::config::ConfigFetcher for SiteClient {
    async fn get_config(&self) -> Result<AppConfig, SiteApiError> {
        SiteClient::get_config(self).await
    }
}

#[cfg(test)]
#[path = "site_client_tests.rs"]
mod tests;
