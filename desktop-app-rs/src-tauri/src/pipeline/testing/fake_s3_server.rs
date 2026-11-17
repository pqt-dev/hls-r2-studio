//! In-process S3 look-alike on 127.0.0.1 (port of testing/fakeS3Server.ts): path-style
//! PutObject, HeadObject, ListObjectsV2 (with max-keys / continuation-token paging) and
//! DeleteObjects. It also VERIFIES the SigV4 signature of every request against the bytes it
//! received (path and query as sent on the wire), and the `Content-MD5` of DeleteObjects, so a
//! client whose wire format drifts from what it signs fails loudly. One request per connection.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use crate::pipeline::s3::sigv4::{authorization, SigningInput};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestType {
    Put,
    Head,
    List,
    Delete,
    Other,
}

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    /// Raw request target as received (`/bucket/key?query`).
    pub target: String,
    /// Object key for object requests, `""` for bucket-level requests.
    pub key: String,
    pub kind: RequestType,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub bytes: usize,
    /// None: not checked (the request was failed/destroyed before), Some(ok).
    pub signature_ok: Option<bool>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();

        self.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// What to do with a request instead of handling it.
pub enum Fail {
    /// Answer with this status and an S3 XML error body with this code.
    Status(u16, &'static str),
    /// Drop the connection without any answer (a network failure).
    Destroy,
    /// Read only the head, never read the body nor answer (a stalled connection).
    Stall,
    /// Read the body slowly (`chunk` bytes every `every`), then handle it normally.
    SlowRead { chunk: usize, every: Duration },
    /// Answer a redirect to another host.
    Redirect,
}

pub type FailWhen = Box<dyn Fn(&RecordedRequest, usize) -> Option<Fail> + Send + Sync>;

pub struct FakeS3ServerOptions {
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub fail_when: Option<FailWhen>,
    /// Keys whose deletion is reported as failed in the `DeleteResult`.
    pub undeletable: Vec<String>,
    /// SO_RCVBUF of the accepted sockets (small = the client feels back-pressure sooner).
    pub recv_buffer: Option<u32>,
    /// `Date` header sent with every answer (the server clock).
    pub date: Option<String>,
}

struct Shared {
    options: FakeS3ServerOptions,
    requests: Mutex<Vec<RecordedRequest>>,
    objects: Mutex<BTreeMap<String, Vec<u8>>>,
    serial: Mutex<usize>,
    stalled: Mutex<Vec<TcpStream>>,
}

pub struct FakeS3Server {
    pub endpoint: String,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

impl Drop for FakeS3Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn decode_percent(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(value) = text
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(value);
                i += 3;
                continue;
            }
        }

        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn md5_base64(data: &[u8]) -> String {
    use md5::{Digest, Md5};

    // Independent of the client's encoder: a straightforward base64.
    let digest = Md5::digest(data);
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = String::new();

    for byte in digest.iter() {
        bits.push_str(&format!("{byte:08b}"));
    }

    while bits.len() % 6 != 0 {
        bits.push('0');
    }

    let mut out: String = bits
        .as_bytes()
        .chunks(6)
        .map(|six| {
            let index = usize::from_str_radix(std::str::from_utf8(six).unwrap(), 2).unwrap();

            alphabet[index] as char
        })
        .collect();

    while out.len() % 4 != 0 {
        out.push('=');
    }

    out
}

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    rest: Vec<u8>,
}

async fn read_head(stream: &mut TcpStream) -> Option<Head> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];

    let end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }

        let n = stream.read(&mut chunk).await.ok()?;

        if n == 0 {
            return None;
        }

        buffer.extend_from_slice(&chunk[..n]);
    };
    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();

    Some(Head {
        method,
        target,
        headers,
        rest: buffer[end + 4..].to_vec(),
    })
}

async fn read_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    length: usize,
    slow: Option<(usize, Duration)>,
) -> Option<Vec<u8>> {
    let size = slow.map_or(65536, |(chunk, _)| chunk.max(1));
    let mut chunk = vec![0u8; size];

    while body.len() < length {
        if let Some((_, every)) = slow {
            tokio::time::sleep(every).await;
        }

        let want = (length - body.len()).min(size);
        let n = stream.read(&mut chunk[..want]).await.ok()?;

        if n == 0 {
            return None;
        }

        body.extend_from_slice(&chunk[..n]);
    }

    Some(body)
}

