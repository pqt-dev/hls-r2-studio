//! `SiteApiError`: failure of a site API call (port of the class in siteClient.ts).

use std::fmt;

use serde_json::{json, Value};

/// Messages are safe English text and never contain a token, a password or a response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteApiError {
    pub message: String,
    /// HTTP status, or `None` when no response was received.
    pub status: Option<u16>,
    /// `error` field of the JSON body (e.g. `r2_not_configured`), or a client-side code
    /// (`network`, `timeout`, `unexpected_redirect`, `invalid_response`, `invalid_site_url`,
    /// `invalid_r2_location`, `not_signed_in`).
    pub code: Option<String>,
    pub retry_after_seconds: Option<u64>,
    /// True when there was no usable HTTP answer (offline, DNS, timeout, redirect, TLS...).
    pub network: bool,
}

impl SiteApiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            code: None,
            retry_after_seconds: None,
            network: false,
        }
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn retry_after(mut self, seconds: Option<u64>) -> Self {
        self.retry_after_seconds = seconds;
        self
    }

    pub fn network(mut self) -> Self {
        self.network = true;
        self
    }

    pub fn has_code(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }

    /// Loggable form (`{ name, message, status, code, network }`); no secrets by construction.
    pub fn to_log_value(&self) -> Value {
        json!({
            "name": "SiteApiError",
            "message": self.message,
            "status": self.status,
            "code": self.code,
            "network": self.network,
        })
    }
}

impl fmt::Display for SiteApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SiteApiError {}
