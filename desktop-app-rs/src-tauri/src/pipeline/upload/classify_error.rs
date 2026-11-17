//! Splits upload failures into "the network is the problem" (worth waiting for) and everything
//! else. Port of upload/classifyError.ts over the typed [`StoreError`].
//!
//! The TS walks untyped JS errors (`code`, `name`, `$metadata.httpStatusCode`, `cause` chains,
//! `AggregateError`). In Rust the R2 client already maps every failure to one variant
//! (`Network` for any transport problem: reset, refused, DNS, timeout, socket inactivity), so
//! the rules reduce to the variant plus the HTTP status / S3 error code.

use tokio_util::sync::CancellationToken;

use crate::pipeline::deps::StoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadErrorClass {
    Network,
    Other,
}

/// Transport / throttling S3 error codes (the SDK uses them as the error name).
pub const NETWORK_NAMES: [&str; 6] = [
    "TimeoutError",
    "NetworkingError",
    "RequestTimeout",
    "SlowDown",
    "ServiceUnavailable",
    "InternalError",
];

pub const NETWORK_STATUSES: [u16; 6] = [408, 429, 500, 502, 503, 504];

/// `Network`: transport failures and the HTTP answers 408/429/500/502/503/504 (or, when the
/// status alone does not decide, their S3 error codes). `Other`: anything else (403,
/// NoSuchBucket, 400, local file errors, ...). A `Cancelled` error only counts as a network
/// failure when it is not ours: pass the job's token so our own cancellation is never mistaken
/// for a timeout (the R2 client reports its own timeouts as `Network`).
pub fn classify_upload_error(
    error: &StoreError,
    cancel: Option<&CancellationToken>,
) -> UploadErrorClass {
    let network = match error {
        StoreError::Network(_) => true,
        StoreError::Http { status, code } => {
            // The server answered: the status alone decides (a 403 is a 403).
            if NETWORK_STATUSES.contains(status) {
                true
            } else if *status >= 400 {
                false
            } else {
                code.as_deref().is_some_and(|c| NETWORK_NAMES.contains(&c))
            }
        }
        StoreError::Local(_) => false,
        StoreError::Cancelled => !cancel.is_some_and(CancellationToken::is_cancelled),
    };

    if network {
        UploadErrorClass::Network
    } else {
        UploadErrorClass::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use UploadErrorClass::{Network, Other};

    fn http(status: u16, code: Option<&str>) -> StoreError {
        StoreError::Http {
            status,
            code: code.map(str::to_string),
        }
    }

    #[test]
    fn transport_failures_are_network_errors() {
        // The TS code table (ECONNRESET, ETIMEDOUT, ENOTFOUND, UND_ERR_*...) all end up here.
        for message in [
            "connection reset",
            "connect timed out",
            "dns error",
            "socket inactivity",
        ] {
            assert_eq!(
                classify_upload_error(&StoreError::Network(message.into()), None),
                Network
            );
        }
    }

    #[test]
    fn network_statuses_are_network_errors() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert_eq!(
                classify_upload_error(&http(status, None), None),
                Network,
                "{status}"
            );
        }
    }

    #[test]
    fn other_statuses_are_other_errors() {
        for status in [400, 401, 403, 404, 409, 412, 501] {
            assert_eq!(
                classify_upload_error(&http(status, None), None),
                Other,
                "{status}"
            );
        }
    }

    #[test]
    fn s3_codes_count_only_when_the_status_does_not_decide() {
        for name in NETWORK_NAMES {
            assert_eq!(classify_upload_error(&http(301, Some(name)), None), Network);
            // RequestTimeout is a 400 on S3: the status decides, like the TS.
            assert_eq!(classify_upload_error(&http(400, Some(name)), None), Other);
        }

        for name in [
            "NoSuchBucket",
            "AccessDenied",
            "InvalidAccessKeyId",
            "SignatureDoesNotMatch",
        ] {
            assert_eq!(classify_upload_error(&http(403, Some(name)), None), Other);
            assert_eq!(classify_upload_error(&http(301, Some(name)), None), Other);
        }

        assert_eq!(
            classify_upload_error(&http(503, Some("AccessDenied")), None),
            Network
        );
    }

    #[test]
    fn local_errors_are_other_errors() {
        for message in ["ENOENT", "EACCES", "EMFILE", "bad input"] {
            assert_eq!(
                classify_upload_error(&StoreError::Local(message.into()), None),
                Other
            );
        }
    }

    #[test]
    fn a_cancel_is_a_network_error_only_when_it_is_not_ours() {
        let token = CancellationToken::new();

        assert_eq!(classify_upload_error(&StoreError::Cancelled, None), Network);
        assert_eq!(
            classify_upload_error(&StoreError::Cancelled, Some(&token)),
            Network
        );

        token.cancel();

        assert_eq!(
            classify_upload_error(&StoreError::Cancelled, Some(&token)),
            Other
        );
    }
}
