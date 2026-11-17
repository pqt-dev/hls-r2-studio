//! What the steps need from the outside world, as traits so tests can use fakes (the TS
//! `PipelineDeps`). The real implementations are thin wrappers over tokio / the M3 runner / the
//! R2 client (`pipeline::s3`).

use std::io;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use crate::api::AppConfigR2;

use crate::ffmpeg::runner::{ProcessRunner, RunError, RunProcessInput, RunResult};

/// Spawns a child process (kill-tree/priority already bound).
#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, input: RunProcessInput) -> Result<RunResult, RunError>;
}

#[async_trait]
impl CommandRunner for ProcessRunner {
    async fn run(&self, input: RunProcessInput) -> Result<RunResult, RunError> {
        ProcessRunner::run(self, input).await
    }
}

/// The filesystem operations of the steps (all inside a job's temp directory).
#[async_trait]
pub trait StepFs: Send + Sync {
    /// Size of a regular file, `None` when it is missing or not a file.
    async fn file_size(&self, path: &Path) -> Option<u64>;
    async fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// File names (not paths) directly inside `dir`.
    async fn list_names(&self, dir: &Path) -> io::Result<Vec<String>>;
    async fn copy(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Deletes a file, ignoring a missing file and any error (best-effort temp cleanup).
    async fn remove_file(&self, path: &Path);

    async fn is_file(&self, path: &Path) -> bool {
        self.file_size(path).await.is_some()
    }

    async fn remove_files(&self, paths: &[std::path::PathBuf]) {
        for path in paths {
            self.remove_file(path).await;
        }
    }
}

pub struct RealFs;

#[async_trait]
impl StepFs for RealFs {
    async fn file_size(&self, path: &Path) -> Option<u64> {
        let meta = tokio::fs::metadata(path).await.ok()?;

        meta.is_file().then_some(meta.len())
    }

    async fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        tokio::fs::read(path).await
    }

    async fn list_names(&self, dir: &Path) -> io::Result<Vec<String>> {
        let mut entries = tokio::fs::read_dir(dir).await?;
        let mut names = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }

        Ok(names)
    }

    async fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        tokio::fs::copy(from, to).await.map(|_| ())
    }

    async fn remove_file(&self, path: &Path) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// The clock (`now` of the TS deps); the prefix uses its UTC date.
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Why an object-store call failed. The upload policy only needs to know whether the network is
/// the problem (`upload::classify_error`), so the variants keep exactly that information.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No (complete) HTTP answer: connect failure, reset, DNS, timeout, socket inactivity.
    Network(String),
    /// The server answered with a non-success status. `code` is the S3 error code of the XML
    /// body (`AccessDenied`, `SlowDown`, ...), when there is one.
    Http { status: u16, code: Option<String> },
    /// A local problem (the file could not be read, invalid input, client setup). Never a
    /// network failure.
    Local(String),
    /// Our own cancellation token fired (never mistaken for a network timeout).
    Cancelled,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(message) => write!(f, "network error: {message}"),
            Self::Http {
                status,
                code: Some(code),
            } => write!(f, "HTTP {status} ({code})"),
            Self::Http { status, code: None } => write!(f, "HTTP {status}"),
            Self::Local(message) => write!(f, "local error: {message}"),
            Self::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl std::error::Error for StoreError {}

/// One listed object: key and byte size (`None` when the listing had no size).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedObject {
    pub key: String,
    pub size: Option<u64>,
}

/// One page of `ListObjectsV2`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListPage {
    pub objects: Vec<ListedObject>,
    /// Set only when the listing is truncated.
    pub next_token: Option<String>,
}

impl ListPage {
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.objects.iter().map(|o| o.key.as_str())
    }
}

/// Called with the number of body bytes handed to the connection so far (monotonic).
pub type OnBytes = std::sync::Arc<dyn Fn(u64) + Send + Sync>;

/// One `PutObject` whose body is streamed from a local file (never buffered whole).
pub struct PutFileRequest<'a> {
    pub bucket: &'a str,
    pub key: &'a str,
    pub path: &'a Path,
    /// Exact number of bytes sent (`Content-Length`).
    pub content_length: u64,
    pub content_type: &'a str,
    pub on_bytes: Option<OnBytes>,
}

/// The object-store calls of the upload, the resume and the cleanup (S3/R2 in production:
/// `pipeline::s3::R2Client`).
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// One `ListObjectsV2` page. `max_keys: None` leaves the server default (1000).
    async fn list_page(
        &self,
        bucket: &str,
        prefix: &str,
        max_keys: Option<usize>,
        token: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Result<ListPage, StoreError>;

    /// Deletes the keys in one batch; returns how many failed.
    async fn delete_keys(&self, bucket: &str, keys: &[String]) -> Result<usize, StoreError>;

    /// `PutObject` with the file as a streamed body. Cancelling the token stops the request
    /// at once with [`StoreError::Cancelled`].
    async fn put_file(
        &self,
        request: PutFileRequest<'_>,
        cancel: &CancellationToken,
    ) -> Result<(), StoreError>;
}

/// `S3ClientPurpose`: `Upload` never retries inside the client (a streamed body cannot be
/// replayed; the upload step has its own retry policy). `Cleanup` (list/delete, replayable)
/// makes up to 3 attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientPurpose {
    Upload,
    Cleanup,
}

