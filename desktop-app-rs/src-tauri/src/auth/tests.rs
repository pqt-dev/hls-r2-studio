//! Port of desktop-app/src/main/auth/authService.test.ts. Fake site client and config fetcher,
//! a real `TokenVault` with a fake encryption backend in a temp dir, and an in-memory store.
//! Tests run on tokio's current-thread runtime (like the JS event loop); `tick()` lets spawned
//! tasks run up to their next pending await.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::*;
use crate::api::app_config::testing::config;
use crate::api::AppConfig;
use crate::config::ConfigFetcher;
use crate::logger::testing::RecordingLogger;
use crate::secure::token_vault::testing::FakeBackend;
use crate::secure::{TokenVault, TOKEN_FILE_NAME};
use crate::store::testing::create_memory_store;
use crate::test_support::{tick, Deferred};

type Fut<T> = Pin<Box<dyn Future<Output = Result<T, SiteApiError>> + Send>>;
type LoginFn = Box<dyn Fn() -> Fut<LoginResult> + Send + Sync>;
type LogoutFn = Box<dyn Fn() -> Fut<()> + Send + Sync>;
type ConfigFn = Box<dyn Fn() -> Fut<AppConfig> + Send + Sync>;

const BUILT_IN: &str = "https://s.example.com";

struct FakeClient {
    login: LoginFn,
    logout: LogoutFn,
    login_calls: Mutex<Vec<(String, String, String)>>,
    logout_calls: AtomicUsize,
}

#[async_trait::async_trait]
impl AuthClient for FakeClient {
    async fn login(
        &self,
        username: &str,
        password: &Secret,
        device_name: &str,
    ) -> Result<LoginResult, SiteApiError> {
        self.login_calls.lock().unwrap().push((
            username.to_string(),
            password.expose().to_string(),
            device_name.to_string(),
        ));

        (self.login)().await
    }

    async fn logout(&self) -> Result<(), SiteApiError> {
        self.logout_calls.fetch_add(1, Ordering::SeqCst);

        (self.logout)().await
    }
}

struct FakeFetcher {
    get: ConfigFn,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl ConfigFetcher for FakeFetcher {
    async fn get_config(&self) -> Result<AppConfig, SiteApiError> {
        self.calls.fetch_add(1, Ordering::SeqCst);

        (self.get)().await
    }
}

fn login_ok(token: &'static str) -> LoginFn {
    Box::new(move || {
        Box::pin(async move {
            Ok(LoginResult {
                token: Secret::from(token),
                username: "admin".into(),
            })
        })
    })
}

fn login_err(error: SiteApiError) -> LoginFn {
    Box::new(move || {
        let error = error.clone();
        Box::pin(async move { Err(error) })
    })
}

fn login_waits_for(pending: &Arc<Deferred<LoginResult>>) -> LoginFn {
    let pending = Arc::clone(pending);
    Box::new(move || {
        let wait = pending.wait();
        Box::pin(async move { Ok(wait.await) })
    })
}

fn logout_ok() -> LogoutFn {
    Box::new(|| Box::pin(async { Ok(()) }))
}

fn config_ok() -> ConfigFn {
    Box::new(|| Box::pin(async { Ok(config()) }))
}

fn config_err(error: SiteApiError) -> ConfigFn {
    Box::new(move || {
        let error = error.clone();
        Box::pin(async move { Err(error) })
    })
}

fn config_pending(pending: &Arc<Deferred<Result<AppConfig, SiteApiError>>>) -> ConfigFn {
    let pending = Arc::clone(pending);
    Box::new(move || Box::pin(pending.wait()))
}

#[derive(Default)]
struct Opts {
    login: Option<LoginFn>,
    logout: Option<LogoutFn>,
    get_config: Option<ConfigFn>,
    /// Site URL stored by an earlier session.
    site_url: Option<&'static str>,
    /// The built-in site of this build. `None` = default (`BUILT_IN`), `Some(None)` = no site.
    built_in: Option<Option<&'static str>>,
}

struct T {
    auth: Arc<AuthService>,
    client: Arc<FakeClient>,
    fetcher: Arc<FakeFetcher>,
    vault: Arc<TokenVault>,
    store: Arc<AppStore>,
    config: Arc<ConfigService>,
    states: Arc<Mutex<Vec<AuthState>>>,
    logger: Arc<RecordingLogger>,
    dir: tempfile::TempDir,
}

impl T {
    fn token(&self) -> Option<String> {
        self.vault.get().map(|t| t.expose().to_string())
    }

    fn statuses(&self) -> Vec<AuthStatus> {
        self.states
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.status)
            .collect()
    }

