//! Holds the latest site config IN MEMORY ONLY. Port of
//! desktop-app/src/main/config/configService.ts. The R2 secret never leaves this object except
//! through `get_config()` for main-side consumers (the future queue).

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::api::{AppConfig, PublicConfig, SiteApiError};

pub const STALE_CONFIG_MESSAGE: &str = "The site config was discarded because the session changed.";

#[async_trait::async_trait]
pub trait ConfigFetcher: Send + Sync {
    async fn get_config(&self) -> Result<AppConfig, SiteApiError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConfigError {
    /// `StaleConfigError`: the config was cleared (sign-out, 401, site change) while the request
    /// was in flight. The fetched config was dropped and never stored.
    Stale,
    /// Any other failure. The previous config is left untouched.
    Site(SiteApiError),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stale => f.write_str(STALE_CONFIG_MESSAGE),
            Self::Site(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Default)]
struct Inner {
    config: Option<AppConfig>,
    known: bool,
    /// Incremented by every `clear()`; a refresh that started before it must not store its result.
    generation: u64,
}

impl Inner {
    fn public_view(&self) -> Option<PublicConfig> {
        if !self.known {
            return None;
        }

        Some(PublicConfig {
            r2_configured: self.config.is_some(),
            transcode: self.config.as_ref().map(|c| c.transcode.clone()),
        })
    }
}

pub struct ConfigService {
    fetcher: Arc<dyn ConfigFetcher>,
    inner: Mutex<Inner>,
}

impl ConfigService {
    pub fn new(fetcher: Arc<dyn ConfigFetcher>) -> Self {
        Self {
            fetcher,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Full config including R2 credentials. For main-side consumers (queue) only.
    pub fn get_config(&self) -> Option<AppConfig> {
        self.lock().config.clone()
    }

    /// Safe view for IPC: no credentials.
    pub fn get_public(&self) -> Option<PublicConfig> {
        self.lock().public_view()
    }

    /// Fetches the config. A 409 `r2_not_configured` is a normal state (`r2_configured: false`);
    /// any other failure is returned as `ConfigError::Site` and leaves the previous config
    /// untouched. If `clear()` ran while the request was pending, the result is discarded and
    /// `ConfigError::Stale` is returned.
    pub async fn refresh(&self) -> Result<PublicConfig, ConfigError> {
        let started = self.lock().generation;
        let fetched = self.fetcher.get_config().await;
        let mut inner = self.lock();

        if inner.generation != started {
            return Err(ConfigError::Stale);
        }

        match fetched {
            Ok(config) => {
                inner.config = Some(config);
                inner.known = true;
            }
            Err(error) if error.status == Some(409) && error.has_code("r2_not_configured") => {
                inner.config = None;
                inner.known = true;
            }
            Err(error) => return Err(ConfigError::Site(error)),
        }

        Ok(inner.public_view().unwrap_or(PublicConfig {
            r2_configured: false,
            transcode: None,
        }))
    }

    pub fn clear(&self) {
        let mut inner = self.lock();

        inner.generation += 1;
        inner.config = None;
        inner.known = false;
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;

    use serde_json::json;

    use super::*;
    use crate::api::app_config::testing::config;
    use crate::logger::testing::RecordingLogger;
    use crate::logger::Log;
    use crate::test_support::{tick, Deferred};

    type Reply = Pin<Box<dyn Future<Output = Result<AppConfig, SiteApiError>> + Send>>;

    struct FnFetcher(Box<dyn Fn() -> Reply + Send + Sync>);

    #[async_trait::async_trait]
    impl ConfigFetcher for FnFetcher {
        async fn get_config(&self) -> Result<AppConfig, SiteApiError> {
            (self.0)().await
        }
    }

    fn service(f: impl Fn() -> Reply + Send + Sync + 'static) -> Arc<ConfigService> {
        Arc::new(ConfigService::new(Arc::new(FnFetcher(Box::new(f)))))
    }

    fn ok() -> Reply {
        Box::pin(async { Ok(config()) })
    }

    fn not_configured() -> SiteApiError {
        SiteApiError::new("x").status(409).code("r2_not_configured")
    }

    #[tokio::test]
    async fn is_empty_until_refreshed() {
        let s = service(|| Box::pin(async { Err(SiteApiError::new("x")) }));

        assert!(s.get_config().is_none());
        assert!(s.get_public().is_none());
    }

    #[tokio::test]
    async fn keeps_the_full_config_for_main_and_exposes_only_a_safe_view() {
        let s = service(ok);
        let view = s.refresh().await.unwrap();

        assert_eq!(s.get_config(), Some(config()));
        assert_eq!(
            view,
            PublicConfig {
                r2_configured: true,
                transcode: Some(config().transcode)
            }
        );

        for value in [view, s.get_public().unwrap()] {
            let text = serde_json::to_string(&value).unwrap();

            for secret in [
                "super-secret-value",
                "AKIA-SECRET-ID",
                "bucket",
                "cloudflarestorage",
            ] {
                assert!(!text.contains(secret), "{text}");
            }
        }
    }

    #[tokio::test]
    async fn does_not_leak_the_secret_through_logs_or_debug_output() {
        let s = service(ok);
        let logger = RecordingLogger::default();

        s.refresh().await.unwrap();
        // The full config has no `Serialize`; the only way to log it is its (redacted) Debug.
        logger.info(
            "config loaded",
            Some(json!({ "config": format!("{:?}", s.get_config()) })),
        );
        logger.info(
            "public",
            Some(serde_json::to_value(s.get_public()).unwrap()),
        );

        let text = logger.text();
        assert!(!text.contains("super-secret-value"));
        assert!(!text.contains("AKIA-SECRET-ID"));
    }

    #[tokio::test]
    async fn maps_409_r2_not_configured_to_a_clear_not_configured_state() {
        let first = Arc::new(Mutex::new(true));
        let s = service(move || {
            let mut first = first.lock().unwrap();

            if *first {
                *first = false;
                ok()
            } else {
                Box::pin(async { Err(not_configured()) })
            }
        });

        s.refresh().await.unwrap();
        let view = s.refresh().await.unwrap();

        assert_eq!(
            view,
            PublicConfig {
                r2_configured: false,
                transcode: None
            }
        );
        assert!(s.get_config().is_none());
    }

    #[tokio::test]
    async fn returns_other_errors_and_keeps_the_previous_config() {
        let fail = Arc::new(Mutex::new(false));
        let s = {
            let fail = Arc::clone(&fail);
            service(move || {
                if *fail.lock().unwrap() {
                    Box::pin(async { Err(SiteApiError::new("down").network()) })
                } else {
                    ok()
                }
            })
        };

        s.refresh().await.unwrap();
        *fail.lock().unwrap() = true;

        assert!(matches!(s.refresh().await, Err(ConfigError::Site(_))));
        assert_eq!(s.get_config(), Some(config()));
    }

    #[tokio::test]
    async fn clear_forgets_everything() {
        let s = service(ok);

        s.refresh().await.unwrap();
        s.clear();

        assert!(s.get_config().is_none());
        assert!(s.get_public().is_none());
    }

    #[tokio::test]
    async fn discards_a_config_that_arrives_after_clear() {
        let pending = Deferred::<Result<AppConfig, SiteApiError>>::new();
        let s = {
            let pending = Arc::clone(&pending);
            service(move || Box::pin(pending.wait()))
        };
        let refresh = {
            let s = Arc::clone(&s);
            tokio::spawn(async move { s.refresh().await })
        };

        tick().await;
        s.clear();
        pending.resolve(Ok(config()));

        assert_eq!(refresh.await.unwrap(), Err(ConfigError::Stale));
        assert!(s.get_config().is_none());
        assert!(s.get_public().is_none());
    }

    #[tokio::test]
    async fn discards_a_409_and_a_failure_that_arrive_after_clear() {
        for answer in [not_configured(), SiteApiError::new("down").network()] {
            let pending = Deferred::<Result<AppConfig, SiteApiError>>::new();
            let s = {
                let pending = Arc::clone(&pending);
                service(move || Box::pin(pending.wait()))
            };
            let refresh = {
                let s = Arc::clone(&s);
                tokio::spawn(async move { s.refresh().await })
            };

            tick().await;
            s.clear();
            pending.resolve(Err(answer));

            assert_eq!(refresh.await.unwrap(), Err(ConfigError::Stale));
            assert!(s.get_public().is_none());
        }
    }

    #[tokio::test]
    async fn still_stores_the_config_of_a_refresh_started_after_clear() {
        let s = service(ok);

        s.clear();
        s.refresh().await.unwrap();

        assert_eq!(s.get_config(), Some(config()));
    }

    #[test]
    fn stale_error_message() {
        assert_eq!(ConfigError::Stale.to_string(), STALE_CONFIG_MESSAGE);
    }
}