/// `createS3Client` of the TS deps. A client is created per use and dropped when done (the TS
/// `destroy()`).
pub trait ObjectStoreFactory: Send + Sync {
    fn create(
        &self,
        r2: &AppConfigR2,
        purpose: ClientPurpose,
    ) -> Result<Arc<dyn ObjectStore>, StoreError>;
}

/// `sleep(ms, signal)` of the TS deps: waits `ms`, returning early (without error) when the
/// token is cancelled.
#[async_trait]
pub trait Sleeper: Send + Sync {
    async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>);
}

pub struct TokioSleeper;

#[async_trait]
impl Sleeper for TokioSleeper {
    async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
        let wait = tokio::time::sleep(std::time::Duration::from_millis(ms));

        match cancel {
            Some(token) => {
                tokio::select! {
                    () = wait => {}
                    () = token.cancelled() => {}
                }
            }
            None => wait.await,
        }
    }
}

/// Free bytes on the volume that holds `dir`.
pub trait FreeSpace: Send + Sync {
    fn free_bytes(&self, dir: &Path) -> io::Result<u64>;
}

pub struct SystemFreeSpace;

impl FreeSpace for SystemFreeSpace {
    fn free_bytes(&self, dir: &Path) -> io::Result<u64> {
        free_bytes_of(dir)
    }
}

/// Bytes available to the current user (`statvfs` `f_bavail * f_frsize`, like Node's `statfs`
/// `bavail * bsize`).
#[cfg(unix)]
pub fn free_bytes_of(dir: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid NUL-terminated string and `stat` a writable statvfs.
    let result = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };

    if result != 0 {
        return Err(io::Error::last_os_error());
    }

    #[allow(clippy::unnecessary_cast)]
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

/// Bytes available to the current user (`GetDiskFreeSpaceExW`, honours quotas).
#[cfg(windows)]
pub fn free_bytes_of(dir: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: `wide` is NUL-terminated; the out pointer is valid; the others may be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };

    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(available)
}

/// In-memory fakes shared by the step tests.
#[cfg(test)]
pub mod fakes {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct FakeFs {
        pub files: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
    }

    impl FakeFs {
        pub fn put(&self, path: impl Into<PathBuf>, data: &[u8]) {
            self.files
                .lock()
                .unwrap()
                .insert(path.into(), data.to_vec());
        }

        pub fn has(&self, path: impl AsRef<Path>) -> bool {
            self.files.lock().unwrap().contains_key(path.as_ref())
        }

        pub fn names(&self) -> Vec<String> {
            self.files
                .lock()
                .unwrap()
                .keys()
                .filter_map(|p| p.file_name()?.to_str().map(str::to_string))
                .collect()
        }
    }

    #[async_trait]
    impl StepFs for FakeFs {
        async fn file_size(&self, path: &Path) -> Option<u64> {
            self.files.lock().unwrap().get(path).map(|d| d.len() as u64)
        }

        async fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }

        async fn list_names(&self, dir: &Path) -> io::Result<Vec<String>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .keys()
                .filter(|p| p.parent() == Some(dir))
                .filter_map(|p| p.file_name()?.to_str().map(str::to_string))
                .collect())
        }

        async fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
            let data = self.read(from).await?;

            self.put(to, &data);

            Ok(())
        }

        async fn remove_file(&self, path: &Path) {
            self.files.lock().unwrap().remove(path);
        }
    }

    pub struct Call {
        pub command: String,
        pub args: Vec<String>,
    }

    type Handler = Box<dyn FnMut(&mut RunProcessInput) -> Result<RunResult, RunError> + Send>;

    /// Scripted process runner: the handler sees every call (and may create files in the fake
    /// filesystem or feed `on_stdout`) and returns the result.
    pub struct FakeRunner {
        handler: Mutex<Handler>,
        pub calls: Mutex<Vec<Call>>,
    }

    impl FakeRunner {
        pub fn new(
            handler: impl FnMut(&mut RunProcessInput) -> Result<RunResult, RunError> + Send + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                handler: Mutex::new(Box::new(handler)),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(&self, mut input: RunProcessInput) -> Result<RunResult, RunError> {
            self.calls.lock().unwrap().push(Call {
                command: input.command.clone(),
                args: input.args.clone(),
            });

            (self.handler.lock().unwrap())(&mut input)
        }
    }

    pub fn ok_result(stdout: &str) -> RunResult {
        RunResult {
            exit_code: Some(0),
            stdout_text: Some(stdout.to_string()),
            ..RunResult::default()
        }
    }

    pub fn exit_result(code: i32) -> RunResult {
        RunResult {
            exit_code: Some(code),
            stdout_text: Some(String::new()),
            stderr_tail: vec!["boom".into()],
            ..RunResult::default()
        }
    }

    pub struct FixedClock(pub DateTime<Utc>);

    impl Clock for FixedClock {
        fn now(&self) -> DateTime<Utc> {
            self.0
        }
    }

    #[test]
    fn the_clock_trait_feeds_the_prefix() {
        use crate::pipeline::prefix::build_prefix;
        use chrono::TimeZone;

        let clock = FixedClock(Utc.with_ymd_and_hms(2026, 3, 5, 23, 59, 59).unwrap());

        assert_eq!(
            build_prefix(clock.now(), "my-video", "ab12cd34ef56").unwrap(),
            "2026/03/05/my-video-ab12cd34ef56/"
        );
        assert!(SystemClock.now().timestamp() > 0);
    }
}