    fn ever(&self, status: AuthStatus) -> bool {
        self.statuses().contains(&status)
    }

    fn token_file_exists(&self) -> bool {
        self.dir.path().join(TOKEN_FILE_NAME).exists()
    }

    fn settings_site_url(&self) -> String {
        self.store.get().settings.site_url
    }

    fn settings_username(&self) -> Option<String> {
        self.store.get().settings.username
    }

    fn login_count(&self) -> usize {
        self.client.login_calls.lock().unwrap().len()
    }

    fn logout_count(&self) -> usize {
        self.client.logout_calls.load(Ordering::SeqCst)
    }

    fn config_count(&self) -> usize {
        self.fetcher.calls.load(Ordering::SeqCst)
    }

    async fn login(&self, username: &str, password: &str) -> AuthState {
        self.auth
            .login(username, Secret::from(password), true)
            .await
    }

    fn spawn_login(&self, stay: bool) -> tokio::task::JoinHandle<AuthState> {
        let auth = Arc::clone(&self.auth);
        tokio::spawn(async move { auth.login("a", Secret::from("b"), stay).await })
    }

    fn spawn_restore(&self) -> tokio::task::JoinHandle<AuthState> {
        let auth = Arc::clone(&self.auth);
        tokio::spawn(async move { auth.restore().await })
    }

    fn spawn_logout(&self) -> tokio::task::JoinHandle<AuthState> {
        let auth = Arc::clone(&self.auth);
        tokio::spawn(async move { auth.logout().await })
    }

    fn fresh_vault(&self) -> TokenVault {
        fresh_vault(self.dir.path())
    }
}

fn fresh_vault(dir: &Path) -> TokenVault {
    TokenVault::new(dir.to_path_buf(), Arc::new(FakeBackend::new(true)))
}

fn setup(opts: Opts) -> T {
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(fresh_vault(dir.path()));
    let store = Arc::new(create_memory_store("/tmp"));

    if let Some(site_url) = opts.site_url {
        store.update(|d| d.settings.site_url = site_url.to_string());
    }

    let client = Arc::new(FakeClient {
        login: opts.login.unwrap_or_else(|| login_ok("1|tok")),
        logout: opts.logout.unwrap_or_else(logout_ok),
        login_calls: Mutex::new(Vec::new()),
        logout_calls: AtomicUsize::new(0),
    });
    let fetcher = Arc::new(FakeFetcher {
        get: opts.get_config.unwrap_or_else(config_ok),
        calls: AtomicUsize::new(0),
    });
    let config = Arc::new(ConfigService::new(fetcher.clone()));
    let logger = Arc::new(RecordingLogger::default());
    let auth = Arc::new(AuthService::new(AuthServiceOptions {
        client: client.clone(),
        vault: vault.clone(),
        store: Arc::clone(&store),
        config: Arc::clone(&config),
        hostname: Box::new(|| "MY-PC".to_string()),
        site_url: opts.built_in.unwrap_or(Some(BUILT_IN)).map(str::to_string),
        logger: logger.clone(),
    }));
    let states = Arc::new(Mutex::new(Vec::new()));

    {
        let states = Arc::clone(&states);
        auth.subscribe(Arc::new(move |s: &AuthState| {
            states.lock().unwrap().push(s.clone())
        }));
    }

    T {
        auth,
        client,
        fetcher,
        vault,
        store,
        config,
        states,
        logger,
        dir,
    }
}

fn site_error(message: &str) -> SiteApiError {
    SiteApiError::new(message)
}

fn signed_out_with(site_url: Option<&str>, error: Option<&str>) -> AuthState {
    AuthState {
        site_url: site_url.map(str::to_string),
        error: error.map(str::to_string),
        ..AuthState::signed_out()
    }
}

// ---- deviceNameOf ---------------------------------------------------------------------------

#[test]
fn device_name_truncates_to_100_chars_and_falls_back_when_empty() {
    assert_eq!(device_name_of(&"a".repeat(150)).chars().count(), 100);
    assert_eq!(device_name_of("  "), "Desktop app");
    assert_eq!(device_name_of("PC"), "PC");
    assert_eq!(device_name_of("  PC  "), "PC");
}

// ---- login ----------------------------------------------------------------------------------

