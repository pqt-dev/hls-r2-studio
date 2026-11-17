//! Sign-in state machine (spec 4.3 / 4.5): login, logout, restore at startup, 401 handling.
//! Port of desktop-app/src/main/auth/authService.ts.
//!
//! Concurrency model. The TS service relies on JS running everything between two `await`s
//! atomically. Here the same "synchronous sections" are guarded by one mutex (`inner`), which is
//! never held across an `.await`:
//! - `epoch` is bumped synchronously by every logout, session clear and 401. Async work (config
//!   load, login) captures it first and drops its result when it moved, so a late answer can never
//!   resurrect a signed-out session. The "is this result still wanted?" check and the state change
//!   happen under the same lock (`set_state_if`).
//! - `login_in_flight` is checked and set under the lock: a second concurrent login is ignored.
//! - State changes are published to listeners in order (`emit` lock). Listeners must not call
//!   back into a mutating method of this service synchronously (they may call `get_state`).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};

use crate::api::{LoginResult, SiteApiError};
use crate::config::{ConfigError, ConfigService};
use crate::dto::{AuthState, AuthStatus};
use crate::logger::{error_to_value, Log};
use crate::secure::{SaveResult, Secret, TokenStore};
use crate::site_url;
use crate::store::AppStore;

pub const MAX_DEVICE_NAME_LENGTH: usize = 100;
/// Shown when this build has no (valid) built-in site URL.
pub const SITE_URL_NOT_CONFIGURED: &str = "Site URL is not configured in this build.";
pub const SESSION_EXPIRED: &str = "Your session has expired. Sign in again.";
pub const FIXED_SITE_SIGN_IN_AGAIN: &str = "This app now connects to a fixed site. Sign in again.";
pub const ENTER_CREDENTIALS: &str = "Enter your username and password.";
const CONFIG_UNAVAILABLE: &str = "The site could not provide its configuration right now.";
const CANNOT_REACH_SITE: &str = "Could not reach the site. Check your internet connection.";

#[async_trait::async_trait]
pub trait AuthClient: Send + Sync {
    async fn login(
        &self,
        username: &str,
        password: &Secret,
        device_name: &str,
    ) -> Result<LoginResult, SiteApiError>;
    async fn logout(&self) -> Result<(), SiteApiError>;
}

pub type AuthListener = Arc<dyn Fn(&AuthState) + Send + Sync>;
pub type SignedOutListener = Arc<dyn Fn() + Send + Sync>;

/// Handle returned by `subscribe` / `on_signed_out`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Subscription(u64);

pub struct AuthServiceOptions {
    pub client: Arc<dyn AuthClient>,
    pub vault: Arc<dyn TokenStore>,
    pub store: Arc<AppStore>,
    pub config: Arc<ConfigService>,
    pub hostname: Box<dyn Fn() -> String + Send + Sync>,
    /// The one site this build talks to (normalized origin), or `None` when the build has none.
    /// The renderer can never choose it.
    pub site_url: Option<String>,
    pub logger: Arc<dyn Log>,
}

pub fn device_name_of(hostname: &str) -> String {
    let name: String = hostname
        .trim()
        .chars()
        .take(MAX_DEVICE_NAME_LENGTH)
        .collect();
    let name = name.trim();

    if name.is_empty() {
        "Desktop app".to_string()
    } else {
        name.to_string()
    }
}

/// Why a sign-in failed.
#[derive(Debug)]
pub enum LoginFailure {
    Site(SiteApiError),
    /// The token could not be stored (disk error).
    Storage(std::io::Error),
}

impl LoginFailure {
    fn to_log_value(&self) -> Value {
        match self {
            Self::Site(error) => error.to_log_value(),
            Self::Storage(error) => error_to_value(error),
        }
    }
}

pub fn login_error_message(failure: &LoginFailure) -> String {
    let LoginFailure::Site(error) = failure else {
        return "Sign-in failed.".to_string();
    };

    if error.has_code("invalid_site_url") || error.network {
        return error.message.clone();
    }

    match error.status {
        Some(422) => "Incorrect username or password.".to_string(),
        Some(429) => match error.retry_after_seconds {
            None => "Too many sign-in attempts. Try again in a minute.".to_string(),
            Some(wait) => format!("Too many sign-in attempts. Try again in {wait} seconds."),
        },
        Some(status) if status >= 500 => {
            "The site had a temporary problem. Please try again.".to_string()
        }
        _ => error.message.clone(),
    }
}

struct Inner {
    state: AuthState,
    /// True when the current token is stored on disk (survives a restart).
    persisted: bool,
    epoch: u64,
    login_in_flight: bool,
}

