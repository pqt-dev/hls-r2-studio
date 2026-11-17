//! Spawns child processes (no shell, args array) with a timeout, cancellation and a stderr tail.
//! Port of desktop-app/src/main/ffmpeg/runner.ts on top of `tokio::process`.
//!
//! - stdout/stderr are piped; stdout is streamed to `on_stdout` (and optionally collected),
//!   stderr is split into lines (`\n`, `\r\n` or a lone `\r`, which ffmpeg uses between progress
//!   updates), redacted, streamed to `on_stderr_line` and kept as a bounded tail.
//! - a timeout or a cancel kills the WHOLE process tree through the injected [`TreeKiller`].
//! - Windows: no console window flashes (`CREATE_NO_WINDOW`); the child runs below normal priority.

use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::kill_tree::{SystemTreeKiller, TreeKiller};
use crate::logger::{redact_string, RedactOptions};

pub const STDERR_TAIL_LINES: usize = 200;
const MAX_LINE_LENGTH: usize = 2000;
const MAX_COLLECTED_STDOUT_BYTES: usize = 8 * 1024 * 1024;
/// Safety net: how long to wait for the pipes to close after the tree has been killed.
const POST_KILL_GRACE: Duration = Duration::from_secs(5);

pub type StdoutCallback = Box<dyn FnMut(&str) + Send>;
pub type StderrLineCallback = Box<dyn FnMut(&str) + Send>;

pub struct RunProcessInput {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    /// Cancelling the token kills the process tree and ends the run with `aborted: true`.
    pub cancel: Option<CancellationToken>,
    /// Raw stdout chunks (decoded as UTF-8), e.g. the `-progress pipe:1` stream.
    pub on_stdout: Option<StdoutCallback>,
    /// Called for every complete stderr line (already redacted).
    pub on_stderr_line: Option<StderrLineCallback>,
    /// Collect stdout into `stdout_text` (for ffprobe).
    pub collect_stdout: bool,
}

