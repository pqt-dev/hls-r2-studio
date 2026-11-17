//! Synchronous rotating file logger. Port of desktop-app/src/main/logger/logger.ts: same line
//! format (`<ISO-8601 UTC ms> <LEVEL> <message> [<json meta>]`), size rotation (`app.log`,
//! `app.log.1`, ...) and "logging never fails the app". Every message and field goes through
//! the redaction rules.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::redact::{redact_string, redact_value, RedactOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// Logging interface (`Logger` in TS). `meta` carries structured fields.
pub trait Log: Send + Sync {
    fn log(&self, level: LogLevel, message: &str, meta: Option<Value>);

    fn debug(&self, message: &str, meta: Option<Value>) {
        self.log(LogLevel::Debug, message, meta);
    }

    fn info(&self, message: &str, meta: Option<Value>) {
        self.log(LogLevel::Info, message, meta);
    }

    fn warn(&self, message: &str, meta: Option<Value>) {
        self.log(LogLevel::Warn, message, meta);
    }

    fn error(&self, message: &str, meta: Option<Value>) {
        self.log(LogLevel::Error, message, meta);
    }
}

pub struct FileLoggerOptions {
    /// Directory that holds the log files (`<user data>/logs`).
    pub dir: PathBuf,
    /// Base file name. Rotated files are `<name>.1`, `<name>.2`, ... Default `app.log`.
    pub file_name: String,
    /// Total number of files kept, including the active one. Default 5.
    pub max_files: usize,
    /// Rotate when the active file would exceed this size. Default 1 MB.
    pub max_bytes: u64,
    /// Minimum level written. Default `Info`.
    pub level: LogLevel,
    /// Home directory to mask as `~`. `None` = the current user's home directory.
    pub home_dir: Option<String>,
    /// Clock, injectable for tests.
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl FileLoggerOptions {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            file_name: "app.log".into(),
            max_files: 5,
            max_bytes: 1024 * 1024,
            level: LogLevel::Info,
            home_dir: None,
            now: Arc::new(Utc::now),
        }
    }
}

struct Inner {
    size: u64,
    ready: bool,
}

pub struct FileLogger {
    options: FileLoggerOptions,
    active_path: PathBuf,
    inner: Mutex<Inner>,
}

impl FileLogger {
    pub fn new(options: FileLoggerOptions) -> Self {
        let active_path = options.dir.join(&options.file_name);

        Self {
            options,
            active_path,
            inner: Mutex::new(Inner {
                size: 0,
                ready: false,
            }),
        }
    }

    pub fn dir(&self) -> &std::path::Path {
        &self.options.dir
    }

    fn rotated(&self, index: usize) -> PathBuf {
        let mut os = self.active_path.as_os_str().to_owned();
        os.push(format!(".{index}"));

        PathBuf::from(os)
    }

    fn rotate(&self, inner: &mut Inner) {
        let max_files = self.options.max_files.max(1);

        let _ = fs::remove_file(self.rotated(max_files - 1));

        for i in (1..max_files.saturating_sub(1)).rev() {
            // Missing file: nothing to shift.
            let _ = fs::rename(self.rotated(i), self.rotated(i + 1));
        }

        if max_files > 1 {
            // Active file does not exist yet: nothing to rotate.
            let _ = fs::rename(&self.active_path, self.rotated(1));
        } else {
            let _ = fs::remove_file(&self.active_path);
        }

        inner.size = 0;
    }

    fn write(&self, level: LogLevel, message: &str, meta: Option<Value>) -> std::io::Result<()> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        if !inner.ready {
            fs::create_dir_all(&self.options.dir)?;
            inner.size = fs::metadata(&self.active_path).map_or(0, |m| m.len());
            inner.ready = true;
        }

        let redact_options = RedactOptions {
            home_dir: self.options.home_dir.clone(),
        };
        let timestamp = (self.options.now)().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut line = format!(
            "{timestamp} {} {}",
            level.label(),
            redact_string(message, &redact_options)
        );

