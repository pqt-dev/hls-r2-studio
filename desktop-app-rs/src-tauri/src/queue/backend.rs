//! The queue's seams (the `JobQueueOptions` functions of the TS queue): everything with a side
//! effect goes through `QueueBackend`, everything the queue reads about the session goes through
//! `QueueContext`. Tests use fakes (`queue/testing.rs`); the app uses the real implementations
//! below.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::file_validation::FileStat;
use crate::api::AppConfig;
use crate::auth::AuthService;
use crate::config::ConfigService;
use crate::dto::AuthState;
use crate::ffmpeg::errors::PipelineError;
use crate::ffmpeg::{Binaries, FfmpegStatus};
use crate::logger::Log;
use crate::pipeline::deps::{ClientPurpose, ObjectStoreFactory};
use crate::pipeline::job_dir::{job_dir_path, remove_job_dir_checked};
use crate::pipeline::register::{RegisterClient, RegisterPayload};
use crate::pipeline::resume::{resume_upload, ResumeUploadInput};
use crate::pipeline::run::{
    retry_register, run_pipeline, PipelineDeps, PipelineHooks, PipelineJob, PipelineResult,
};
use crate::pipeline::s3::R2ClientFactory;
use crate::pipeline::steps::cleanup::delete_r2_prefix;
use crate::secure::{TokenStore, TokenVault};
use crate::store::AppStore;

pub type RunOutcome = Result<PipelineResult, PipelineError>;

