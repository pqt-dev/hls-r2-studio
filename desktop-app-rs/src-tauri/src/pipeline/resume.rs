//! Resumes an upload that ended as `upload_interrupted` (port of resumeUpload.ts): the temp dir
//! (kept by `run_pipeline`) and the persisted register payload are enough, so nothing is
//! transcoded again. Only the objects that are missing on R2 (or have a different size) are
//! uploaded, the playlist last, then the video is registered like at the end of `run_pipeline`.
//!
//! The queue reads the inputs from the job record of `store.json` (`registerPayload`,
//! `publicId`; the temp dir is `<tmp_root>/<publicId>`, see `JobRecord::register_payload_typed`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::api::AppConfig;
use crate::dto::JobState;
use crate::ffmpeg::errors::{
    cancelled_error, scrub_paths, upload_interrupted_error, PipelineError, PipelineErrorKind,
    RESUME_UNAVAILABLE,
};
use crate::pipeline::deps::{ClientPurpose, ObjectStore};
use crate::pipeline::fault::{classify, Fault};
use crate::pipeline::file_names::{storyboard_file_name, PLAYLIST_FILE, THUMBNAIL_FILE};
use crate::pipeline::job_dir::{job_dir_path, remove_job_dir, same_path};
use crate::pipeline::progress_model::PipelineStage;
use crate::pipeline::register::{validate_register_payload, RegisterPayload};
use crate::pipeline::run::{
    cleanup_uploaded, register_with_retry, NetworkHooksOf, PipelineDeps, PipelineHooks,
    PipelineResult, Reporter,
};
use crate::pipeline::steps::upload::{upload_files, UploadContext};
use crate::pipeline::upload::classify_error::{classify_upload_error, UploadErrorClass};
use crate::pipeline::upload::plan::progress_from_uploaded;

pub const RESUME_UNAVAILABLE_MESSAGE: &str =
    "The temporary files for this video are gone, so it cannot be resumed. Retry to process it again.";

#[derive(Debug, Clone, PartialEq)]
pub struct ResumeUploadInput {
    pub job_id: String,
    pub public_id: String,
    /// The register payload persisted through `on_before_upload` (or `upload_interrupted`).
    pub payload: RegisterPayload,
    /// The temp dir kept by the interrupted run.
    pub tmp_dir: PathBuf,
}

fn resume_unavailable(prefix: &str) -> PipelineError {
    let mut error = PipelineError::new(
        PipelineErrorKind::Failed,
        JobState::Uploading,
        RESUME_UNAVAILABLE_MESSAGE,
    )
    .with_prefix(prefix);

    error.code = Some(RESUME_UNAVAILABLE.to_string());
    error
}

/// Segment file names referenced by a playlist (lines ending with `.ts`, comments skipped),
/// first occurrence order, no duplicates.
pub fn parse_playlist_segments(playlist: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();

    for line in playlist.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line).trim();

        if !line.is_empty()
            && !line.starts_with('#')
            && line.ends_with(".ts")
            && !names.iter().any(|n| n == line)
        {
            names.push(line.to_string());
        }
    }

    names
}

/// The TS `samePath`: both resolved (lexically, `.` / `..` collapsed); case-insensitive on
/// Windows.
fn same_resolved_path(a: &Path, b: &Path) -> bool {
    fn resolve(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();

        for component in path.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }

        out
    }

    same_path(&resolve(a), &resolve(b))
}

struct LocalPlan {
    /// Every file of the video, playlist last.
    names: Vec<String>,
    sizes: HashMap<String, u64>,
}

/// Checks that every file the payload and the playlist refer to still exists in the temp dir.
async fn plan_local_files(
    payload: &RegisterPayload,
    tmp_dir: &Path,
) -> Result<LocalPlan, PipelineError> {
    let unavailable = || resume_unavailable(&payload.disk_prefix);
    let playlist = tokio::fs::read(tmp_dir.join(PLAYLIST_FILE))
        .await
        .map_err(|_| unavailable())?;
    let playlist = String::from_utf8_lossy(&playlist);
    let segments = parse_playlist_segments(&playlist);

    if segments.is_empty() || segments.iter().any(|n| n.contains(['/', '\\'])) {
        return Err(unavailable());
    }

    let storyboards = payload
        .storyboards
        .iter()
        .flat_map(|map| map.keys())
        .filter_map(|key| key.split('x').next()?.parse::<u32>().ok())
        .map(storyboard_file_name);
    let mut names: Vec<String> = segments;

    if payload.thumbnail_path.is_some() {
        names.push(THUMBNAIL_FILE.to_string());
    }

    names.extend(storyboards);
    names.push(PLAYLIST_FILE.to_string());

    let mut sizes = HashMap::new();

    for name in &names {
        match tokio::fs::metadata(tmp_dir.join(name)).await {
            Ok(meta) if meta.is_file() => {
                sizes.insert(name.clone(), meta.len());
            }
            _ => return Err(unavailable()),
        }
    }

    Ok(LocalPlan { names, sizes })
}