#[tokio::test]
async fn login_signs_in_saves_the_token_and_site_then_loads_the_config() {
    let t = setup(Opts {
        built_in: Some(Some("https://site.example.com")),
        ..Opts::default()
    });
    let state = t.login(" admin ", "pw").await;

    assert_eq!(
        state,
        AuthState {
            status: AuthStatus::SignedIn,
            username: Some("admin".into()),
            site_url: Some("https://site.example.com".into()),
            r2_configured: Some(true),
            persisted: Some(true),
            error: None,
        }
    );
    assert_eq!(
        *t.client.login_calls.lock().unwrap(),
        [("admin".to_string(), "pw".to_string(), "MY-PC".to_string())]
    );
    assert_eq!(t.token().as_deref(), Some("1|tok"));
    assert_eq!(t.settings_site_url(), "https://site.example.com");
    assert_eq!(t.settings_username().as_deref(), Some("admin"));
    assert_eq!(t.config.get_config(), Some(config()));
    assert_eq!(t.statuses(), [AuthStatus::SigningIn, AuthStatus::SignedIn]);
    assert!(!serde_json::to_string(&state).unwrap().contains("1|tok"));
}

#[tokio::test]
async fn login_reports_r2_configured_false_when_the_site_has_no_r2_settings() {
    let t = setup(Opts {
        get_config: Some(config_err(
            site_error("x").status(409).code("r2_not_configured"),
        )),
        ..Opts::default()
    });
    let state = t.login("a", "b").await;

    assert_eq!(state.status, AuthStatus::SignedIn);
    assert_eq!(state.r2_configured, Some(false));
}

#[tokio::test]
async fn login_maps_failures_to_safe_messages_and_restores_the_stored_url() {
    let cases = [
        (
            site_error("x").status(422),
            "Incorrect username or password.",
        ),
        (
            site_error("x").status(429).retry_after(Some(30)),
            "Too many sign-in attempts. Try again in 30 seconds.",
        ),
        (
            site_error("x").status(429),
            "Too many sign-in attempts. Try again in a minute.",
        ),
        (
            site_error("Could not reach the site.").network(),
            "Could not reach the site.",
        ),
        (
            site_error("x").status(503),
            "The site had a temporary problem. Please try again.",
        ),
        (
            site_error("The site URL must start with https://.").code("invalid_site_url"),
            "The site URL must start with https://.",
        ),
        (
            site_error("Sign-in failed (HTTP 403).").status(403),
            "Sign-in failed (HTTP 403).",
        ),
    ];

    for (error, message) in cases {
        let t = setup(Opts {
            login: Some(login_err(error)),
            site_url: Some("https://old.example.com"),
            ..Opts::default()
        });
        let state = t.login("a", "b").await;

        assert_eq!(state.status, AuthStatus::SignedOut);
        assert_eq!(state.error.as_deref(), Some(message));
        assert!(t.vault.get().is_none());
        assert_eq!(t.settings_site_url(), "https://old.example.com");
    }
}

#[tokio::test]
async fn login_reports_a_generic_message_when_the_token_cannot_be_stored() {
    let t = setup(Opts::default());
    // Make the vault directory unusable: a file where the folder should be.
    let blocked_dir = t.dir.path().join("blocked");
    std::fs::write(&blocked_dir, "file").unwrap();
    let vault = Arc::new(TokenVault::new(
        blocked_dir.join("sub"),
        Arc::new(FakeBackend::new(true)),
    ));
    let auth = AuthService::new(AuthServiceOptions {
        client: t.client.clone(),
        vault,
        store: Arc::clone(&t.store),
        config: Arc::clone(&t.config),
        hostname: Box::new(|| "PC".into()),
        site_url: Some(BUILT_IN.into()),
        logger: t.logger.clone(),
    });

    let state = auth.login("a", Secret::from("b"), true).await;

    assert_eq!(state.status, AuthStatus::SignedOut);
    assert_eq!(state.error.as_deref(), Some("Sign-in failed."));
}

#[tokio::test]
async fn a_failed_token_save_leaves_no_token_and_reload_config_sends_nothing() {
    let t = setup(Opts::default());
    let blocked_dir = t.dir.path().join("blocked");
    std::fs::write(&blocked_dir, "file").unwrap();
    let vault = Arc::new(TokenVault::new(
        blocked_dir.join("sub"),
        Arc::new(FakeBackend::new(true)),
    ));
    let auth = AuthService::new(AuthServiceOptions {
        client: t.client.clone(),
        vault: vault.clone(),
        store: Arc::clone(&t.store),
        config: Arc::clone(&t.config),
        hostname: Box::new(|| "PC".into()),
        site_url: Some(BUILT_IN.into()),
        logger: t.logger.clone(),
    });

    let state = auth.login("a", Secret::from("b"), true).await;

    assert_eq!(state.status, AuthStatus::SignedOut);
    assert_eq!(state.error.as_deref(), Some("Sign-in failed."));
    // The vault (and so every cached copy) holds no token any more.
    assert!(vault.get().is_none());

    let state = auth.reload_config().await;

    assert_eq!(state.status, AuthStatus::SignedOut);
    // No request (and so no Authorization header) was made.
    assert_eq!(t.config_count(), 0);
}

