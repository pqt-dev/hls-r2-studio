//! Port of runner.test.ts and runner.integration.test.ts.
//!
//! The "fake child process" is this very test binary: [`fake_child`] is a test that does nothing
//! unless an argument `hlsmode=<mode>` is present (libtest treats unknown positional arguments as
//! extra name filters, so they are harmless), in which case it behaves like a small program
//! (print, exit, sleep, spawn a grandchild...). That keeps the runner tests identical on Windows
//! and Unix with no shell scripts and no extra binaries. libtest prints a `running 1 test`
//! header on stdout, so stdout assertions use `contains`.

use std::io::Write;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::ffmpeg::kill_tree::TreeGuard;

const MODE_PREFIX: &str = "hlsmode=";
const TEST_NAME: &str = "ffmpeg::runner::tests::fake_child";

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn mode_args(mode: &str) -> Vec<String> {
    vec![
        "--exact".into(),
        TEST_NAME.into(),
        "--nocapture".into(),
        format!("{MODE_PREFIX}{mode}"),
    ]
}

/// The program that the runner tests spawn (see the module docs).
#[test]
fn fake_child() {
    let args: Vec<String> = std::env::args().collect();
    let Some(mode) = args.iter().find_map(|a| a.strip_prefix(MODE_PREFIX)) else {
        return;
    };
    let mut stdout = std::io::stdout();

    match mode {
        "exit3" => {
            println!("h\u{e9}llo");
            stdout.flush().unwrap();
            std::process::exit(3);
        }
        "exit0" => {
            println!("done");
            stdout.flush().unwrap();
            std::process::exit(0);
        }
        "streams" => {
            println!("a=1");
            stdout.flush().unwrap();
            eprintln!("one");
            eprint!("two\rthree\n");
            std::process::exit(0);
        }
        "many_stderr" => {
            for i in 0..300 {
                eprintln!("line {i} Authorization: Bearer abc.def");
            }
            std::process::exit(0);
        }
        "arg_echo" => {
            let last = args.last().cloned().unwrap_or_default();
            println!("ARG=<{last}>");
            stdout.flush().unwrap();
            std::process::exit(0);
        }
        "sleep" => sleep_forever(),
        "tree_parent" => {
            let grandchild = std::process::Command::new(std::env::current_exe().unwrap())
                .args(mode_args("sleep"))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();

            println!("GC={}", grandchild.id());
            stdout.flush().unwrap();
            // Keep the handle alive: the tree must be killed by the runner, not by us.
            let _grandchild = grandchild;
            sleep_forever();
        }
        other => panic!("unknown fake mode {other}"),
    }
}

fn fake(mode: &str) -> RunProcessInput {
    let exe = std::env::current_exe().unwrap();

    RunProcessInput::new(
        exe.to_str().unwrap(),
        mode_args(mode),
        Duration::from_secs(60),
    )
}

#[derive(Default)]
struct Recording {
    attached: AtomicUsize,
    killed: AtomicUsize,
}

struct RecordingKiller(Arc<Recording>);

struct RecordingGuard {
    recording: Arc<Recording>,
    inner: Box<dyn TreeGuard>,
}

impl TreeKiller for RecordingKiller {
    fn attach(&self, pid: u32) -> Box<dyn TreeGuard> {
        self.0.attached.fetch_add(1, Ordering::SeqCst);

        Box::new(RecordingGuard {
            recording: Arc::clone(&self.0),
            inner: SystemTreeKiller.attach(pid),
        })
    }
}

impl TreeGuard for RecordingGuard {
    fn kill(&mut self) {
        self.recording.killed.fetch_add(1, Ordering::SeqCst);
        self.inner.kill();
    }
}

fn recording_runner() -> (ProcessRunner, Arc<Recording>) {
    let recording = Arc::new(Recording::default());
    let runner = ProcessRunner::with(
        Arc::new(RecordingKiller(Arc::clone(&recording))),
        Arc::new(|_| Ok(())),
    );

    (runner, recording)
}

fn shared_string() -> Arc<Mutex<String>> {
    Arc::new(Mutex::new(String::new()))
}

// ---- process liveness ---------------------------------------------------------------------

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let exists = unsafe { libc::kill(pid as i32, 0) } == 0;

    if !exists {
        return false;
    }

    // A zombie (killed, not yet reaped by an init that does not reap) is not alive.
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            stat.rsplit_once(')')
                .and_then(|(_, rest)| rest.trim_start().chars().next())
                != Some('Z')
        }
        Err(_) => true,
    }
}

