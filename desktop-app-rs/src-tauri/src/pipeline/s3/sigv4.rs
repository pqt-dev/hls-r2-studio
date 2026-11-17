//! AWS Signature Version 4 for S3 requests (header based, `AWS4-HMAC-SHA256`), on `ring` (the
//! crypto provider the app already links for rustls; no extra crypto crate).
//!
//! Checked against the published S3 SigV4 examples (GET object, PUT object, GET bucket
//! lifecycle, list objects) of the AWS documentation, which use AWS's documented example
//! credentials (not real ones).

use ring::{digest, hmac};
use zeroize::Zeroizing;

pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";
/// `x-amz-content-sha256` of a streamed body (the TLS layer protects its integrity; R2 accepts
/// it, and nothing has to read the file twice).
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

pub fn sha256_hex(data: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, data).as_ref())
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);

    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }

    out
}

/// RFC 3986 encoding of S3: everything but `A-Z a-z 0-9 - _ . ~` is `%XX` (upper case).
/// `keep_slash` keeps `/` (object key paths); query names and values encode it.
pub fn uri_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());

    for byte in text.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');

        if unreserved || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }

    out
}

/// Canonical (and on-the-wire) query string: names and values encoded, sorted by name then
/// value, `name=value` joined with `&` (an empty value keeps the `=`).
pub fn canonical_query(params: &[(&str, &str)]) -> String {
    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(name, value)| (uri_encode(name, false), uri_encode(value, false)))
        .collect();

    encoded.sort();
    encoded
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

pub struct SigningInput<'a> {
    pub method: &'a str,
    /// Already encoded path (`/bucket/key`), sent as is.
    pub canonical_uri: &'a str,
    /// Output of [`canonical_query`], sent as is.
    pub canonical_query: &'a str,
    /// Every signed header as (name, value); names are lower-cased and sorted here.
    pub headers: &'a [(&'a str, &'a str)],
    /// `x-amz-content-sha256` value.
    pub payload_hash: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    /// `YYYYMMDDTHHMMSSZ`.
    pub amz_date: &'a str,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
}

fn hmac_sha256(key: &[u8], data: &str) -> hmac::Tag {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
}

fn canonical_headers(headers: &[(&str, &str)]) -> (String, String) {
    let mut sorted: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| {
            // Trim and collapse inner runs of spaces (the SigV4 rule).
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");

            (name.to_ascii_lowercase(), value)
        })
        .collect();

    sorted.sort();

    let canonical = sorted
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();
    let signed = sorted
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");

    (canonical, signed)
}

/// The `Authorization` header value.
pub fn authorization(input: &SigningInput<'_>) -> String {
    let (canonical_headers, signed_headers) = canonical_headers(input.headers);
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        input.method,
        input.canonical_uri,
        input.canonical_query,
        canonical_headers,
        signed_headers,
        input.payload_hash
    );
    let date = input.amz_date.get(..8).unwrap_or(input.amz_date);
    let scope = format!("{date}/{}/{}/aws4_request", input.region, input.service);
    let string_to_sign = format!(
        "{ALGORITHM}\n{}\n{scope}\n{}",
        input.amz_date,
        sha256_hex(canonical_request.as_bytes())
    );

    let mut secret = Zeroizing::new(String::with_capacity(4 + input.secret_access_key.len()));

    secret.push_str("AWS4");
    secret.push_str(input.secret_access_key);

    let k_date = hmac_sha256(secret.as_bytes(), date);
    let k_region = hmac_sha256(k_date.as_ref(), input.region);
    let k_service = hmac_sha256(k_region.as_ref(), input.service);
    let k_signing = hmac_sha256(k_service.as_ref(), "aws4_request");
    let signature = hex(hmac_sha256(k_signing.as_ref(), &string_to_sign).as_ref());

    format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        input.access_key_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // AWS documentation example credentials (public placeholders, not real keys).
    const ACCESS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
    const SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const DATE: &str = "20130524T000000Z";
    const HOST: &str = "examplebucket.s3.amazonaws.com";
    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn signature_of(header: &str) -> &str {
        header.rsplit("Signature=").next().unwrap()
    }

    fn sign(method: &str, uri: &str, query: &str, headers: &[(&str, &str)], hash: &str) -> String {
        authorization(&SigningInput {
            method,
            canonical_uri: uri,
            canonical_query: query,
            headers,
            payload_hash: hash,
            region: "us-east-1",
            service: "s3",
            amz_date: DATE,
            access_key_id: ACCESS_KEY,
            secret_access_key: SECRET_KEY,
        })
    }

    #[test]
    fn hashes_and_hex() {
        assert_eq!(sha256_hex(b""), EMPTY);
        assert_eq!(
            sha256_hex(b"Welcome to Amazon S3."),
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn aws_example_get_object() {
        let header = sign(
            "GET",
            "/test.txt",
            "",
            &[
                ("Host", HOST),
                ("Range", "bytes=0-9"),
                ("x-amz-content-sha256", EMPTY),
                ("x-amz-date", DATE),
            ],
            EMPTY,
        );

        assert_eq!(
            header,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn aws_example_put_object() {
        let hash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        let header = sign(
            "PUT",
            &format!("/{}", uri_encode("test$file.text", true)),
            "",
            &[
                ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
                ("Host", HOST),
                ("x-amz-content-sha256", hash),
                ("x-amz-date", DATE),
                ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
            ],
            hash,
        );

        assert_eq!(
            signature_of(&header),
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn aws_example_get_bucket_lifecycle_and_list_objects() {
        let headers = [
            ("host", HOST),
            ("x-amz-content-sha256", EMPTY),
            ("x-amz-date", DATE),
        ];

        assert_eq!(
            signature_of(&sign(
                "GET",
                "/",
                &canonical_query(&[("lifecycle", "")]),
                &headers,
                EMPTY
            )),
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
        assert_eq!(
            signature_of(&sign(
                "GET",
                "/",
                &canonical_query(&[("prefix", "J"), ("max-keys", "2")]),
                &headers,
                EMPTY
            )),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    #[test]
    fn encodes_like_s3() {
        assert_eq!(uri_encode("a b/c~d_e.f-g", true), "a%20b/c~d_e.f-g");
        assert_eq!(
            uri_encode("2026/03/05/x-ab/", false),
            "2026%2F03%2F05%2Fx-ab%2F"
        );
        assert_eq!(uri_encode("Tiếng", false), "Ti%E1%BA%BFng");
        assert_eq!(uri_encode("a+b=c&d", false), "a%2Bb%3Dc%26d");
        assert_eq!(
            canonical_query(&[("prefix", "a/b"), ("list-type", "2"), ("delete", "")]),
            "delete=&list-type=2&prefix=a%2Fb"
        );
    }

    #[test]
    fn collapses_header_whitespace() {
        let a = sign(
            "GET",
            "/",
            "",
            &[("host", HOST), ("x-a", "  1   2 ")],
            EMPTY,
        );
        let b = sign("GET", "/", "", &[("host", HOST), ("x-a", "1 2")], EMPTY);

        assert_eq!(a, b);
    }
}
