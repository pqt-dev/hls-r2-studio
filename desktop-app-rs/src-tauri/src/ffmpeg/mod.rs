//! ffmpeg layer (port of desktop-app/src/main/ffmpeg): argument builders, probe and progress
//! parsing, binary location, process-tree kill, the process runner and the startup self check.
//!
//! - `args` - pure ffmpeg/ffprobe argument builders and timeouts;
//! - `binaries` - where the executables are (bundled `bin/` when packaged, env/PATH in dev);
//! - `kill_tree` - kill a whole process tree (process group on Unix, Job Object on Windows);
//! - `probe_parse` / `progress` - ffprobe output and `-progress pipe:1` parsers;
//! - `runner` - async spawn with timeout, cancellation, streamed output and a stderr tail;
//! - `errors` - the typed pipeline failure the later pipeline milestone reuses;
//! - `self_check` - startup check of the build (feeds `diagnostics_get`).

// `PipelineError` carries the TS error's resume data (register payload, prefix, temp dir...), so
// it is a few hundred bytes. It only travels on the failure path of a job (a handful of times
// per job), so boxing it everywhere would cost readability for no measurable gain.
#![allow(clippy::result_large_err, clippy::large_enum_variant)]

pub mod args;
pub mod binaries;
pub mod errors;
pub mod file_names;
pub mod kill_tree;
pub mod probe_parse;
pub mod progress;
#[cfg(test)]
mod real_ffmpeg_tests;
pub mod runner;
pub mod self_check;

pub use binaries::{resolve_binaries, Binaries, Platform, ResolveBinariesInput};
pub use runner::{ProcessRunner, RunProcessInput, RunResult};
pub use self_check::{
    check_ffmpeg, run_startup_self_check, FfmpegCheckResult, FfmpegStatus, ProcessTextRunner,
};
