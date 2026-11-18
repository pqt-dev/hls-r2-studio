//! Application state shared with Tauri commands (managed state). Everything inside is
//! thread-safe: the store and logger use internal locks.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use tokio::runtime::Handle;

use serde_json::json;

use crate::api::video_links::VideoLinkCache;
use crate::api::{user_agent, SiteClient, SiteClientOptions, DEFAULT_TIMEOUT};
use crate::auth::{AuthService, AuthServiceOptions};
use crate::config::ConfigService;
use crate::ffmpeg::{Binaries, FfmpegStatus};
use crate::logger::{error_to_value, FileLogger, FileLoggerOptions, Log};
use crate::pipeline::deps::SystemClock;
use crate::pipeline::public_id::generate_public_id;
use crate::queue::backend::{AppQueueContext, RealQueueBackend};
use crate::queue::{
    generate_job_id, JobQueue, JobQueueOptions, PathStyle, DEFAULT_SHUTDOWN_TIMEOUT,
    DEFAULT_THROTTLE,
};
use crate::secure::{default_backend, SecureBackend, TokenStore, TokenVault};
use crate::settings::{
    built_in_site_url, ensure_dir_writable, store_has_paused_uploads, SettingsService,
    SettingsServiceOptions, BUILT_IN_SITE_URL,
};
use crate::store::{create_app_store, AppStore, AppStoreOptions};

/// Name of the user data folder. The Electron app uses `app.getPath('userData')`, which is
/// `<appData>/<productName>`; keeping the same folder lets this app read the Electron app's data.
/// (Tauri's own `app_data_dir()` would be `<appData>/<identifier>`, a different, empty folder.)
pub const USER_DATA_DIR_NAME: &str = "HLS R2 Studio";

/// `<config dir>/HLS R2 Studio` (Windows: `%APPDATA%\HLS R2 Studio`, macOS:
/// `~/Library/Application Support/HLS R2 Studio`).
pub fn user_data_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(USER_DATA_DIR_NAME)
}

pub fn logs_dir(user_data: &Path) -> PathBuf {
    user_data.join("logs")
}

/// `<temp dir>/hls-r2-studio`: the default temporary root.
pub fn default_tmp_root() -> String {
    std::env::temp_dir()
        .join("hls-r2-studio")
        .to_string_lossy()
        .into_owned()
}

/// The built-in site origin, `None` when this build has none.
fn built_in_site() -> Option<String> {
    Some(built_in_site_url(BUILT_IN_SITE_URL)).filter(|url| !url.is_empty())
}

fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

pub struct AppState {
    pub user_data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub logger: Arc<FileLogger>,
    pub store: Arc<AppStore>,
    pub settings: SettingsService,
    /// API token (`<user data>/token.dpapi` on Windows; memory only elsewhere).
    pub vault: Arc<TokenVault>,
    pub site_client: Arc<SiteClient>,
    /// Site config (R2 credentials) in memory only.
    pub config: Arc<ConfigService>,
    pub auth: Arc<AuthService>,
    /// Result of the startup ffmpeg self check (`checked: false` until it has finished).
    pub ffmpeg: Arc<FfmpegStatus>,
    /// The job queue. It is wired to the auth state / the ffmpeg check / the settings in lib.rs.
    pub queue: Arc<JobQueue>,
    /// What the video list and detail returned, for instant Copy / Open (cleared on sign-out).
    pub video_links: Arc<VideoLinkCache>,
}

impl AppState {
    /// Opens the logger and the store (loading `store.json`) and builds the settings, token,
    /// site API, config and auth services. The session is restored later (`AuthService::restore`).
    pub fn init(user_data_dir: PathBuf, binaries: Binaries, runtime: Handle) -> Self {
        Self::init_with_backend(user_data_dir, default_backend(), binaries, runtime)
    }