/// Side effects of the queue.
#[async_trait]
pub trait QueueBackend: Send + Sync {
    /// `runPipeline` with fresh deps for `tmp_root`.
    async fn run_pipeline(
        &self,
        job: PipelineJob,
        config: AppConfig,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome;

    /// `retryRegister` (register only, no upload).
    async fn retry_register(
        &self,
        payload: RegisterPayload,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome;

    /// `resumeUpload` of a paused upload (never transcodes).
    async fn resume_upload(
        &self,
        input: ResumeUploadInput,
        config: AppConfig,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome;

    /// Deletes an R2 prefix with a cleanup client (`deletePrefixFn`). An `Err` is only logged.
    async fn delete_prefix(&self, config: &AppConfig, prefix: &str) -> Result<(), String>;

    /// `fs.stat` (links followed).
    async fn stat(&self, path: &str) -> io::Result<FileStat>;

    /// Removes `<tmp_root>/<public_id>` through the safe job-dir API (never anything else).
    async fn remove_job_dir(&self, tmp_root: &Path, public_id: &str) -> Result<(), String>;

    /// Writes pending store changes to disk (`store.flush()`).
    async fn flush_store(&self);
}

/// What the queue reads about the session and the environment.
pub trait QueueContext: Send + Sync {
    fn auth_state(&self) -> AuthState;
    /// True while a token exists (together with `signed_in` it is required to start jobs).
    fn has_session(&self) -> bool;
    /// Latest site config (RAM only), `None` while signed out / not configured.
    fn config(&self) -> Option<AppConfig>;
    /// A text that blocks starting jobs (e.g. the ffmpeg self check failed), or `None`.
    fn start_block(&self) -> Option<String>;
}

// ---- real implementations ----------------------------------------------------------------

pub const CHECKING_TOOLS: &str = "Checking the video tools...";
pub const TOOLS_MISSING: &str =
    "The bundled video tools (ffmpeg) are missing or incomplete, so videos cannot be processed.";

/// The start block of index.ts: nothing starts before the ffmpeg self check passed.
pub fn ffmpeg_start_block(status: &FfmpegStatus) -> Option<String> {
    let diagnostics = status.get();

    if !diagnostics.checked {
        Some(CHECKING_TOOLS.to_string())
    } else if !diagnostics.ok {
        Some(TOOLS_MISSING.to_string())
    } else {
        None
    }
}

pub struct AppQueueContext {
    pub auth: Arc<AuthService>,
    pub vault: Arc<TokenVault>,
    pub config: Arc<ConfigService>,
    pub ffmpeg: Arc<FfmpegStatus>,
}

impl QueueContext for AppQueueContext {
    fn auth_state(&self) -> AuthState {
        self.auth.get_state()
    }

    fn has_session(&self) -> bool {
        self.vault.get().is_some()
    }

    fn config(&self) -> Option<AppConfig> {
        self.config.get_config()
    }

    fn start_block(&self) -> Option<String> {
        ffmpeg_start_block(&self.ffmpeg)
    }
}

pub struct RealQueueBackend {
    pub store: Arc<AppStore>,
    pub binaries: Binaries,
    pub register: Arc<dyn RegisterClient>,
    pub logger: Arc<dyn Log>,
    pub object_stores: Arc<dyn ObjectStoreFactory>,
}

impl RealQueueBackend {
    pub fn new(
        store: Arc<AppStore>,
        binaries: Binaries,
        register: Arc<dyn RegisterClient>,
        logger: Arc<dyn Log>,
    ) -> Self {
        Self {
            store,
            binaries,
            register,
            logger,
            object_stores: Arc::new(R2ClientFactory::new()),
        }
    }

    /// Fresh deps per run so a changed temp folder applies to the next job.
    fn deps(&self, tmp_root: PathBuf) -> PipelineDeps {
        let mut deps = PipelineDeps::real(
            self.binaries.clone(),
            tmp_root,
            Arc::clone(&self.register),
            Arc::clone(&self.logger),
            None,
        );

        deps.object_stores = Arc::clone(&self.object_stores);
        deps
    }
}

#[async_trait]
impl QueueBackend for RealQueueBackend {
    async fn run_pipeline(
        &self,
        job: PipelineJob,
        config: AppConfig,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        run_pipeline(&job, &config, &self.deps(tmp_root), hooks, &cancel).await
    }

    async fn retry_register(
        &self,
        payload: RegisterPayload,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        retry_register(&payload, &self.deps(tmp_root), hooks, &cancel).await
    }

    async fn resume_upload(
        &self,
        input: ResumeUploadInput,
        config: AppConfig,
        tmp_root: PathBuf,
        hooks: Arc<dyn PipelineHooks>,
        cancel: CancellationToken,
    ) -> RunOutcome {
        resume_upload(&input, &config, &self.deps(tmp_root), hooks, &cancel).await
    }

    async fn delete_prefix(&self, config: &AppConfig, prefix: &str) -> Result<(), String> {
        let client = self
            .object_stores
            .create(&config.r2, ClientPurpose::Cleanup)
            .map_err(|error| error.to_string())?;
        let result =
            delete_r2_prefix(&*client, &config.r2.bucket, prefix, Some(&*self.logger)).await;

        if !result.ok {
            self.logger.warn(
                "R2 cleanup did not finish",
                Some(json!({ "deleted": result.deleted })),
            );
        }

        Ok(())
    }

    async fn stat(&self, path: &str) -> io::Result<FileStat> {
        let meta = tokio::fs::metadata(path).await?;

        Ok(FileStat {
            is_file: meta.is_file(),
            size: meta.len(),
        })
    }

    async fn remove_job_dir(&self, tmp_root: &Path, public_id: &str) -> Result<(), String> {
        remove_job_dir_checked(tmp_root, &job_dir_path(tmp_root, public_id))
            .await
            .map_err(|error| error.to_string())
    }

    async fn flush_store(&self) {
        let store = Arc::clone(&self.store);

        // `flush` blocks until the file is written: keep it off the async workers.
        let _ = tokio::task::spawn_blocking(move || store.flush()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::FfmpegDiagnostics;

    #[test]
    fn ffmpeg_gate_texts() {
        let status = FfmpegStatus::new();

        assert_eq!(ffmpeg_start_block(&status).as_deref(), Some(CHECKING_TOOLS));

        status.set(FfmpegDiagnostics {
            checked: true,
            ok: false,
            version: None,
            missing: vec!["ffmpeg:version".into()],
        });
        assert_eq!(ffmpeg_start_block(&status).as_deref(), Some(TOOLS_MISSING));

        status.set(FfmpegDiagnostics {
            checked: true,
            ok: true,
            version: Some("7".into()),
            missing: vec![],
        });
        assert_eq!(ffmpeg_start_block(&status), None);
    }

    #[tokio::test]
    async fn real_backend_removes_only_the_job_dir_and_stats_files() {
        let root = tempfile::tempdir().unwrap();
        let tmp_root = root.path().join("hls");
        let job = tmp_root.join("aaaaaaaaaaaa");
        let source = root.path().join("source.mp4");

        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(job.join("seg.ts"), b"x").unwrap();
        std::fs::write(&source, b"video").unwrap();

        let backend = RealQueueBackend::new(
            Arc::new(crate::store::testing::create_memory_store("/tmp/hls")),
            Binaries {
                ffmpeg: "ffmpeg".into(),
                ffprobe: "ffprobe".into(),
            },
            crate::pipeline::testing::fakes::FakeRegister::ok(),
            Arc::new(crate::logger::testing::RecordingLogger::default()),
        );

        let stat = backend.stat(source.to_str().unwrap()).await.unwrap();
        assert_eq!(
            stat,
            FileStat {
                is_file: true,
                size: 5
            }
        );
        assert!(
            !backend
                .stat(root.path().to_str().unwrap())
                .await
                .unwrap()
                .is_file
        );

        // An invalid public id is refused; nothing is touched.
        assert!(backend.remove_job_dir(&tmp_root, "../hls").await.is_err());
        assert!(job.is_dir());

        backend
            .remove_job_dir(&tmp_root, "aaaaaaaaaaaa")
            .await
            .unwrap();
        assert!(!job.exists());
        assert!(source.is_file());
    }
}