#[cfg(windows)]
fn is_alive(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const STILL_ACTIVE: u32 = 259;

    let Some(process) =
        crate::ffmpeg::kill_tree::windows::open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    else {
        return false;
    };
    let mut code = 0u32;

    // SAFETY: the handle is valid and `code` outlives the call.
    let ok = unsafe { GetExitCodeProcess(process.0, &mut code) };

    ok != 0 && code == STILL_ACTIVE
}

async fn wait_dead(pid: u32) -> bool {
    for _ in 0..50 {
        if !is_alive(pid) {
            return true;
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    false
}

// ---- runProcess ---------------------------------------------------------------------------

#[tokio::test]
async fn collects_stdout_and_reports_the_exit_code() {
    let result = ProcessRunner::new()
        .run_collect(fake("exit3"))
        .await
        .unwrap();

    assert_eq!(result.exit_code, Some(3));
    assert!(!result.timed_out && !result.aborted);
    assert!(
        result.stdout().contains("h\u{e9}llo\n"),
        "{:?}",
        result.stdout()
    );
}

#[tokio::test]
async fn streams_stdout_chunks_and_complete_stderr_lines() {
    let chunks = shared_string();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut input = fake("streams");
    let chunks_sink = Arc::clone(&chunks);
    let lines_sink = Arc::clone(&lines);
    input.on_stdout = Some(Box::new(move |c| chunks_sink.lock().unwrap().push_str(c)));
    input.on_stderr_line = Some(Box::new(move |l| {
        lines_sink.lock().unwrap().push(l.to_string())
    }));

    let result = ProcessRunner::new().run(input).await.unwrap();
    let expected = vec!["one".to_string(), "two".into(), "three".into()];

    assert!(chunks.lock().unwrap().contains("a=1\n"));
    assert_eq!(*lines.lock().unwrap(), expected);
    assert_eq!(result.stdout_text, None);
    assert_eq!(result.stderr_tail, expected);
}

#[tokio::test]
async fn keeps_only_the_last_200_stderr_lines_and_redacts_them() {
    let result = ProcessRunner::new().run(fake("many_stderr")).await.unwrap();

    assert_eq!(result.stderr_tail.len(), STDERR_TAIL_LINES);
    assert_eq!(result.stderr_tail[0], "line 100 Authorization: [REDACTED]");
    assert!(result.stderr_tail.last().unwrap().contains("line 299"));
    assert!(!result.stderr_tail.join("\n").contains("abc.def"));
}

#[tokio::test]
async fn does_not_use_a_shell_metacharacters_are_plain_arguments() {
    let weird = "$(echo hacked); `id` | cat";
    let mut input = fake("arg_echo");
    input.args.push(weird.to_string());

    let result = ProcessRunner::new().run_collect(input).await.unwrap();

    assert!(
        result.stdout().contains(&format!("ARG=<{weird}>")),
        "{:?}",
        result.stdout()
    );
}

#[tokio::test]
async fn lowers_the_priority_and_survives_a_failing_set_priority() {
    let seen = Arc::new(AtomicU32::new(0));
    let seen_in_hook = Arc::clone(&seen);
    let runner = ProcessRunner::with(
        Arc::new(SystemTreeKiller),
        Arc::new(move |pid| {
            seen_in_hook.store(pid, Ordering::SeqCst);

            Err(io::Error::new(io::ErrorKind::PermissionDenied, "EPERM"))
        }),
    );

    let result = runner.run(fake("exit0")).await.unwrap();

    assert!(seen.load(Ordering::SeqCst) > 0);
    assert_eq!(result.exit_code, Some(0));
}

#[tokio::test]
async fn the_default_priority_hook_works_on_a_live_child() {
    // Not asserted beyond "the run succeeds": lowering the priority of an own child is allowed
    // on every platform, and a failure is ignored by the runner anyway.
    let result = ProcessRunner::new().run(fake("exit0")).await.unwrap();

    assert_eq!(result.exit_code, Some(0));
}

#[tokio::test]
async fn kills_the_tree_through_the_injected_killer_on_timeout() {
    let (runner, recording) = recording_runner();
    let mut input = fake("sleep");
    input.timeout = Duration::from_millis(500);

    let result = runner.run(input).await.unwrap();

    assert!(result.timed_out);
    assert!(!result.aborted);
    #[cfg(unix)]
    {
        assert_eq!(result.exit_code, None);
        assert_eq!(result.signal, Some(9));
    }
    assert_eq!(recording.attached.load(Ordering::SeqCst), 1);
    assert_eq!(recording.killed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn kills_on_cancel_and_does_not_spawn_when_already_cancelled() {
    let (runner, recording) = recording_runner();
    let token = CancellationToken::new();
    let mut input = fake("sleep");
    input.cancel = Some(token.clone());
    let canceller = token.clone();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        canceller.cancel();
    });

    let result = runner.run(input).await.unwrap();

    assert!(result.aborted);
    assert!(!result.timed_out);
    assert_eq!(recording.killed.load(Ordering::SeqCst), 1);

    let mut again =
        RunProcessInput::new("/definitely/not/a/binary", vec![], Duration::from_secs(1));
    again.cancel = Some(token);
    let again = runner.run(again).await.unwrap();

    assert!(again.aborted);
    assert_eq!(again.exit_code, None);
    assert_eq!(recording.attached.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_when_the_binary_cannot_be_started() {
    let error = ProcessRunner::new()
        .run(RunProcessInput::new(
            "/definitely/not/a/binary",
            vec![],
            Duration::from_secs(1),
        ))
        .await
        .unwrap_err();

    assert!(
        error.to_string().starts_with("Failed to start process"),
        "{error}"
    );
}

#[tokio::test]
async fn runs_in_the_given_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut input = fake("exit0");
    input.cwd = Some(dir.path().to_path_buf());

    let result = ProcessRunner::new().run(input).await.unwrap();

    assert_eq!(result.exit_code, Some(0));
}

// ---- process-tree kill (runner.integration.test.ts) ----------------------------------------

/// Starts the parent that spawns a long-running grandchild, and reports the grandchild pid
/// (printed as `GC=<pid>`) through `on_stdout`, which then runs `on_pid`.
fn tree_input(
    timeout: Duration,
    on_pid: impl Fn(u32) + Send + 'static,
) -> (RunProcessInput, Arc<AtomicU32>) {
    let grandchild = Arc::new(AtomicU32::new(0));
    let seen = Arc::clone(&grandchild);
    let buffer = shared_string();
    let mut input = fake("tree_parent");
    input.timeout = timeout;
    input.on_stdout = Some(Box::new(move |chunk| {
        let mut text = buffer.lock().unwrap();
        text.push_str(chunk);

        if seen.load(Ordering::SeqCst) == 0 {
            if let Some(rest) = text.split("GC=").nth(1) {
                if let Some(line) = rest.split('\n').next().filter(|_| rest.contains('\n')) {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        seen.store(pid, Ordering::SeqCst);
                        on_pid(pid);
                    }
                }
            }
        }
    }));

    (input, grandchild)
}

#[tokio::test]
async fn kills_the_child_and_its_grandchild_on_cancel() {
    let token = CancellationToken::new();
    let for_callback = token.clone();
    let (mut input, grandchild) =
        tree_input(Duration::from_secs(60), move |_| for_callback.cancel());
    input.cancel = Some(token);

    let result = ProcessRunner::new().run(input).await.unwrap();
    let pid = grandchild.load(Ordering::SeqCst);

    assert!(result.aborted);
    assert!(pid > 0);
    assert!(wait_dead(pid).await, "grandchild {pid} is still alive");
}

#[tokio::test]
async fn kills_the_whole_tree_on_timeout() {
    let (input, grandchild) = tree_input(Duration::from_millis(2500), |_| ());

    let result = ProcessRunner::new().run_collect(input).await;
    let result = result.unwrap();
    let pid = grandchild.load(Ordering::SeqCst);

    assert!(result.timed_out);
    assert!(pid > 0);
    assert!(wait_dead(pid).await, "grandchild {pid} is still alive");
}

// ---- helpers ------------------------------------------------------------------------------

#[test]
fn splits_lines_like_the_js_regex() {
    assert_eq!(split_lines("a\nb\r\nc\rd"), vec!["a", "b", "c", "d"]);
    assert_eq!(split_lines("a\n"), vec!["a", ""]);
    assert_eq!(split_lines(""), vec![""]);
    assert_eq!(split_lines("a\r\n\r\nb"), vec!["a", "", "b"]);
}

#[test]
fn decodes_utf8_split_across_chunks() {
    let bytes = "h\u{e9}\u{20ac}".as_bytes();
    let mut decoder = Utf8Stream::default();
    let mut out = String::new();

    for byte in bytes {
        out.push_str(&decoder.push(std::slice::from_ref(byte)));
    }

    out.push_str(&decoder.finish());

    assert_eq!(out, "h\u{e9}\u{20ac}");
}

#[test]
fn replaces_invalid_utf8_and_a_truncated_tail() {
    let mut decoder = Utf8Stream::default();

    assert_eq!(decoder.push(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    assert_eq!(decoder.push(&[0xe2, 0x82]), "");
    assert_eq!(decoder.finish(), "\u{FFFD}");
}
