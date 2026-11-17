//! Killing a whole process tree. Port of desktop-app/src/main/ffmpeg/killTree.ts, with one
//! deliberate difference on Windows (see below).
//!
//! The runner talks to two small traits, so tests can inject a fake killer:
//!
//! - [`TreeKiller::attach`] is called right after the child was spawned and returns a
//!   [`TreeGuard`] that owns "the tree of this child" for the rest of the run;
//! - [`TreeGuard::kill`] kills the child and all of its descendants (idempotent, never panics).
//!
//! Unix: the child is spawned as the leader of a new process group (`process_group(0)`, so
//! pgid == pid); `kill(-pid, SIGKILL)` reaches the whole group.
//!
//! Windows: the child is assigned to a Job Object created with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. `TerminateJobObject` kills every process in the job
//! (the child's descendants join the job automatically), and because the job handle is owned by
//! this process, Windows also kills the whole tree when the handle is closed, including when the
//! app crashes or is killed (the Electron `taskkill /T /F` approach cannot do that, and it
//! races with PID reuse and with children that re-parent). Dropping the guard after a normal
//! exit closes the handle, which also cleans up stray descendants. If the job cannot be created
//! or the child cannot be assigned (e.g. the process is already in a job that forbids
//! nesting), the guard falls back to the TS behaviour: `taskkill.exe /PID <pid> /T /F`.
//!
//! Known, accepted gap: the child is assigned to the job right after `spawn()` returns, not
//! while suspended; a grandchild created by the child in that few-microsecond window would not
//! be in the job (ffmpeg and ffprobe do not spawn children).

use super::binaries::Platform;

/// The command that kills a tree, as data, so the choice is testable on any host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillPlan {
    /// Windows fallback: run `taskkill /PID <pid> /T /F`.
    Spawn { command: String, args: Vec<String> },
    /// Unix: SIGKILL the process group (the child leads its own group, so pgid = pid). `pid`
    /// is negative, as passed to `kill(2)`.
    SignalGroup { pid: i64, signal: &'static str },
}

/// Absolute path of taskkill.exe, so a planted `taskkill` earlier on PATH / in the cwd is never run.
pub fn taskkill_path(system_root: Option<&str>) -> String {
    let root = system_root.unwrap_or("C:\\Windows").trim_end_matches('\\');

    format!("{root}\\System32\\taskkill.exe")
}

pub fn plan_kill(platform: Platform, pid: u32, system_root: Option<&str>) -> KillPlan {
    match platform {
        Platform::Windows => KillPlan::Spawn {
            command: taskkill_path(system_root),
            args: vec!["/PID".into(), pid.to_string(), "/T".into(), "/F".into()],
        },
        Platform::Other => KillPlan::SignalGroup {
            pid: -i64::from(pid),
            signal: "SIGKILL",
        },
    }
}

/// Owns the tree of one spawned child.
pub trait TreeGuard: Send {
    /// Kills the child and all of its descendants. Never panics; safe to call repeatedly.
    fn kill(&mut self);
}

/// Creates the [`TreeGuard`] of a freshly spawned child.
pub trait TreeKiller: Send + Sync {
    fn attach(&self, pid: u32) -> Box<dyn TreeGuard>;
}

/// The real killer of the current platform (process group on Unix, Job Object on Windows).
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemTreeKiller;

impl TreeKiller for SystemTreeKiller {
    fn attach(&self, pid: u32) -> Box<dyn TreeGuard> {
        #[cfg(unix)]
        {
            Box::new(unix::GroupGuard { pid })
        }
        #[cfg(windows)]
        {
            Box::new(windows::JobGuard::new(pid))
        }
        #[cfg(not(any(unix, windows)))]
        {
            Box::new(NoopGuard { pid })
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct NoopGuard {
    #[allow(dead_code)]
    pid: u32,
}

#[cfg(not(any(unix, windows)))]
impl TreeGuard for NoopGuard {
    fn kill(&mut self) {}
}

#[cfg(unix)]
mod unix {
    use super::TreeGuard;

    pub struct GroupGuard {
        pub pid: u32,
    }

    impl TreeGuard for GroupGuard {
        fn kill(&mut self) {
            let Ok(pid) = i32::try_from(self.pid) else {
                return;
            };

            // SAFETY: plain syscall with integer arguments. A failure (ESRCH: the group is
            // already gone) needs no handling.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(windows)]
pub(crate) mod windows {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    use super::{plan_kill, KillPlan, TreeGuard};
    use crate::ffmpeg::binaries::Platform;

    /// `CREATE_NO_WINDOW`: no console window for console children of a GUI process.
    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// An owned Win32 handle (closed on drop).
    pub struct OwnedHandle(pub HANDLE);

    // SAFETY: a kernel object handle may be used and closed from any thread.
    unsafe impl Send for OwnedHandle {}

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle is valid (non-null) and closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn open_process(pid: u32, access: u32) -> Option<OwnedHandle> {
        // SAFETY: plain call; a null result means failure.
        let handle = unsafe { OpenProcess(access, 0, pid) };

        (!handle.is_null()).then_some(OwnedHandle(handle))
    }

    /// Creates a kill-on-close job and puts `pid` into it.
    fn create_job_with(pid: u32) -> Option<OwnedHandle> {
        // SAFETY: all pointers are valid for the duration of each call; the struct is plain
        // data for which all-zero is a valid value.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());

            if job.is_null() {
                return None;
            }

            let job = OwnedHandle(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let configured = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            if configured == 0 {
                return None;
            }

            let process = open_process(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE)?;

            (AssignProcessToJobObject(job.0, process.0) != 0).then_some(job)
        }
    }

    pub struct JobGuard {
        pid: u32,
        job: Option<OwnedHandle>,
    }

    impl JobGuard {
        pub fn new(pid: u32) -> Self {
            Self {
                pid,
                job: create_job_with(pid),
            }
        }
    }

    impl TreeGuard for JobGuard {
        fn kill(&mut self) {
            if let Some(job) = &self.job {
                // SAFETY: the job handle is valid while `self.job` is `Some`.
                unsafe {
                    TerminateJobObject(job.0, 1);
                }

                return;
            }

            // Fallback (no job): `taskkill /PID <pid> /T /F`, like the Electron app.
            let system_root = std::env::var("SystemRoot").ok();

            if let KillPlan::Spawn { command, args } =
                plan_kill(Platform::Windows, self.pid, system_root.as_deref())
            {
                let _ = Command::new(command)
                    .args(args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_taskkill_t_f_on_windows() {
        assert_eq!(
            plan_kill(Platform::Windows, 4321, Some("D:\\WINNT")),
            KillPlan::Spawn {
                command: "D:\\WINNT\\System32\\taskkill.exe".into(),
                args: vec!["/PID".into(), "4321".into(), "/T".into(), "/F".into()],
            }
        );
    }

    #[test]
    fn falls_back_to_c_windows_when_system_root_is_not_set() {
        match plan_kill(Platform::Windows, 1, None) {
            KillPlan::Spawn { command, .. } => {
                assert_eq!(command, "C:\\Windows\\System32\\taskkill.exe");
            }
            other => panic!("unexpected plan {other:?}"),
        }
    }

    #[test]
    fn signals_the_negative_pid_process_group_on_other_platforms() {
        assert_eq!(
            plan_kill(Platform::Other, 4321, None),
            KillPlan::SignalGroup {
                pid: -4321,
                signal: "SIGKILL"
            }
        );
    }
}
