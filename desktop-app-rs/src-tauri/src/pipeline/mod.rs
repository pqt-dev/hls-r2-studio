//! The job pipeline (port of desktop-app/src/main/pipeline). M4a: the pure utilities and the
//! non-upload steps; M5: the R2 client, the upload step, the resumable upload and the
//! orchestrator. The job queue / IPC wiring comes with M6; nothing here is a Tauri command yet.
//!
//! - `run` - `run_pipeline` (the orchestrator), `retry_register`, `PipelineDeps`, the hooks;
//! - `resume` - `resume_upload` of an `upload_interrupted` job (no transcoding);
//! - `s3` - SigV4 + the R2 client (`ObjectStore` over reqwest); `upload` - upload plan and
//!   error classification; `job_dir` - creation and safe removal of the job temp directory;
//!   `fault` - mapping of any failure to a `PipelineError`;
//! - `slug` / `ascii_table` - PHP `Str::slug`-compatible slug (table generated from Laravel);
//! - `public_id`, `prefix`, `file_names`, `progress_model`, `pool` - small pure helpers;
//! - `thumbnail_plan`, `storyboard_plan` - pure planning/ranking of frames;
//! - `register` - register payload, validation, error mapping and the `RegisterClient` trait
//!   (the HTTP call is `SiteClient::register`);
//! - `deps` - the traits steps depend on (process runner, filesystem, clock, object store) so
//!   tests use fakes;
//! - `steps` - probe, transcode, thumbnail, storyboard, upload, cleanup, image size.

// `PipelineError` carries the TS error's resume data (register payload, prefix, temp dir...), so
// it is a few hundred bytes. It only travels on the failure path of a job (a handful of times
// per job), so boxing it everywhere would cost readability for no measurable gain.
#![allow(clippy::result_large_err, clippy::large_enum_variant)]

pub mod ascii_table;
pub mod deps;
pub mod fault;
pub mod file_names;
pub mod job_dir;
pub mod pool;
pub mod prefix;
pub mod progress_model;
pub mod public_id;
#[cfg(test)]
mod real_pipeline_tests;
pub mod register;
pub mod resume;
pub mod run;
pub mod s3;
pub mod slug;
pub mod steps;
pub mod storyboard_plan;
#[cfg(test)]
pub mod testing;
pub mod thumbnail_plan;
pub mod upload;
