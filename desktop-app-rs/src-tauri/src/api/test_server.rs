//! Tiny scripted HTTP/1.1 server on 127.0.0.1 for the site client tests. One request per
//! connection (`Connection: close`); every request is recorded.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();

        self.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub enum Reply {
    Full {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Chunked transfer encoding, one write per chunk.
    Chunks { status: u16, chunks: Vec<Vec<u8>> },
    /// Chunked body that never ends (until the client goes away).
    Endless { chunk_size: usize },
    /// Never answers.
    Hang,
}

impl Reply {
    pub fn json(status: u16, body: Value) -> Self {
        Self::json_with(status, body, &[])
    }

    pub fn json_with(status: u16, body: Value, headers: &[(&str, &str)]) -> Self {
        let mut all = vec![("Content-Type".to_string(), "application/json".to_string())];
        all.extend(headers.iter().map(|(n, v)| (n.to_string(), v.to_string())));

        Self::Full {
            status,
            headers: all,
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self::Full {
            status,
            headers: vec![],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn empty(status: u16, headers: &[(&str, &str)]) -> Self {
        Self::Full {
            status,
            headers: headers
                .iter()
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .collect(),
            body: vec![],
        }
    }
}

type Respond = Arc<dyn Fn(&Recorded) -> Reply + Send + Sync>;

pub struct TestServer {
    pub base_url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    /// Set when an endless body could not be written any more (the client hung up).
    pub endless_stopped: Arc<AtomicBool>,
    /// Number of chunks an endless body managed to write.
    pub endless_chunks: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];

    let head_end = loop {
        if let Some(end) = find_head_end(&buffer) {
            break end;
        }

        let n = stream.read(&mut chunk).await.ok()?;

        if n == 0 {
            return None;
        }

        buffer.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();

    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;

        if n == 0 {
            break;
        }

        body.extend_from_slice(&chunk[..n]);
    }

    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}

async fn write_reply(
    stream: &mut TcpStream,
    reply: Reply,
    endless_stopped: &AtomicBool,
    endless_chunks: &AtomicUsize,
) {
    match reply {
        Reply::Full {
            status,
            headers,
            body,
        } => {
            let mut head = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );

            for (name, value) in headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }

            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        }
        Reply::Chunks { status, chunks } => {
            let head = format!(
                "HTTP/1.1 {status} X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes()).await;

            for chunk in chunks {
                let _ = stream
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await;
                let _ = stream.write_all(&chunk).await;
                let _ = stream.write_all(b"\r\n").await;
                let _ = stream.flush().await;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }

            let _ = stream.write_all(b"0\r\n\r\n").await;
        }
        Reply::Endless { chunk_size } => {
            let head = "HTTP/1.1 200 X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes()).await;
            let data = vec![b' '; chunk_size];

            loop {
                let written = async {
                    stream
                        .write_all(format!("{chunk_size:x}\r\n").as_bytes())
                        .await?;
                    stream.write_all(&data).await?;
                    stream.write_all(b"\r\n").await
                };

                if written.await.is_err() {
                    endless_stopped.store(true, Ordering::SeqCst);
                    break;
                }

                endless_chunks.fetch_add(1, Ordering::SeqCst);
            }
        }
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }

    let _ = stream.shutdown().await;
}

impl TestServer {
    pub async fn start(respond: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let endless_stopped = Arc::new(AtomicBool::new(false));
        let endless_chunks = Arc::new(AtomicUsize::new(0));
        let respond: Respond = Arc::new(respond);

        let task = {
            let requests = Arc::clone(&requests);
            let endless_stopped = Arc::clone(&endless_stopped);
            let endless_chunks = Arc::clone(&endless_chunks);

            tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        break;
                    };
                    let requests = Arc::clone(&requests);
                    let respond = Arc::clone(&respond);
                    let endless_stopped = Arc::clone(&endless_stopped);
                    let endless_chunks = Arc::clone(&endless_chunks);

                    tokio::spawn(async move {
                        let Some(request) = read_request(&mut stream).await else {
                            return;
                        };
                        let reply = respond(&request);

                        requests.lock().unwrap().push(request);
                        write_reply(&mut stream, reply, &endless_stopped, &endless_chunks).await;
                    });
                }
            })
        };

        Self {
            base_url,
            requests,
            endless_stopped,
            endless_chunks,
            task,
        }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

/// A loopback URL nothing listens on (connection refused).
pub async fn closed_port_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);

    url
}