/// Object name -> size of everything under the prefix (ListObjectsV2, all pages).
async fn list_remote_sizes(
    store: &dyn ObjectStore,
    bucket: &str,
    prefix: &str,
    cancel: &CancellationToken,
) -> Result<HashMap<String, Option<u64>>, crate::pipeline::deps::StoreError> {
    let mut sizes = HashMap::new();
    let mut token: Option<String> = None;

    loop {
        let page = store
            .list_page(bucket, prefix, None, token.as_deref(), Some(cancel))
            .await?;

        for object in &page.objects {
            if let Some(name) = object.key.strip_prefix(prefix) {
                sizes.insert(name.to_string(), object.size);
            }
        }

        token = page.next_token;

        if token.is_none() {
            return Ok(sizes);
        }
    }
}

/// Continues a paused upload and registers the video. Never transcodes. On failure the R2
/// prefix is deleted only for `failed` / `cancelled` (the same rules as `run_pipeline`), and
/// nothing at all is deleted when the stored data is invalid or the temp files are gone.
pub async fn resume_upload(
    input: &ResumeUploadInput,
    config: &AppConfig,
    deps: &PipelineDeps,
    hooks: Arc<dyn PipelineHooks>,
    cancel: &CancellationToken,
) -> Result<PipelineResult, PipelineError> {
    let payload = &input.payload;

    // Nothing below this guard may delete anything: the caller falls back to a fresh retry.
    if !validate_register_payload(payload).is_empty() || payload.public_id != input.public_id {
        deps.logger
            .error("Stored register payload is invalid.", None);

        return Err(PipelineError::new(
            PipelineErrorKind::Failed,
            JobState::Uploading,
            "The stored video data is invalid, so the upload cannot be resumed.",
        )
        .with_prefix(&payload.disk_prefix));
    }

    // The temp dir is deleted on success: only ever touch the dir run_pipeline would have made.
    // From here on that exact path is used (not the caller's spelling of it).
    let tmp_dir = job_dir_path(&deps.tmp_root, &input.public_id);

    if !same_resolved_path(&input.tmp_dir, &tmp_dir) {
        return Err(resume_unavailable(&payload.disk_prefix));
    }

    let plan = plan_local_files(payload, &tmp_dir).await?;
    let mut step = JobState::Uploading;
    let outcome = execute(
        input, &tmp_dir, config, deps, &hooks, cancel, &plan, &mut step,
    )
    .await;

    match outcome {
        Ok(result) => {
            remove_job_dir(&deps.tmp_root, Some(&tmp_dir), &*deps.logger).await;

            Ok(result)
        }
        Err(fault) => {
            let mut failure = classify(fault, step, cancel, &*deps.logger);

            if failure.kind == PipelineErrorKind::UploadInterrupted {
                failure.register_payload = Some(payload.clone());
                failure.tmp_dir = Some(tmp_dir.clone());
                failure.resumable = true;
            } else {
                // The R2 objects of this prefix (also those of the earlier run) are useless now.
                if matches!(
                    failure.kind,
                    PipelineErrorKind::Failed | PipelineErrorKind::Cancelled
                ) {
                    cleanup_uploaded(&config.r2, deps, &payload.disk_prefix).await;
                }

                remove_job_dir(&deps.tmp_root, Some(&tmp_dir), &*deps.logger).await;
            }

            failure.prefix = Some(payload.disk_prefix.clone());
            failure.stderr_tail = scrub_paths(
                &failure.stderr_tail,
                &[
                    (tmp_dir.to_string_lossy().into_owned(), "<job-dir>"),
                    (deps.tmp_root.to_string_lossy().into_owned(), "<tmp-root>"),
                ],
            );

            Err(failure)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute(
    input: &ResumeUploadInput,
    tmp_dir: &Path,
    config: &AppConfig,
    deps: &PipelineDeps,
    hooks: &Arc<dyn PipelineHooks>,
    cancel: &CancellationToken,
    plan: &LocalPlan,
    step: &mut JobState,
) -> Result<PipelineResult, Fault> {
    let payload = &input.payload;
    let prefix = payload.disk_prefix.clone();
    let reporter = Reporter::new(Arc::clone(hooks));

    if cancel.is_cancelled() {
        return Err(cancelled_error(JobState::Uploading).into());
    }

    hooks.on_stage(JobState::Uploading);
    reporter.report(PipelineStage::Upload, 0.0);

    // ---- which objects are already on R2 ----
    let remote = list_remote(input, config, deps, cancel).await?;
    let missing: Vec<String> = plan
        .names
        .iter()
        .filter(|name| {
            *name != PLAYLIST_FILE
                && remote.get(*name).copied().flatten() != plan.sizes.get(*name).copied()
        })
        .cloned()
        .collect();
    let skipped = plan.names.len() - 1 - missing.len();

    reporter.report(
        PipelineStage::Upload,
        progress_from_uploaded(skipped as i64, plan.names.len() as i64),
    );

    // ---- upload the rest, playlist always last (even when it exists already) ----
    let client = deps
        .object_stores
        .create(&config.r2, ClientPurpose::Upload)
        .map_err(|e| Fault::Other(format!("could not create the R2 client: {e}")))?;
    let on_progress = {
        let reporter = Arc::clone(&reporter);

        Arc::new(move |fraction: f64| reporter.report(PipelineStage::Upload, fraction))
    };
    let mut files = missing;

    files.push(PLAYLIST_FILE.to_string());
    upload_files(
        UploadContext {
            store: client,
            bucket: config.r2.bucket.clone(),
            prefix: prefix.clone(),
            dir: tmp_dir.to_path_buf(),
            cancel: cancel.clone(),
            sleeper: Arc::clone(&deps.sleeper),
            logger: Arc::clone(&deps.logger),
            on_progress,
            on_upload_started: Arc::new(|| ()),
            network: Arc::new(NetworkHooksOf(Arc::clone(hooks))),
            tuning: deps.upload_tuning.clone(),
        },
        files,
        plan.sizes.clone(),
        plan.names.len(),
        skipped,
    )
    .await?;

    // ---- register ----
    *step = JobState::Registering;
    hooks.on_stage(JobState::Registering);
    reporter.report(PipelineStage::Register, 0.0);
    hooks.on_before_register().await.map_err(Fault::Io)?;

    let registered = register_with_retry(payload, deps, cancel).await?;

    reporter.report(PipelineStage::Register, 1.0);

    Ok(PipelineResult {
        registered,
        prefix,
        payload: payload.clone(),
    })
}

async fn list_remote(
    input: &ResumeUploadInput,
    config: &AppConfig,
    deps: &PipelineDeps,
    cancel: &CancellationToken,
) -> Result<HashMap<String, Option<u64>>, Fault> {
    let listed = match deps
        .object_stores
        .create(&config.r2, ClientPurpose::Cleanup)
    {
        Ok(client) => {
            list_remote_sizes(
                &*client,
                &config.r2.bucket,
                &input.payload.disk_prefix,
                cancel,
            )
            .await
        }
        Err(error) => Err(error),
    };
    let error = match listed {
        Ok(sizes) => return Ok(sizes),
        Err(error) => error,
    };

    if cancel.is_cancelled() {
        return Err(cancelled_error(JobState::Uploading).into());
    }

    deps.logger.warn(
        "Listing the uploaded objects failed.",
        Some(json!({ "error": error.to_string() })),
    );

    // Still offline: keep everything so the user can resume again later.
    if classify_upload_error(&error, Some(cancel)) == UploadErrorClass::Network {
        return Err(upload_interrupted_error().into());
    }

    Err(PipelineError::new(
        PipelineErrorKind::Failed,
        JobState::Uploading,
        "Could not read the uploaded files from R2. Check the R2 settings and your connection.",
    )
    .with_cause(&error)
    .into())
}

#[cfg(test)]
#[path = "resume_tests.rs"]
mod tests;