#[tokio::test]
async fn login_rejects_empty_credentials_without_calling_the_site() {
    let t = setup(Opts::default());

    for (username, password) in [("", ""), ("   ", "pw"), ("admin", "")] {
        let state = t.login(username, password).await;

        assert_eq!(state.error.as_deref(), Some(ENTER_CREDENTIALS));
        assert_eq!(state.status, AuthStatus::SignedOut);
    }

    assert_eq!(t.login_count(), 0);
}

#[tokio::test]
async fn login_ends_signed_out_when_the_config_call_is_rejected_with_401() {
    let t = setup(Opts {
        get_config: Some(config_err(site_error("x").status(401))),
        ..Opts::default()
    });
    let state = t.login("a", "b").await;

    assert_eq!(state.status, AuthStatus::SignedOut);
    assert_eq!(state.error.as_deref(), Some(SESSION_EXPIRED));
    assert!(t.vault.get().is_none());
    assert!(t.config.get_config().is_none());
}

#[tokio::test]
async fn login_reports_offline_keeping_the_token_when_the_config_cannot_be_fetched() {
    let t = setup(Opts {
        get_config: Some(config_err(site_error("down").network())),
        ..Opts::default()
    });
    let state = t.login("a", "b").await;

    assert_eq!(state.status, AuthStatus::Offline);
    assert_eq!(
        state.error.as_deref(),
        Some("Could not reach the site. Check your internet connection.")
    );
    assert_eq!(state.persisted, Some(true));
    assert_eq!(t.token().as_deref(), Some("1|tok"));
}

#[tokio::test]
async fn login_reports_offline_with_a_site_message_on_an_http_config_failure() {
    let t = setup(Opts {
        get_config: Some(config_err(site_error("x").status(500))),
        ..Opts::default()
    });
    let state = t.login("a", "b").await;

    assert_eq!(state.status, AuthStatus::Offline);
    assert_eq!(
        state.error.as_deref(),
        Some("The site could not provide its configuration right now.")
    );
}

#[tokio::test]
async fn login_signs_out_of_the_previous_session_before_logging_in_again() {
    let t = setup(Opts::default());

    t.login("a", "b").await;
    t.login("a", "b").await;

    assert_eq!(t.logout_count(), 1);
}

// ---- built-in site URL ----------------------------------------------------------------------

#[tokio::test]
async fn login_always_uses_the_built_in_site_whatever_the_stored_url_says() {
    let t = setup(Opts {
        site_url: Some("https://old.example.com"),
        ..Opts::default()
    });
    let state = t.login("a", "b").await;

    assert_eq!(state.status, AuthStatus::SignedIn);
    assert_eq!(state.site_url.as_deref(), Some(BUILT_IN));
    assert_eq!(t.settings_site_url(), BUILT_IN);
    assert_eq!(t.auth.get_site_url(), BUILT_IN);
}

#[tokio::test]
async fn login_returns_a_clear_error_when_the_build_has_no_site_url() {
    let t = setup(Opts {
        built_in: Some(None),
        ..Opts::default()
    });

    assert_eq!(
        t.login("a", "b").await,
        signed_out_with(None, Some("Site URL is not configured in this build."))
    );
    assert_eq!(t.login_count(), 0);
    assert_eq!(t.auth.get_site_url(), "");
}

// ---- logout ---------------------------------------------------------------------------------

#[tokio::test]
async fn logout_clears_token_config_and_username_even_when_the_request_fails() {
    let t = setup(Opts {
        logout: Some(Box::new(|| {
            Box::pin(async { Err(SiteApiError::new("offline")) })
        })),
        ..Opts::default()
    });
    t.login("a", "b").await;
    let signed_out = Arc::new(AtomicUsize::new(0));
    {
        let signed_out = Arc::clone(&signed_out);
        t.auth.on_signed_out(Arc::new(move || {
            signed_out.fetch_add(1, Ordering::SeqCst);
        }));
    }

    let state = t.auth.logout().await;

    assert_eq!(state, signed_out_with(Some(BUILT_IN), None));
    assert!(t.vault.get().is_none());
    assert!(t.config.get_config().is_none());
    assert_eq!(t.settings_username(), None);
    assert_eq!(signed_out.load(Ordering::SeqCst), 1);
    assert!(t
        .logger
        .messages()
        .contains(&"Sign-out request failed; clearing the local token anyway".to_string()));
}

// ---- restore --------------------------------------------------------------------------------