pub struct AuthService {
    client: Arc<dyn AuthClient>,
    vault: Arc<dyn TokenStore>,
    store: Arc<AppStore>,
    config: Arc<ConfigService>,
    hostname: Box<dyn Fn() -> String + Send + Sync>,
    site_url: Option<String>,
    logger: Arc<dyn Log>,
    inner: Mutex<Inner>,
    emit: Mutex<()>,
    listeners: Mutex<Vec<(u64, AuthListener)>>,
    signed_out_listeners: Mutex<Vec<(u64, SignedOutListener)>>,
    next_id: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Clears `login_in_flight` when the login finishes, fails or is dropped.
struct LoginFlight<'a>(&'a AuthService);

impl Drop for LoginFlight<'_> {
    fn drop(&mut self) {
        lock(&self.0.inner).login_in_flight = false;
    }
}

impl AuthService {
    pub fn new(options: AuthServiceOptions) -> Self {
        Self {
            client: options.client,
            vault: options.vault,
            store: options.store,
            config: options.config,
            hostname: options.hostname,
            site_url: options.site_url,
            logger: options.logger,
            inner: Mutex::new(Inner {
                state: AuthState::signed_out(),
                persisted: false,
                epoch: 0,
                login_in_flight: false,
            }),
            emit: Mutex::new(()),
            listeners: Mutex::new(Vec::new()),
            signed_out_listeners: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
        }
    }

    // ---- public API ----------------------------------------------------------------------

    pub fn get_state(&self) -> AuthState {
        lock(&self.inner).state.clone()
    }

    /// The built-in site origin, or "" when this build has none.
    pub fn get_site_url(&self) -> String {
        self.site_url.clone().unwrap_or_default()
    }

