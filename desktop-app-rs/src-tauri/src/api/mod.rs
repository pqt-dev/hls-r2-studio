//! Site API: HTTP client, errors and the app config document.

pub mod app_config;
pub mod error;
pub mod image_upload;
pub mod logs;
pub mod overview;
pub mod site_client;
#[cfg(test)]
pub mod test_server;
pub mod video_links;
pub mod videos;

pub use app_config::{
    parse_app_config, r2_location_problem, AppConfig, AppConfigR2, AppConfigTranscode,
    PublicConfig, Resolution,
};
pub use error::SiteApiError;
pub use site_client::{
    user_agent, LoginResult, SiteClient, SiteClientOptions, DEFAULT_TIMEOUT, MAX_BODY_BYTES,
};
