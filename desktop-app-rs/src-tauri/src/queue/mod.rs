//! The job queue (port of desktop-app/src/main/queue, M6): states, scheduling (`maxConcurrent`,
//! FIFO, start gate), persistence of every transition, startup recovery, cancel / retry /
//! retry-register / resume / remove / clear-finished, network-wait flags, throttled push events
//! and the renderer DTO.
//!
//! - `job_queue` - `JobQueue` (concurrency model documented there);
//! - `backend` - the side-effect seams (`QueueBackend`, `QueueContext`) and their real
//!   implementations over the M5 pipeline;
//! - `job_dto` - `JobRecord` -> `JobDto` (no paths, payloads or secrets);
//! - `file_validation` - validation of added files; `states` - state groups / stage keys.

// `PipelineError` is large by design (it carries the register payload); same as `pipeline`/`ffmpeg`.
#![allow(clippy::result_large_err, clippy::large_enum_variant)]

pub mod backend;
#[cfg(test)]
mod concurrency_tests;
pub mod file_validation;
pub mod job_dto;
pub mod job_queue;
#[cfg(test)]
mod smoke_tests;
pub mod states;
#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;

pub use backend::{AppQueueContext, QueueBackend, QueueContext, RealQueueBackend};
pub use file_validation::{FileStat, PathStyle, VIDEO_EXTENSIONS};
pub use job_queue::{
    other_site_message, AddFilesOutcome, JobQueue, JobQueueOptions, DEFAULT_SHUTDOWN_TIMEOUT,
    DEFAULT_THROTTLE,
};

/// A random UUID v4 (`crypto.randomUUID()`), the id of a new job. Only `[0-9a-f-]`, so it
/// passes the IPC job id check.
pub fn generate_job_id() -> String {
    use ring::rand::{SecureRandom, SystemRandom};

    let mut bytes = [0u8; 16];

    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the OS random source is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod id_tests {
    use super::generate_job_id;

    #[test]
    fn job_ids_are_uuid_v4_and_pass_the_ipc_check() {
        let id = generate_job_id();

        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
        assert!(crate::ipc::validate::expect_job_id(Some(&serde_json::json!(id)), "id").is_ok());
        assert_ne!(id, generate_job_id());
    }
}