    pub fn subscribe(&self, listener: AuthListener) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.listeners).push((id, listener));

        Subscription(id)
    }

    pub fn unsubscribe(&self, subscription: Subscription) {
        lock(&self.listeners).retain(|(id, _)| *id != subscription.0);
        lock(&self.signed_out_listeners).retain(|(id, _)| *id != subscription.0);
    }

    /// Fires after the session was cleared (explicit sign-out or any 401).
    pub fn on_signed_out(&self, listener: SignedOutListener) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.signed_out_listeners).push((id, listener));

        Subscription(id)
    }

    /// `stay_signed_in` = keep the token on disk; false = this session only.
    pub async fn login(&self, username: &str, password: Secret, stay_signed_in: bool) -> AuthState {
        // Guard FIRST and atomically: two simultaneous calls must not issue two tokens.
        {
            let mut inner = lock(&self.inner);

            if inner.login_in_flight || inner.state.status == AuthStatus::SigningIn {
                return inner.state.clone();
            }

            inner.login_in_flight = true;
        }

        let _flight = LoginFlight(self);

        self.perform_login(username, &password, stay_signed_in)
            .await
    }

    pub async fn logout(&self) -> AuthState {
        // Drop the session in memory immediately so an in-flight config load cannot revive it.
        self.invalidate_session();

        if self.vault.get().is_some() {
            if let Err(error) = self.client.logout().await {
                self.logger.warn(
                    "Sign-out request failed; clearing the local token anyway",
                    Some(json!({ "error": error.to_log_value() })),
                );
            }
        }

        self.clear_session();
        self.set_username(None);
        let next = self.signed_out(None);
        self.notify_signed_out();

        next
    }

    /// Startup: load the saved token and validate it by fetching the config.
    pub async fn restore(&self) -> AuthState {
        let token = self.vault.load();

        let Some(site_url) = self.site_url.clone() else {
            // Nowhere to send a token to: never keep one around.
            if token.is_some() {
                self.clear_session();
            }

            return self.signed_out(Some(SITE_URL_NOT_CONFIGURED));
        };

        if !self.stored_site_is_built_in() {
            // Saved by a version that let the user pick the site (or for another site): the
            // token must never be sent to the built-in host, so sign in again.
            let had_session = token.is_some();

            if had_session {
                self.clear_session();
            }

            if had_session || self.stored_username().is_some() {
                self.set_username(None);
            }

            self.store
                .update(|draft| draft.settings.site_url = site_url.clone());

            return self.signed_out(had_session.then_some(FIXED_SITE_SIGN_IN_AGAIN));
        }

        if token.is_none() {
            return self.signed_out(None);
        }

        // A token found on disk was saved with "stay signed in".
        lock(&self.inner).persisted = true;
        let username = self.stored_username();

        self.set_state(AuthState {
            status: AuthStatus::SigningIn,
            site_url: Some(site_url),
            username: username.clone(),
            ..AuthState::signed_out()
        });

        self.validate(username).await
    }

    /// Re-fetches the site config (settings "Reload config", or recovery from `offline`).
    pub async fn reload_config(&self) -> AuthState {
        if self.vault.get().is_none() {
            return self.signed_out(None);
        }

        self.validate(self.stored_username()).await
    }

    /// Clears token + config and signs out. Wired to every 401 of the site client.
    pub fn handle_unauthorized(&self) {
        if self.vault.get().is_none() && self.get_state().status == AuthStatus::SignedOut {
            return;
        }

        self.invalidate_session();

        if let Err(error) = self.vault.clear() {
            self.logger.error(
                "Could not delete the saved token",
                Some(json!({ "error": error_to_value(&error) })),
            );
        }

        self.logger
            .warn("The site rejected the token; signed out.", None);
        self.signed_out(Some(SESSION_EXPIRED));
        self.notify_signed_out();
    }

    // ---- internals -----------------------------------------------------------------------

    fn epoch(&self) -> u64 {
        lock(&self.inner).epoch
    }

    /// Ends the current session in memory right now (before any await).
    fn invalidate_session(&self) {
        lock(&self.inner).epoch += 1;
        self.config.clear();
    }

    fn clear_session(&self) {
        self.invalidate_session();
        lock(&self.inner).persisted = false;

        if let Err(error) = self.vault.clear() {
            self.logger.error(
                "Could not delete the saved token",
                Some(json!({ "error": error_to_value(&error) })),
            );
        }
    }

    fn stored_site_url(&self) -> String {
        self.store.read(|data| data.settings.site_url.clone())
    }

    fn stored_username(&self) -> Option<String> {
        self.store.read(|data| data.settings.username.clone())
    }

    fn set_username(&self, username: Option<String>) {
        self.store
            .update(|draft| draft.settings.username = username);
    }

    /// True when the site stored by an older session is the built-in site (normalized compare).
    fn stored_site_is_built_in(&self) -> bool {
        let Some(built_in) = &self.site_url else {
            return false;
        };
        let stored = self.stored_site_url();

        !stored.is_empty() && site_url::normalize(&stored).is_ok_and(|s| &s == built_in)
    }

    fn signed_out_base(&self) -> AuthState {
        AuthState {
            site_url: self.site_url.clone(),
            ..AuthState::signed_out()
        }
    }

    fn signed_out(&self, error: Option<&str>) -> AuthState {
        self.set_state(AuthState {
            error: error.map(str::to_string),
            ..self.signed_out_base()
        })
    }

    fn set_state(&self, next: AuthState) -> AuthState {
        self.set_state_if(next, |_| true)
    }

    /// Sets and publishes `next` when `still_wanted` holds (checked under the state lock);
    /// otherwise returns the current state unchanged.
    fn set_state_if(
        &self,
        next: AuthState,
        still_wanted: impl FnOnce(&Inner) -> bool,
    ) -> AuthState {
        let _emit = lock(&self.emit);

        {
            let mut inner = lock(&self.inner);

            if !still_wanted(&inner) {
                return inner.state.clone();
            }

            inner.state = next.clone();
        }

        let listeners: Vec<AuthListener> = lock(&self.listeners)
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();

        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(&next))).is_err() {
                self.logger.error("Auth listener failed", None);
            }
        }

        next
    }

    fn notify_signed_out(&self) {
        let listeners: Vec<SignedOutListener> = lock(&self.signed_out_listeners)
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();

        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener())).is_err() {
                self.logger.error("Signed-out listener failed", None);
            }
        }
    }

    /// After a token exists: fetch the config and derive signed_in / offline / signed_out.
    async fn validate(&self, username: Option<String>) -> AuthState {
        let (start_epoch, persisted) = {
            let inner = lock(&self.inner);
            (inner.epoch, inner.persisted)
        };
        let start_token = self.vault.get();
        let base = AuthState {
            status: AuthStatus::SignedIn,
            username,
            site_url: self.site_url.clone(),
            r2_configured: None,
            persisted: Some(persisted),
            error: None,
        };
        // The session changed (sign-out, 401, another token) while we waited.
        let current = |inner: &Inner| inner.epoch == start_epoch && self.vault.get() == start_token;

        match self.config.refresh().await {
            Ok(view) => self.set_state_if(
                AuthState {
                    r2_configured: Some(view.r2_configured),
                    ..base
                },
                current,
            ),
            Err(ConfigError::Stale) => self.get_state(),
            Err(ConfigError::Site(error)) => {
                if !current(&lock(&self.inner)) {
                    return self.get_state();
                }

                if error.status == Some(401) {
                    // The client already called handle_unauthorized(); make sure we end signed out.
                    if self.get_state().status == AuthStatus::SignedOut {
                        return self.get_state();
                    }

                    self.clear_session();

                    return self.signed_out(Some(SESSION_EXPIRED));
                }

                self.logger.warn(
                    "Could not load the site config",
                    Some(json!({ "error": error.to_log_value() })),
                );
                let message = if error.network {
                    CANNOT_REACH_SITE
                } else {
                    CONFIG_UNAVAILABLE
                };

                self.set_state_if(
                    AuthState {
                        status: AuthStatus::Offline,
                        error: Some(message.to_string()),
                        ..base
                    },
                    current,
                )
            }
        }
    }

    async fn perform_login(&self, username: &str, password: &Secret, stay: bool) -> AuthState {
        let Some(origin) = self.site_url.clone() else {
            return self.set_state(AuthState {
                error: Some(SITE_URL_NOT_CONFIGURED.to_string()),
                ..self.signed_out_base()
            });
        };

        if username.trim().is_empty() || password.is_empty() {
            return self.set_state(AuthState {
                error: Some(ENTER_CREDENTIALS.to_string()),
                ..self.signed_out_base()
            });
        }

        // Do not leave a token of the previous session on the server.
        if self.vault.get().is_some() {
            let _ = self.client.logout().await;
            self.clear_session();
        }

        let previous_url = self.stored_site_url();

        self.set_state(AuthState {
            status: AuthStatus::SigningIn,
            site_url: Some(origin.clone()),
            ..AuthState::signed_out()
        });
        self.store
            .update(|draft| draft.settings.site_url = origin.clone());

        let login_epoch = self.epoch();
        let outcome = self
            .sign_in(username.trim(), password, stay, &origin, login_epoch)
            .await;

        match outcome {
            Ok(state) => state,
            Err(failure) => {
                self.logger.warn(
                    "Sign-in failed",
                    Some(json!({ "error": failure.to_log_value() })),
                );

                if self.epoch() != login_epoch {
                    return self.get_state();
                }

                self.store
                    .update(|draft| draft.settings.site_url = previous_url);

                self.set_state(AuthState {
                    error: Some(login_error_message(&failure)),
                    ..self.signed_out_base()
                })
            }
        }
    }

    async fn sign_in(
        &self,
        username: &str,
        password: &Secret,
        stay: bool,
        origin: &str,
        login_epoch: u64,
    ) -> Result<AuthState, LoginFailure> {
        let device_name = device_name_of(&(self.hostname)());
        let result = self
            .client
            .login(username, password, &device_name)
            .await
            .map_err(LoginFailure::Site)?;

        if self.epoch() != login_epoch {
            // Signed out while the request was pending: the new token is unwanted.
            self.revoke_token(result.token).await;

            return Ok(self.get_state());
        }

        // Another token appeared meanwhile (e.g. a restore): revoke it before overwriting it.
        if self.vault.get().is_some() {
            let _ = self.client.logout().await;
        }

        let saved = if stay {
            self.vault
                .save(result.token)
                .map(|saved| saved == SaveResult::Persisted)
        } else {
            self.vault.save_memory_only(result.token).map(|()| false)
        };
        let persisted = match saved {
            Ok(persisted) => persisted,
            Err(error) => {
                // A failed save may still have left the token in memory: forget it so a later
                // reload_config cannot use a token the user was told was not stored.
                if let Err(clear_error) = self.vault.clear() {
                    self.logger.error(
                        "Could not delete the saved token",
                        Some(json!({ "error": error_to_value(&clear_error) })),
                    );
                }

                return Err(LoginFailure::Storage(error));
            }
        };

        lock(&self.inner).persisted = persisted;
        self.logger.info(
            "Signed in",
            Some(json!({ "siteUrl": origin, "persisted": persisted })),
        );
        self.set_username(Some(result.username.clone()));

        Ok(self.validate(Some(result.username)).await)
    }

    /// Best-effort revocation of a token that was issued but must not be used.
    async fn revoke_token(&self, token: Secret) {
        let revoked = match self.vault.save_memory_only(token) {
            Ok(()) => self.client.logout().await.map_err(|e| e.to_log_value()),
            Err(error) => Err(error_to_value(&error)),
        };

        if let Err(error) = revoked {
            self.logger.warn(
                "Could not revoke an unwanted token",
                Some(json!({ "error": error })),
            );
        }

        let _ = self.vault.clear();
    }
}

#[cfg(test)]
mod tests;