impl Shared {
    fn verify(&self, head: &Head) -> bool {
        let header = |name: &str| {
            head.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        };
        let Some(auth) = header("authorization") else {
            return false;
        };
        let signed_names = auth
            .split("SignedHeaders=")
            .nth(1)
            .and_then(|rest| rest.split(',').next())
            .unwrap_or("");
        let credential = auth
            .split("Credential=")
            .nth(1)
            .and_then(|rest| rest.split(',').next())
            .unwrap_or("");
        let mut scope = credential.splitn(2, '/');
        let (Some(access_key), Some(scope)) = (scope.next(), scope.next()) else {
            return false;
        };
        let scope_parts: Vec<&str> = scope.split('/').collect();

        if access_key != self.options.access_key_id
            || scope_parts.len() != 4
            || scope_parts[1] != "auto"
            || scope_parts[2] != "s3"
        {
            return false;
        }

        let mut signed: Vec<(&str, &str)> = Vec::new();

        for name in signed_names.split(';') {
            let Some(value) = header(name) else {
                return false;
            };

            signed.push((name, value));
        }

        let (path, query) = head
            .target
            .split_once('?')
            .unwrap_or((head.target.as_str(), ""));
        let expected = authorization(&SigningInput {
            method: &head.method,
            canonical_uri: path,
            canonical_query: query,
            headers: &signed,
            payload_hash: header("x-amz-content-sha256").unwrap_or(""),
            region: "auto",
            service: "s3",
            amz_date: header("x-amz-date").unwrap_or(""),
            access_key_id: &self.options.access_key_id,
            secret_access_key: &self.options.secret_access_key,
        });

        expected == auth
    }

    fn list(&self, query: &str) -> String {
        let params: BTreeMap<String, String> = query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let (n, v) = p.split_once('=').unwrap_or((p, ""));

                (decode_percent(n), decode_percent(v))
            })
            .collect();
        let prefix = params.get("prefix").cloned().unwrap_or_default();
        let max: usize = params
            .get("max-keys")
            .and_then(|m| m.parse().ok())
            .unwrap_or(1000);
        let start: usize = params
            .get("continuation-token")
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        let objects = self.objects.lock().unwrap();
        let all: Vec<(&String, &Vec<u8>)> = objects
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .collect();
        let page: Vec<_> = all.iter().skip(start).take(max.max(1)).collect();
        let truncated = start + page.len() < all.len();
        let contents: String = page
            .iter()
            .map(|(k, v)| {
                format!(
                    "<Contents><Key>{}</Key><Size>{}</Size></Contents>",
                    escape_xml(k),
                    v.len()
                )
            })
            .collect();
        let token = if truncated {
            format!(
                "<NextContinuationToken>{}</NextContinuationToken>",
                start + page.len()
            )
        } else {
            String::new()
        };

        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
             <Name>{}</Name><Prefix>{}</Prefix><KeyCount>{}</KeyCount><MaxKeys>{max}</MaxKeys>\
             <IsTruncated>{truncated}</IsTruncated>{contents}{token}</ListBucketResult>",
            self.options.bucket,
            escape_xml(&prefix),
            page.len()
        )
    }
}