#[tokio::test]
async fn restore_is_signed_out_without_a_token() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        ..Opts::default()
    });

    assert_eq!(t.auth.restore().await.status, AuthStatus::SignedOut);
}

#[tokio::test]
async fn restore_validates_the_saved_token_by_fetching_the_config() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();
    t.store
        .update(|d| d.settings.username = Some("admin".into()));

    let state = t.auth.restore().await;

    assert_eq!(
        state,
        AuthState {
            status: AuthStatus::SignedIn,
            username: Some("admin".into()),
            site_url: Some(BUILT_IN.into()),
            r2_configured: Some(true),
            persisted: Some(true),
            error: None,
        }
    );
    assert_eq!(t.config_count(), 1);
}

#[tokio::test]
async fn restore_treats_a_stored_default_port_url_as_the_built_in_site() {
    let t = setup(Opts {
        site_url: Some("https://S.example.com:443/"),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    let state = t.auth.restore().await;

    assert_eq!(state.status, AuthStatus::SignedIn);
    assert_eq!(t.token().as_deref(), Some("1|saved"));
}

#[tokio::test]
async fn restore_reads_the_token_from_disk_in_a_fresh_vault() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        ..Opts::default()
    });
    // Only on disk: a previous run saved it.
    t.fresh_vault().save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::SignedIn);
    assert_eq!(t.token().as_deref(), Some("1|saved"));
}

#[tokio::test]
async fn restore_clears_the_token_on_401_and_reports_signed_out() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        get_config: Some(config_err(site_error("x").status(401))),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    let state = t.auth.restore().await;

    assert_eq!(state.status, AuthStatus::SignedOut);
    assert!(t.vault.get().is_none());
    assert!(!t.token_file_exists());
}

#[tokio::test]
async fn restore_keeps_the_token_and_reports_offline_on_a_network_failure() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        get_config: Some(config_err(site_error("down").network())),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::Offline);
    assert_eq!(t.token().as_deref(), Some("1|saved"));
}

#[tokio::test]
async fn restore_recovers_from_offline_with_reload_config() {
    let fail = Arc::new(Mutex::new(true));
    let t = {
        let fail = Arc::clone(&fail);
        setup(Opts {
            site_url: Some(BUILT_IN),
            get_config: Some(Box::new(move || {
                if *fail.lock().unwrap() {
                    Box::pin(async { Err(SiteApiError::new("down").network()) })
                } else {
                    Box::pin(async { Ok(config()) })
                }
            })),
            ..Opts::default()
        })
    };
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::Offline);
    *fail.lock().unwrap() = false;
    assert_eq!(t.auth.reload_config().await.status, AuthStatus::SignedIn);
}

#[tokio::test]
async fn reload_config_without_a_token_is_signed_out() {
    let t = setup(Opts::default());

    assert_eq!(
        t.auth.reload_config().await,
        signed_out_with(Some(BUILT_IN), None)
    );
    assert_eq!(t.config_count(), 0);
}

#[tokio::test]
async fn restore_discards_a_token_when_no_site_url_is_stored() {
    let t = setup(Opts::default());
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::SignedOut);
    assert!(t.vault.get().is_none());
    assert_eq!(t.config_count(), 0);
}