    /// `runtime` is where job runs, cleanups and throttle timers are spawned.
    pub fn init_with_backend(
        user_data_dir: PathBuf,
        backend: Arc<dyn SecureBackend>,
        binaries: Binaries,
        runtime: Handle,
    ) -> Self {
        let logs_dir = logs_dir(&user_data_dir);
        let logger = Arc::new(FileLogger::new(FileLoggerOptions::new(logs_dir.clone())));
        let on_error_logger = Arc::clone(&logger);

        let store = Arc::new(create_app_store(AppStoreOptions {
            dir: user_data_dir.clone(),
            default_tmp_root: default_tmp_root(),
            debounce: None,
            file_ops: None,
            on_error: Some(Arc::new(move |error| {
                on_error_logger.error(
                    "Store write failed",
                    Some(json!({ "error": error_to_value(error) })),
                );
            })),
        }));

        store.load();

        // The queue is built after the settings service but the settings need it (active jobs,
        // `kick` after a change): they reach it through this slot, filled below.
        let queue_slot: Arc<OnceLock<Weak<JobQueue>>> = Arc::new(OnceLock::new());
        let paused_store = Arc::clone(&store);
        let active_slot = Arc::clone(&queue_slot);
        let changed_slot = Arc::clone(&queue_slot);
        let settings = SettingsService::new(SettingsServiceOptions {
            store: Arc::clone(&store),
            get_site_url: Box::new(|| built_in_site_url(BUILT_IN_SITE_URL)),
            has_active_jobs: Box::new(move || {
                active_slot
                    .get()
                    .and_then(Weak::upgrade)
                    .is_some_and(|queue| queue.has_active_jobs())
            }),
            has_paused_uploads: Some(Box::new(move || store_has_paused_uploads(&paused_store))),
            is_absolute_path: None,
            ensure_dir: Box::new(ensure_dir_writable),
            on_changed: Box::new(move || {
                if let Some(queue) = changed_slot.get().and_then(Weak::upgrade) {
                    queue.kick();
                }
            }),
        });

        // ---- site API, auth, config (index.ts wiring) ----
        // The site is fixed at build time (HLS_SITE_URL); nothing at runtime can change it.
        let site_url = built_in_site();

        if site_url.is_none() {
            logger.error("No valid built-in site URL; sign-in is disabled", None);
        }

        let vault = Arc::new(TokenVault::new(user_data_dir.clone(), backend));
        // The client reports 401s to the auth service, which is built after it.
        let auth_slot: Arc<OnceLock<Weak<AuthService>>> = Arc::new(OnceLock::new());
        let site_client = Arc::new(SiteClient::new(SiteClientOptions {
            get_base_url: {
                let site_url = site_url.clone().unwrap_or_default();
                Arc::new(move || site_url.clone())
            },
            get_token: {
                let vault = Arc::clone(&vault);
                Arc::new(move || vault.get())
            },
            user_agent: user_agent(env!("CARGO_PKG_VERSION")),
            timeout: DEFAULT_TIMEOUT,
            on_unauthorized: {
                let auth_slot = Arc::clone(&auth_slot);
                Some(Arc::new(move || {
                    if let Some(auth) = auth_slot.get().and_then(Weak::upgrade) {
                        auth.handle_unauthorized();
                    }
                }))
            },
            logger: Some(logger.clone() as Arc<dyn Log>),
        }));
        let config = Arc::new(ConfigService::new(site_client.clone()));
        let auth = Arc::new(AuthService::new(AuthServiceOptions {
            client: site_client.clone(),
            vault: vault.clone(),
            store: Arc::clone(&store),
            config: Arc::clone(&config),
            hostname: Box::new(hostname),
            site_url,
            logger: logger.clone(),
        }));
        let _ = auth_slot.set(Arc::downgrade(&auth));

        // Remembered links are dropped whenever the session ends (logout, 401, expired session).
        let video_links = Arc::new(VideoLinkCache::default());
        let cache_to_clear = Arc::clone(&video_links);
        auth.on_signed_out(Arc::new(move || cache_to_clear.clear()));

        // ---- queue (index.ts wiring) ----
        let ffmpeg = Arc::new(FfmpegStatus::new());
        let queue = JobQueue::new(JobQueueOptions {
            store: Arc::clone(&store),
            backend: Arc::new(RealQueueBackend::new(
                Arc::clone(&store),
                binaries,
                site_client.clone(),
                logger.clone(),
            )),
            context: Arc::new(AppQueueContext {
                auth: Arc::clone(&auth),
                vault: Arc::clone(&vault),
                config: Arc::clone(&config),
                ffmpeg: Arc::clone(&ffmpeg),
            }),
            clock: Arc::new(SystemClock),
            generate_id: Box::new(generate_job_id),
            generate_public_id: Box::new(generate_public_id),
            path_style: PathStyle::native(),
            logger: logger.clone(),
            runtime,
            throttle: DEFAULT_THROTTLE,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        });
        let _ = queue_slot.set(Arc::downgrade(&queue));

        Self {
            user_data_dir,
            logs_dir,
            logger,
            store,
            settings,
            vault,
            site_client,
            config,
            auth,
            ffmpeg,
            queue,
            video_links,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_data_dir_matches_the_electron_folder_name() {
        assert_eq!(
            user_data_dir(Path::new("/cfg")),
            Path::new("/cfg").join("HLS R2 Studio")
        );
        assert_eq!(logs_dir(Path::new("/u")), Path::new("/u").join("logs"));
    }

    fn no_binaries() -> Binaries {
        Binaries {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
        }
    }

    #[tokio::test]
    async fn init_loads_an_electron_store_and_logs_next_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let user_data = user_data_dir(dir.path());
        std::fs::create_dir_all(&user_data).unwrap();
        std::fs::write(
            user_data.join("store.json"),
            r#"{"schemaVersion":1,"settings":{"siteUrl":"","tmpRoot":"/x","maxConcurrent":2},"jobs":[]}"#,
        )
        .unwrap();

        let state = AppState::init(user_data.clone(), no_binaries(), Handle::current());
        state.logger.info("hello", None);

        assert_eq!(state.settings.get().tmp_root, "/x");
        assert_eq!(state.settings.get().max_concurrent, 2);
        assert!(state.logs_dir.join("app.log").is_file());
    }

    #[tokio::test]
    async fn init_wires_the_auth_services_without_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let user_data = user_data_dir(dir.path());
        let state = AppState::init_with_backend(
            user_data.clone(),
            Arc::new(crate::secure::UnavailableBackend),
            no_binaries(),
            Handle::current(),
        );

        assert_eq!(state.auth.get_state(), crate::dto::AuthState::signed_out());
        assert!(state.vault.get().is_none());
        assert!(state.config.get_config().is_none());
        assert_eq!(
            state.vault.file_path(),
            user_data.join(crate::secure::TOKEN_FILE_NAME)
        );

        // `cargo test` builds have no HLS_SITE_URL: the restore ends signed out with a reason.
        if BUILT_IN_SITE_URL.is_none() {
            let restored = state.auth.restore().await;

            assert_eq!(
                restored.error.as_deref(),
                Some(crate::auth::SITE_URL_NOT_CONFIGURED)
            );
        }
    }

    #[tokio::test]
    async fn signing_out_clears_the_remembered_video_links() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::init_with_backend(
            user_data_dir(dir.path()),
            Arc::new(crate::secure::UnavailableBackend),
            no_binaries(),
            Handle::current(),
        );

        state.video_links.put(
            7,
            crate::api::video_links::VideoLinks {
                public_id: "abc".into(),
                embed_url: Some("https://site.example.com/embed/abc".into()),
                playlist_url: None,
                thumbnail_url: None,
                custom_image_url: None,
                storyboard_urls: Vec::new(),
                width: None,
                height: None,
            },
        );
        assert!(state.video_links.get(7).is_some());

        state.auth.logout().await;

        assert!(state.video_links.is_empty());
    }

    #[test]
    fn default_tmp_root_is_inside_the_temp_dir() {
        assert!(default_tmp_root().ends_with("hls-r2-studio"));
    }
}