async fn respond(
    stream: &mut TcpStream,
    date: Option<&str>,
    status: u16,
    headers: &[(&str, String)],
    body: &[u8],
) {
    let mut head = format!(
        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );

    if let Some(date) = date {
        head.push_str(&format!("Date: {date}\r\n"));
    }

    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }

    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn handle(shared: Arc<Shared>, mut stream: TcpStream) {
    let date = shared.options.date.clone();
    let Some(head) = read_head(&mut stream).await else {
        return;
    };
    let (path, query) = head
        .target
        .split_once('?')
        .map_or((head.target.clone(), String::new()), |(p, q)| {
            (p.to_string(), q.to_string())
        });
    let decoded = decode_percent(path.trim_start_matches('/'));
    let bucket_prefix = format!("{}/", shared.options.bucket);
    let key = decoded
        .strip_prefix(&bucket_prefix)
        .unwrap_or("")
        .to_string();
    let has = |name: &str| {
        query
            .split('&')
            .any(|p| p == name || p.starts_with(&format!("{name}=")))
    };
    let kind = match head.method.as_str() {
        "PUT" if !key.is_empty() => RequestType::Put,
        "HEAD" => RequestType::Head,
        "GET" if query.split('&').any(|p| p == "list-type=2") => RequestType::List,
        "POST" if has("delete") => RequestType::Delete,
        _ => RequestType::Other,
    };
    let length: usize = head
        .headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut recorded = RecordedRequest {
        method: head.method.clone(),
        target: head.target.clone(),
        key: key.clone(),
        kind: kind.clone(),
        headers: head.headers.clone(),
        bytes: 0,
        signature_ok: None,
    };
    let serial = {
        let mut serial = shared.serial.lock().unwrap();

        *serial += 1;
        *serial
    };
    let failure = shared
        .options
        .fail_when
        .as_ref()
        .and_then(|f| f(&recorded, serial));
    let slow = match failure {
        Some(Fail::Stall) => {
            shared.requests.lock().unwrap().push(recorded);
            shared.stalled.lock().unwrap().push(stream);

            return;
        }
        Some(Fail::SlowRead { chunk, every }) => Some((chunk, every)),
        _ => None,
    };
    let Some(body) = read_body(&mut stream, head.rest.clone(), length, slow).await else {
        shared.requests.lock().unwrap().push(recorded);

        return;
    };

    recorded.bytes = body.len();

    match failure {
        Some(Fail::Destroy) => {
            shared.requests.lock().unwrap().push(recorded);
            drop(stream);

            return;
        }
        Some(Fail::Status(status, code)) => {
            shared.requests.lock().unwrap().push(recorded);
            respond(
                &mut stream,
                date.as_deref(),
                status,
                &[("Content-Type", "application/xml".into())],
                format!("<Error><Code>{code}</Code><Message>injected</Message></Error>").as_bytes(),
            )
            .await;

            return;
        }
        Some(Fail::Redirect) => {
            shared.requests.lock().unwrap().push(recorded);
            respond(
                &mut stream,
                date.as_deref(),
                301,
                &[("Location", "http://127.0.0.1:9/elsewhere".into())],
                b"",
            )
            .await;

            return;
        }
        _ => {}
    }

    let signature_ok = shared.verify(&head);

    recorded.signature_ok = Some(signature_ok);
    shared.requests.lock().unwrap().push(recorded);

    if !signature_ok {
        respond(
            &mut stream,
            date.as_deref(),
            403,
            &[],
            b"<Error><Code>SignatureDoesNotMatch</Code></Error>",
        )
        .await;

        return;
    }

    match kind {
        RequestType::Put => {
            shared.objects.lock().unwrap().insert(key, body);
            respond(
                &mut stream,
                date.as_deref(),
                200,
                &[("ETag", "\"fake\"".into())],
                b"",
            )
            .await;
        }
        RequestType::Head => {
            let size = shared.objects.lock().unwrap().get(&key).map(Vec::len);

            respond(
                &mut stream,
                date.as_deref(),
                if size.is_some() { 200 } else { 404 },
                &[],
                b"",
            )
            .await;
        }
        RequestType::List => {
            let xml = shared.list(&query);

            respond(
                &mut stream,
                date.as_deref(),
                200,
                &[("Content-Type", "application/xml".into())],
                xml.as_bytes(),
            )
            .await;
        }
        RequestType::Delete => {
            let md5_ok = head
                .headers
                .iter()
                .any(|(n, v)| n == "content-md5" && *v == md5_base64(&body));

            if !md5_ok {
                respond(
                    &mut stream,
                    date.as_deref(),
                    400,
                    &[],
                    b"<Error><Code>InvalidDigest</Code></Error>",
                )
                .await;

                return;
            }

            let text = String::from_utf8_lossy(&body).into_owned();
            let keys: Vec<String> = text
                .split("<Key>")
                .skip(1)
                .filter_map(|part| part.split("</Key>").next())
                .map(|k| {
                    k.replace("&lt;", "<")
                        .replace("&gt;", ">")
                        .replace("&amp;", "&")
                })
                .collect();
            let mut errors = String::new();

            {
                let mut objects = shared.objects.lock().unwrap();

                for key in keys {
                    if shared.options.undeletable.contains(&key) {
                        errors.push_str(&format!(
                            "<Error><Key>{}</Key><Code>AccessDenied</Code></Error>",
                            escape_xml(&key)
                        ));
                    } else {
                        objects.remove(&key);
                    }
                }
            }

            respond(&mut stream, date.as_deref(),
                200,
                &[("Content-Type", "application/xml".into())],
                format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult>{errors}</DeleteResult>")
                    .as_bytes(),
            )
            .await;
        }
        RequestType::Other => respond(&mut stream, date.as_deref(), 400, &[], b"").await,
    }
}

impl FakeS3Server {
    pub async fn start(options: FakeS3ServerOptions) -> Self {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();

        if let Some(size) = options.recv_buffer {
            socket.set_recv_buffer_size(size).unwrap();
        }

        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();

        let listener = socket.listen(64).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(Shared {
            options,
            requests: Mutex::new(Vec::new()),
            objects: Mutex::new(BTreeMap::new()),
            serial: Mutex::new(0),
            stalled: Mutex::new(Vec::new()),
        });
        let task = {
            let shared = Arc::clone(&shared);

            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(handle(Arc::clone(&shared), stream));
                }
            })
        };

        Self {
            endpoint,
            shared,
            task,
        }
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.shared.requests.lock().unwrap().clone()
    }

    pub fn puts(&self) -> Vec<RecordedRequest> {
        self.requests()
            .into_iter()
            .filter(|r| r.kind == RequestType::Put)
            .collect()
    }

    pub fn objects(&self) -> BTreeMap<String, Vec<u8>> {
        self.shared.objects.lock().unwrap().clone()
    }

    pub fn put_object(&self, key: &str, data: &[u8]) {
        self.shared
            .objects
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
    }
}

/// Options with the test credentials (fake, never real).
pub fn options(bucket: &str) -> FakeS3ServerOptions {
    FakeS3ServerOptions {
        bucket: bucket.to_string(),
        access_key_id: TEST_ACCESS_KEY.to_string(),
        secret_access_key: TEST_SECRET_KEY.to_string(),
        fail_when: None,
        undeletable: vec![],
        recv_buffer: None,
        date: None,
    }
}

pub const TEST_ACCESS_KEY: &str = "AKIAFAKEFAKEFAKE";
pub const TEST_SECRET_KEY: &str = "fake-secret-fake-secret";