        if let Some(meta) = meta {
            line.push(' ');
            line.push_str(&serde_json::to_string(&redact_value(
                &meta,
                &redact_options,
            ))?);
        }

        line.push('\n');
        let bytes = line.len() as u64;

        if inner.size > 0 && inner.size + bytes > self.options.max_bytes {
            self.rotate(&mut inner);
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.active_path)?;
        file.write_all(line.as_bytes())?;
        inner.size += bytes;

        Ok(())
    }
}

impl Log for FileLogger {
    fn log(&self, level: LogLevel, message: &str, meta: Option<Value>) {
        if level < self.options.level {
            return;
        }

        // Logging must never crash the app.
        let _ = self.write(level, message, meta);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    fn fixed_now() -> Arc<dyn Fn() -> DateTime<Utc> + Send + Sync> {
        Arc::new(|| Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap())
    }

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();

        v
    }

    #[test]
    fn writes_lines_with_level_and_redacted_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = FileLoggerOptions::new(dir.path().to_path_buf());
        o.home_dir = Some("/Users/bob".into());
        o.now = fixed_now();
        let logger = FileLogger::new(o);

        logger.info(
            "open /Users/bob/a.mp4",
            Some(json!({ "token": "abc", "n": 1 })),
        );

        assert_eq!(
            fs::read_to_string(dir.path().join("app.log")).unwrap(),
            "2026-01-02T03:04:05.000Z INFO open ~/a.mp4 {\"token\":\"[REDACTED]\",\"n\":1}\n"
        );
    }

    #[test]
    fn respects_the_minimum_level() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = FileLoggerOptions::new(dir.path().to_path_buf());
        o.level = LogLevel::Warn;
        let logger = FileLogger::new(o);

        logger.debug("d", None);
        logger.info("i", None);
        logger.warn("w", None);
        logger.error("e", None);

        let text = fs::read_to_string(dir.path().join("app.log")).unwrap();
        let lines: Vec<&str> = text.trim().split('\n').collect();

        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("WARN w"));
        assert!(lines[1].contains("ERROR e"));
    }

    #[test]
    fn rotates_by_size_and_keeps_at_most_max_files_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = FileLoggerOptions::new(dir.path().to_path_buf());
        o.max_bytes = 200;
        o.max_files = 3;
        let logger = FileLogger::new(o);

        for i in 0..40 {
            logger.info(&format!("message number {i} {}", "x".repeat(30)), None);
        }

        let files = names(dir.path());
        assert_eq!(files, ["app.log", "app.log.1", "app.log.2"]);

        for f in &files {
            assert!(fs::read_to_string(dir.path().join(f)).unwrap().len() <= 200);
        }

        // The newest message is in the active file, older ones in rotated files.
        assert!(fs::read_to_string(dir.path().join("app.log"))
            .unwrap()
            .contains("message number 39"));
        assert!(!fs::read_to_string(dir.path().join("app.log.1"))
            .unwrap()
            .contains("message number 39"));
    }

    #[test]
    fn a_single_file_budget_just_restarts_the_active_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = FileLoggerOptions::new(dir.path().to_path_buf());
        o.max_bytes = 100;
        o.max_files = 1;
        let logger = FileLogger::new(o);

        for i in 0..10 {
            logger.info(&format!("message number {i} {}", "x".repeat(30)), None);
        }

        assert_eq!(names(dir.path()), ["app.log"]);
    }

    #[test]
    fn continues_appending_to_an_existing_file_after_restart() {
        let dir = tempfile::tempdir().unwrap();

        FileLogger::new(FileLoggerOptions::new(dir.path().to_path_buf())).info("first", None);
        FileLogger::new(FileLoggerOptions::new(dir.path().to_path_buf())).info("second", None);

        let text = fs::read_to_string(dir.path().join("app.log")).unwrap();

        assert_eq!(text.trim().split('\n').count(), 2);
    }

    #[test]
    fn never_panics_when_the_directory_is_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "a file, not a directory").unwrap();

        let logger = FileLogger::new(FileLoggerOptions::new(blocker.join("sub")));

        logger.error("still fine", None);
    }
}
