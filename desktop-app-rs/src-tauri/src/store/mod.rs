//! Persistence: atomic JSON store, the app document and the history cap.

pub mod app_store;
pub mod file_ops;
pub mod history;
pub mod json_store;
pub mod model;
#[cfg(test)]
pub mod testing;

pub use app_store::{
    create_app_store, create_default_app_data, is_valid_app_data, AppStore, AppStoreOptions,
    APP_SCHEMA_VERSION, STORE_FILE_NAME,
};
pub use file_ops::{FileOps, StdFileOps};
pub use history::{cap_history, MAX_DONE_HISTORY};
pub use json_store::{JsonStore, JsonStoreOptions};
pub use model::{ActivityEntry, AppData, AppSettings, JobMode, JobRecord};