impl RunProcessInput {
    pub fn new(command: &str, args: Vec<String>, timeout: Duration) -> Self {
        Self {
            command: command.to_string(),
            args,
            cwd: None,
            timeout,
            cancel: None,
            on_stdout: None,
            on_stderr_line: None,
            collect_stdout: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunResult {
    /// `None` when the process was killed by a signal or never started (aborted before spawn).
    pub exit_code: Option<i32>,
    /// Unix signal number that ended the process, if any (always `None` on Windows).
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub aborted: bool,
    pub stdout_text: Option<String>,
    /// Last [`STDERR_TAIL_LINES`] stderr lines, redacted.
    pub stderr_tail: Vec<String>,
}

impl RunResult {
    /// The collected stdout ("" when it was not collected).
    pub fn stdout(&self) -> &str {
        self.stdout_text.as_deref().unwrap_or("")
    }
}

/// The process could not be started.
#[derive(Debug)]
pub struct RunError(pub String);

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Failed to start process: {}", self.0)
    }
}

impl std::error::Error for RunError {}

/// Lowers the priority of a started process (best effort).
pub type SetPriority = Arc<dyn Fn(u32) -> io::Result<()> + Send + Sync>;

/// A runner with its platform pieces chosen (tree killer, priority); this is what steps receive.
#[derive(Clone)]
pub struct ProcessRunner {
    tree: Arc<dyn TreeKiller>,
    set_priority: SetPriority,
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessRunner {
    /// Process group (Unix) / Job Object (Windows) tree kill, below-normal priority.
    pub fn new() -> Self {
        Self::with(Arc::new(SystemTreeKiller), Arc::new(lower_priority))
    }

    /// Injectable pieces for tests.
    pub fn with(tree: Arc<dyn TreeKiller>, set_priority: SetPriority) -> Self {
        Self { tree, set_priority }
    }

    /// Convenience for ffprobe-style calls: collects stdout (see [`RunResult::stdout`]).
    pub async fn run_collect(&self, mut input: RunProcessInput) -> Result<RunResult, RunError> {
        input.collect_stdout = true;

        self.run(input).await
    }

    pub async fn run(&self, mut input: RunProcessInput) -> Result<RunResult, RunError> {
        let cancel = input.cancel.clone().unwrap_or_default();

        if cancel.is_cancelled() {
            return Ok(RunResult {
                aborted: true,
                stdout_text: input.collect_stdout.then(String::new),
                ..RunResult::default()
            });
        }

        let mut command = Command::new(&input.command);
        command
            .args(&input.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Last resort if this future is dropped: never leave the child running.
            .kill_on_drop(true);

        if let Some(cwd) = &input.cwd {
            command.current_dir(cwd);
        }

        configure_command(&mut command);

        let mut child = command.spawn().map_err(|e| RunError(e.to_string()))?;
        let pid = child.id();
        let mut guard = pid.map(|pid| self.tree.attach(pid));

        if let Some(pid) = pid {
            // Lowering the priority is best effort (e.g. the process already exited).
            let _ = (self.set_priority)(pid);
        }

        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let mut out_buf = vec![0u8; 16 * 1024];
        let mut err_buf = vec![0u8; 16 * 1024];
        let mut out_decoder = Utf8Stream::default();
        let mut err_decoder = Utf8Stream::default();
        let mut stderr_pending = String::new();
        let mut tail: VecDeque<String> = VecDeque::new();
        let mut stdout_parts = String::new();
        let mut timed_out = false;
        let mut aborted = false;
        let mut exit: Option<ExitStatus> = None;
        let mut grace_deadline: Option<Instant> = None;
        let timeout = tokio::time::sleep(input.timeout);
        tokio::pin!(timeout);

        // `kill` of the TS: kill the tree, then give the pipes a bounded time to close.
        macro_rules! kill {
            () => {{
                if let Some(guard) = guard.as_mut() {
                    guard.kill();
                }
                // Fallback if the tree kill failed: at least the direct child.
                let _ = child.start_kill();
                grace_deadline.get_or_insert_with(|| Instant::now() + POST_KILL_GRACE);
            }};
        }

        // Records one complete stderr line (redacted, bounded tail, callback).
        macro_rules! emit_line {
            ($part:expr) => {{
                let part: String = $part;

                if !part.is_empty() {
                    let line = redact_string(
                        &part.chars().take(MAX_LINE_LENGTH).collect::<String>(),
                        &RedactOptions::default(),
                    );

                    tail.push_back(line.clone());
                    if tail.len() > STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    if let Some(callback) = input.on_stderr_line.as_mut() {
                        callback(&line);
                    }
                }
            }};
        }

        // A chunk of stderr text: every complete line is emitted, the rest stays pending.
        macro_rules! push_stderr {
            ($text:expr) => {{
                let text: String = $text;
                let joined = std::mem::take(&mut stderr_pending) + &text;
                let mut parts = split_lines(&joined);

                stderr_pending = parts.pop().unwrap_or_default();

                for part in parts {
                    emit_line!(part);
                }
            }};
        }

        macro_rules! push_stdout {
            ($text:expr) => {{
                let text: String = $text;

                if !text.is_empty() {
                    if let Some(callback) = input.on_stdout.as_mut() {
                        callback(&text);
                    }
                    if input.collect_stdout && stdout_parts.len() < MAX_COLLECTED_STDOUT_BYTES {
                        stdout_parts.push_str(&text);
                    }
                }
            }};
        }

        loop {
            if exit.is_some() && stdout.is_none() && stderr.is_none() {
                break;
            }

            tokio::select! {
                read = read_some(&mut stdout, &mut out_buf), if stdout.is_some() => {
                    match read {
                        Some(n) => push_stdout!(out_decoder.push(&out_buf[..n])),
                        None => stdout = None,
                    }
                }
                read = read_some(&mut stderr, &mut err_buf), if stderr.is_some() => {
                    match read {
                        Some(n) => push_stderr!(err_decoder.push(&err_buf[..n])),
                        None => stderr = None,
                    }
                }
                status = child.wait(), if exit.is_none() => {
                    // A failed wait is treated as "exited without a code".
                    exit = Some(status.unwrap_or_else(|_| failed_status()));
                }
                () = cancel.cancelled(), if !aborted => {
                    aborted = true;
                    kill!();
                }
                () = &mut timeout, if !timed_out => {
                    timed_out = true;
                    kill!();
                }
                () = tokio::time::sleep_until(grace_deadline.unwrap_or_else(Instant::now)), if grace_deadline.is_some() => {
                    // The pipes did not close in time: stop reading them.
                    stdout = None;
                    stderr = None;

                    if exit.is_none() {
                        exit = Some(child.wait().await.unwrap_or_else(|_| failed_status()));
                    }
                }
            }
        }

        // The stream closed: the unfinished last line counts as a line.
        let rest = std::mem::take(&mut stderr_pending) + &err_decoder.finish();

        for part in split_lines(&rest) {
            emit_line!(part);
        }

        push_stdout!(out_decoder.finish());

        let (exit_code, signal) = exit.map_or((None, None), |s| (s.code(), signal_of(&s)));

        Ok(RunResult {
            exit_code,
            signal,
            timed_out,
            aborted,
            stdout_text: input.collect_stdout.then_some(stdout_parts),
            stderr_tail: tail.into(),
        })
    }
}

/// Reads one chunk; `None` at EOF or on a read error (the pipe is done either way).
async fn read_some<R: AsyncRead + Unpin>(reader: &mut Option<R>, buf: &mut [u8]) -> Option<usize> {
    match reader.as_mut()?.read(buf).await {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

/// An exit status for "the wait itself failed" (no code, no signal).
#[cfg(unix)]
fn failed_status() -> ExitStatus {
    std::os::unix::process::ExitStatusExt::from_raw(0x7f)
}

#[cfg(windows)]
fn failed_status() -> ExitStatus {
    std::os::windows::process::ExitStatusExt::from_raw(1)
}

#[cfg(unix)]
fn signal_of(status: &ExitStatus) -> Option<i32> {
    std::os::unix::process::ExitStatusExt::signal(status)
}

#[cfg(not(unix))]
fn signal_of(_status: &ExitStatus) -> Option<i32> {
    None
}

/// Process-tree and window setup that must happen before the spawn.
fn configure_command(command: &mut Command) {
    #[cfg(unix)]
    {
        // Own process group (pgid = pid) so the whole tree can be killed with one signal.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(super::kill_tree::windows::CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = command;
    }
}

/// Nice 10 (`os.constants.priority.PRIORITY_BELOW_NORMAL`) / `BELOW_NORMAL_PRIORITY_CLASS`.
fn lower_priority(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: plain syscall with integer arguments.
        let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS as _, pid as libc::id_t, 10) };

        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
        };

        let process = super::kill_tree::windows::open_process(pid, PROCESS_SET_INFORMATION)
            .ok_or_else(io::Error::last_os_error)?;

        // SAFETY: the handle is valid for the duration of the call.
        let ok = unsafe { SetPriorityClass(process.0, BELOW_NORMAL_PRIORITY_CLASS) };

        if ok != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Ok(())
    }
}

/// Splits like JS `text.split(/\r\n|\n|\r/)`: the last element is the (possibly empty) rest.
fn split_lines(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                parts.push(std::mem::take(&mut current));
            }
            '\n' => parts.push(std::mem::take(&mut current)),
            other => current.push(other),
        }
    }

    parts.push(current);

    parts
}

/// Incremental UTF-8 decoder (Node's `StringDecoder('utf8')`): a multi-byte character split
/// across chunks is completed by the next chunk; invalid bytes become U+FFFD.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);

        let mut out = String::new();
        let mut consumed = 0;

        loop {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    out.push_str(valid);
                    consumed = self.pending.len();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[consumed..consumed + valid_up_to])
                            .unwrap_or_default(),
                    );
                    consumed += valid_up_to;

                    match error.error_len() {
                        // An incomplete character at the end: wait for more bytes.
                        None => break,
                        Some(len) => {
                            out.push('\u{FFFD}');
                            consumed += len;
                        }
                    }
                }
            }
        }

        self.pending.drain(..consumed);

        out
    }

    /// Flushes a trailing incomplete character (as U+FFFD).
    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            "\u{FFFD}".to_string()
        }
    }
}

#[cfg(test)]
mod tests;