#[tokio::test]
async fn restore_accepts_a_stored_url_that_only_differs_in_form_from_the_built_in_one() {
    let t = setup(Opts {
        site_url: Some("https://S.example.com/admin/"),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::SignedIn);
    assert_eq!(t.token().as_deref(), Some("1|saved"));
}

#[tokio::test]
async fn restore_treats_a_token_saved_for_a_different_site_as_signed_out_and_drops_it() {
    let t = setup(Opts {
        site_url: Some("https://old.example.com"),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();
    t.store
        .update(|d| d.settings.username = Some("admin".into()));

    let state = t.auth.restore().await;

    assert_eq!(
        state,
        signed_out_with(
            Some(BUILT_IN),
            Some("This app now connects to a fixed site. Sign in again.")
        )
    );
    assert!(t.vault.get().is_none());
    assert!(!t.token_file_exists());
    assert!(t.config.get_config().is_none());
    assert_eq!(t.settings_username(), None);
    assert_eq!(t.settings_site_url(), BUILT_IN);
    // The token is never sent anywhere: no config fetch, no sign-out request to either host.
    assert_eq!(t.config_count(), 0);
    assert_eq!(t.logout_count(), 0);
}

#[tokio::test]
async fn restore_treats_an_unparseable_stored_url_as_a_different_site() {
    let t = setup(Opts {
        site_url: Some("garbage"),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.status, AuthStatus::SignedOut);
    assert!(t.vault.get().is_none());
}

#[tokio::test]
async fn restore_adopts_the_built_in_url_silently_when_there_was_no_session() {
    let t = setup(Opts {
        site_url: Some("https://old.example.com"),
        ..Opts::default()
    });

    assert_eq!(
        t.auth.restore().await,
        signed_out_with(Some(BUILT_IN), None)
    );
    assert_eq!(t.settings_site_url(), BUILT_IN);
}

#[tokio::test]
async fn restore_drops_a_saved_token_when_the_build_has_no_site_url() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        built_in: Some(None),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(
        t.auth.restore().await,
        signed_out_with(None, Some("Site URL is not configured in this build."))
    );
    assert!(t.vault.get().is_none());
    assert_eq!(t.config_count(), 0);
}

// ---- handleUnauthorized ---------------------------------------------------------------------

#[tokio::test]
async fn handle_unauthorized_clears_token_and_config_emits_signed_out_and_notifies() {
    let t = setup(Opts::default());
    t.login("a", "b").await;
    let signed_out = Arc::new(AtomicUsize::new(0));
    {
        let signed_out = Arc::clone(&signed_out);
        t.auth.on_signed_out(Arc::new(move || {
            signed_out.fetch_add(1, Ordering::SeqCst);
        }));
    }

    t.auth.handle_unauthorized();

    let state = t.auth.get_state();
    assert_eq!(state.status, AuthStatus::SignedOut);
    assert_eq!(state.error.as_deref(), Some(SESSION_EXPIRED));
    assert!(t.vault.get().is_none());
    assert!(t.config.get_config().is_none());
    assert_eq!(signed_out.load(Ordering::SeqCst), 1);

    t.auth.handle_unauthorized();
    assert_eq!(signed_out.load(Ordering::SeqCst), 1);
}

// ---- secrets --------------------------------------------------------------------------------

#[tokio::test]
async fn never_logs_or_publishes_the_token_or_the_password() {
    let t = setup(Opts {
        login: Some(login_ok("1|supersecrettoken")),
        ..Opts::default()
    });
    t.login("admin", "hunter2-password").await;
    t.auth.logout().await;

    let published = serde_json::to_string(&*t.states.lock().unwrap()).unwrap();

    for text in [t.logger.text(), published] {
        assert!(!text.contains("supersecrettoken"), "{text}");
        assert!(!text.contains("hunter2-password"), "{text}");
    }
}

// ---- stay signed in -------------------------------------------------------------------------

#[tokio::test]
async fn stay_signed_in_true_writes_the_token_file_and_says_persisted() {
    let t = setup(Opts::default());
    let state = t.login("a", "b").await;

    assert_eq!(state.persisted, Some(true));
    assert!(t.token_file_exists());
}

#[tokio::test]
async fn stay_signed_in_false_keeps_the_token_in_memory_only() {
    let t = setup(Opts::default());
    let state = t.auth.login("a", Secret::from("b"), false).await;

    assert_eq!(state.status, AuthStatus::SignedIn);
    assert_eq!(state.persisted, Some(false));
    assert_eq!(t.token().as_deref(), Some("1|tok"));
    assert!(!t.token_file_exists());
}

#[tokio::test]
async fn stay_signed_in_false_removes_a_previously_persisted_token_file() {
    let t = setup(Opts::default());
    t.auth.login("a", Secret::from("b"), true).await;
    assert!(t.token_file_exists());

    t.auth.login("a", Secret::from("b"), false).await;

    assert!(!t.token_file_exists());
    assert_eq!(t.token().as_deref(), Some("1|tok"));
}

#[tokio::test]
async fn restore_finds_no_token_after_a_memory_only_session() {
    let t = setup(Opts::default());
    t.auth.login("a", Secret::from("b"), false).await;

    assert!(t.fresh_vault().load().is_none());
}

#[tokio::test]
async fn restore_of_a_saved_token_reports_persisted() {
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    assert_eq!(t.auth.restore().await.persisted, Some(true));
}

#[tokio::test]
async fn logout_clears_memory_and_disk_in_both_modes() {
    for stay in [true, false] {
        let t = setup(Opts::default());
        t.auth.login("a", Secret::from("b"), stay).await;
        t.auth.logout().await;

        assert!(t.vault.get().is_none());
        assert!(!t.token_file_exists());
    }
}

// ---- session races (in-flight config load) --------------------------------------------------

type ConfigDeferred = Arc<Deferred<Result<AppConfig, SiteApiError>>>;

async fn pending_restore() -> (T, ConfigDeferred, tokio::task::JoinHandle<AuthState>) {
    let pending = Deferred::new();
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        get_config: Some(config_pending(&pending)),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    let restoring = t.spawn_restore();
    tick().await;

    assert_eq!(t.auth.get_state().status, AuthStatus::SigningIn);
    assert_eq!(t.config_count(), 1);

    (t, pending, restoring)
}

#[tokio::test]
async fn sign_out_while_the_config_is_loading_leaves_the_app_signed_out_with_no_config() {
    let (t, pending, restoring) = pending_restore().await;

    t.auth.logout().await;
    pending.resolve(Ok(config()));
    restoring.await.unwrap();
    tick().await;

    assert_eq!(t.auth.get_state().status, AuthStatus::SignedOut);
    assert!(t.config.get_config().is_none());
    assert!(t.config.get_public().is_none());
    assert!(t.vault.get().is_none());
    assert!(!t.ever(AuthStatus::SignedIn));
}

#[tokio::test]
async fn sign_out_while_a_slow_sign_out_request_is_still_pending_also_wins() {
    let logout_pending = Deferred::<()>::new();
    let pending = Deferred::new();
    let t = setup(Opts {
        site_url: Some(BUILT_IN),
        get_config: Some(config_pending(&pending)),
        logout: Some({
            let logout_pending = Arc::clone(&logout_pending);
            Box::new(move || {
                let wait = logout_pending.wait();
                Box::pin(async move {
                    wait.await;
                    Ok(())
                })
            })
        }),
        ..Opts::default()
    });
    t.vault.save("1|saved".into()).unwrap();

    let restoring = t.spawn_restore();
    tick().await;

    let logging_out = t.spawn_logout();
    tick().await;
    pending.resolve(Ok(config()));
    restoring.await.unwrap();

    assert!(t.config.get_config().is_none());
    assert!(!t.ever(AuthStatus::SignedIn));

    logout_pending.resolve(());
    logging_out.await.unwrap();

    assert_eq!(t.auth.get_state().status, AuthStatus::SignedOut);
}

#[tokio::test]
async fn a_401_while_the_config_is_loading_stays_signed_out() {
    let (t, pending, restoring) = pending_restore().await;

    t.auth.handle_unauthorized();
    pending.resolve(Ok(config()));
    restoring.await.unwrap();
    tick().await;

    let state = t.auth.get_state();
    assert_eq!(state.status, AuthStatus::SignedOut);
    assert_eq!(state.error.as_deref(), Some(SESSION_EXPIRED));
    assert!(t.config.get_config().is_none());
    assert!(!t.ever(AuthStatus::SignedIn));
}

#[tokio::test]
async fn a_failed_offline_load_that_finishes_after_sign_out_does_not_change_the_state() {
    let (t, pending, restoring) = pending_restore().await;

    t.auth.logout().await;
    pending.resolve(Err(SiteApiError::new("x").network()));
    restoring.await.unwrap();

    assert_eq!(t.auth.get_state().status, AuthStatus::SignedOut);
    assert!(!t.ever(AuthStatus::Offline));
}

#[tokio::test]
async fn a_normal_load_with_no_interference_still_ends_signed_in() {
    let (t, pending, restoring) = pending_restore().await;

    pending.resolve(Ok(config()));

    assert_eq!(restoring.await.unwrap().status, AuthStatus::SignedIn);
    assert_eq!(t.config.get_config(), Some(config()));
}

#[tokio::test]
async fn sign_out_during_login_revokes_the_freshly_issued_token_and_stays_signed_out() {
    let login_pending = Deferred::new();
    let t = setup(Opts {
        login: Some(login_waits_for(&login_pending)),
        ..Opts::default()
    });
    let logging = t.spawn_login(true);

    tick().await;
    t.auth.logout().await;
    login_pending.resolve(LoginResult {
        token: Secret::from("1|late"),
        username: "admin".into(),
    });

    let result = logging.await.unwrap();

    assert_eq!(result.status, AuthStatus::SignedOut);
    assert!(t.vault.get().is_none());
    assert!(t.logout_count() >= 1);
    assert_eq!(t.config_count(), 0);
}

// ---- concurrent login -----------------------------------------------------------------------

#[tokio::test]
async fn ignores_a_second_simultaneous_login_and_issues_only_one_token() {
    let login_pending = Deferred::new();
    let t = setup(Opts {
        login: Some(login_waits_for(&login_pending)),
        ..Opts::default()
    });

    let first = t.spawn_login(true);
    let second = t.spawn_login(true);
    tick().await;
    login_pending.resolve(LoginResult {
        token: Secret::from("1|only"),
        username: "admin".into(),
    });

    let (a, b) = (first.await.unwrap(), second.await.unwrap());

    assert_eq!(t.login_count(), 1);
    assert_eq!(a.status, AuthStatus::SignedIn);
    assert_ne!(b.status, AuthStatus::SignedIn);
    assert_eq!(t.token().as_deref(), Some("1|only"));
}

#[tokio::test]
async fn also_ignores_a_second_login_while_the_previous_token_is_being_revoked() {
    let logout_pending = Deferred::<()>::new();
    let t = setup(Opts {
        logout: Some({
            let logout_pending = Arc::clone(&logout_pending);
            Box::new(move || {
                let wait = logout_pending.wait();
                Box::pin(async move {
                    wait.await;
                    Ok(())
                })
            })
        }),
        ..Opts::default()
    });
    t.vault.save("1|old".into()).unwrap();

    let first = t.spawn_login(true);
    let second = t.spawn_login(true);
    tick().await;
    logout_pending.resolve(());
    first.await.unwrap();
    second.await.unwrap();

    assert_eq!(t.login_count(), 1);
}

#[tokio::test]
async fn allows_a_new_login_after_the_previous_one_finished() {
    let t = setup(Opts::default());

    t.login("a", "b").await;
    t.login("a", "b").await;

    assert_eq!(t.login_count(), 2);
}

#[tokio::test]
async fn revokes_a_token_that_appears_restore_race_before_it_is_overwritten() {
    let login_pending = Deferred::new();
    let t = setup(Opts {
        login: Some(login_waits_for(&login_pending)),
        ..Opts::default()
    });
    let logging = t.spawn_login(true);

    tick().await;
    t.vault.save("1|restored".into()).unwrap();
    login_pending.resolve(LoginResult {
        token: Secret::from("1|new"),
        username: "admin".into(),
    });
    logging.await.unwrap();

    assert_eq!(t.logout_count(), 1);
    assert_eq!(t.token().as_deref(), Some("1|new"));
}

#[tokio::test]
async fn a_dropped_login_does_not_block_the_next_one() {
    let login_pending = Deferred::new();
    let t = setup(Opts {
        login: Some(login_waits_for(&login_pending)),
        ..Opts::default()
    });
    let logging = t.spawn_login(true);

    tick().await;
    logging.abort();
    let _ = logging.await;
    // The aborted attempt left "signing_in" behind; a sign-out resets it.
    t.auth.logout().await;
    login_pending.resolve(LoginResult {
        token: Secret::from("1|tok"),
        username: "admin".into(),
    });

    assert_eq!(t.login("a", "b").await.status, AuthStatus::SignedIn);
}

// ---- Rust-specific: real threads, listeners -------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_logins_on_many_threads_issue_one_token() {
    let login_pending = Deferred::new();
    let t = setup(Opts {
        login: Some(login_waits_for(&login_pending)),
        ..Opts::default()
    });
    let attempts: Vec<_> = (0..16).map(|_| t.spawn_login(true)).collect();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    login_pending.resolve(LoginResult {
        token: Secret::from("1|only"),
        username: "admin".into(),
    });

    let mut signed_in = 0;

    for attempt in attempts {
        if attempt.await.unwrap().status == AuthStatus::SignedIn {
            signed_in += 1;
        }
    }

    assert_eq!(t.login_count(), 1);
    assert_eq!(signed_in, 1);
}

#[tokio::test]
async fn a_panicking_listener_is_logged_and_others_still_run() {
    let t = setup(Opts::default());
    let seen = Arc::new(AtomicUsize::new(0));
    t.auth
        .subscribe(Arc::new(|_: &AuthState| panic!("listener bug")));
    {
        let seen = Arc::clone(&seen);
        t.auth.subscribe(Arc::new(move |_: &AuthState| {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
    }

    t.auth.reload_config().await;

    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert!(t
        .logger
        .messages()
        .contains(&"Auth listener failed".to_string()));
}

#[tokio::test]
async fn unsubscribe_stops_the_events() {
    let t = setup(Opts::default());
    let seen = Arc::new(AtomicUsize::new(0));
    let subscription = {
        let seen = Arc::clone(&seen);
        t.auth.subscribe(Arc::new(move |_: &AuthState| {
            seen.fetch_add(1, Ordering::SeqCst);
        }))
    };

    t.auth.reload_config().await;
    t.auth.unsubscribe(subscription);
    t.auth.reload_config().await;

    assert_eq!(seen.load(Ordering::SeqCst), 1);
}

#[test]
fn login_error_message_for_a_storage_failure_is_generic() {
    let failure = LoginFailure::Storage(std::io::Error::other("disk full"));

    assert_eq!(login_error_message(&failure), "Sign-in failed.");
}
