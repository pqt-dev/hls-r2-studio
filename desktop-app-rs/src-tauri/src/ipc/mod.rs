//! IPC commands: one Tauri command per channel in `IpcChannels` (src/shared/ipc.ts).
//!
//! Channel -> command name: replace `:` and `-` with `_` (`app:get-version` -> `app_get_version`).
//! Every command that takes input receives a single argument named `payload`, so the renderer
//! shim calls `invoke(command, { payload })`.
//!
//! Every invoke passes the sender guard (`guard.rs`: main window, app URL) before any command
//! runs; a refused call is rejected with "Forbidden". A command whose input fails validation is
//! rejected with "Request failed" (details are only logged), like the Electron IPC layer.

mod app;
mod auth;
pub mod guard;
mod jobs;
pub mod notices;
mod settings;
pub mod validate;
mod videos;

pub use app::*;
pub use auth::*;
pub use jobs::*;
pub use settings::*;
pub use videos::*;

use serde::{Serialize, Serializer};

/// Rust -> renderer event names (`IpcEvents` in src/shared/ipc.ts with `:` replaced by `-`).
pub const AUTH_CHANGED_EVENT: &str = "auth-changed";
pub const JOBS_UPDATED_EVENT: &str = "jobs-updated";
pub const QUEUE_SUMMARY_EVENT: &str = "queue-summary";

/// Generic rejection of a command (the renderer never sees internal details).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcError {
    /// The payload failed validation, or the handler failed.
    RequestFailed,
}

impl Serialize for IpcError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::RequestFailed => serializer.serialize_str("Request failed"),
        }
    }
}

/// Pins the closure type of `generate_handler!` so it can be wrapped.
fn typed_handler<R: tauri::Runtime, F>(handler: F) -> F
where
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    handler
}

/// Declares the command list once: it is both the registered handler and the name list the tests
/// compare against `IpcChannels`.
macro_rules! register_commands {
    ($($command:ident),+ $(,)?) => {
        /// Names of every registered command.
        pub const COMMAND_NAMES: &[&str] = &[$(stringify!($command)),+];

        /// The `invoke_handler` for the app builder: the sender guard, then the command.
        pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
            let commands = typed_handler::<R, _>(tauri::generate_handler![$($command),+]);

            move |invoke: tauri::ipc::Invoke<R>| {
                if !guard::is_trusted_invoke(&invoke) {
                    guard::reject_untrusted(invoke);

                    return true;
                }

                commands(invoke)
            }
        }
    };
}

register_commands!(
    app_get_version,
    app_open_logs_folder,
    app_open_notices,
    diagnostics_get,
    auth_get_state,
    auth_login,
    auth_logout,
    auth_reload_config,
    settings_get,
    settings_set,
    settings_pick_directory,
    jobs_list,
    jobs_add_files,
    jobs_add_paths,
    jobs_cancel,
    jobs_retry,
    jobs_retry_register,
    jobs_resume,
    jobs_remove,
    jobs_clear_finished,
    jobs_open_embed,
    jobs_copy,
    videos_list,
    videos_get,
    videos_copy_link,
    videos_open_embed,
    videos_update_title,
    videos_delete,
    videos_bulk_delete,
    videos_set_image,
    videos_remove_image,
);

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::COMMAND_NAMES;

    /// Hand-copied from `IpcChannels` in src/shared/ipc.ts.
    const CHANNELS: &[&str] = &[
        "app:get-version",
        "app:open-logs-folder",
        "app:open-notices",
        "diagnostics:get",
        "auth:get-state",
        "auth:login",
        "auth:logout",
        "auth:reload-config",
        "settings:get",
        "settings:set",
        "settings:pick-directory",
        "jobs:list",
        "jobs:add-files",
        "jobs:add-paths",
        "jobs:cancel",
        "jobs:retry",
        "jobs:retry-register",
        "jobs:resume",
        "jobs:remove",
        "jobs:clear-finished",
        "jobs:open-embed",
        "jobs:copy",
        "videos:list",
        "videos:get",
        "videos:copy-link",
        "videos:open-embed",
        "videos:update-title",
        "videos:delete",
        "videos:bulk-delete",
        "videos:set-image",
        "videos:remove-image",
    ];

    fn command_of(channel: &str) -> String {
        channel.replace([':', '-'], "_")
    }

    fn channels_in_ipc_ts() -> Vec<String> {
        let source = include_str!("../../../src/shared/ipc.ts");
        let start = source.find("IpcChannels = {").expect("IpcChannels block");
        let block = &source[start..];
        let block = &block[..block.find("} as const").expect("end of IpcChannels")];

        block
            .lines()
            .filter_map(|line| line.split('\'').nth(1))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn registered_commands_cover_every_channel() {
        let registered: BTreeSet<String> = COMMAND_NAMES.iter().map(|s| s.to_string()).collect();
        let expected: BTreeSet<String> = CHANNELS.iter().map(|c| command_of(c)).collect();

        assert_eq!(
            COMMAND_NAMES.len(),
            registered.len(),
            "duplicate command registered"
        );
        assert_eq!(registered, expected);
    }

    #[test]
    fn event_names_match_ipc_ts() {
        let source = include_str!("../../../src/shared/ipc.ts");

        assert!(source.contains("authChanged: 'auth:changed'"));
        assert!(source.contains("jobsUpdated: 'jobs:updated'"));
        assert!(source.contains("queueSummary: 'queue:summary'"));
        assert_eq!(super::AUTH_CHANGED_EVENT, "auth:changed".replace(':', "-"));
        assert_eq!(super::JOBS_UPDATED_EVENT, "jobs:updated".replace(':', "-"));
        assert_eq!(
            super::QUEUE_SUMMARY_EVENT,
            "queue:summary".replace(':', "-")
        );
    }

    #[test]
    fn ipc_errors_are_generic_strings() {
        assert_eq!(
            serde_json::to_value(super::IpcError::RequestFailed).unwrap(),
            serde_json::json!("Request failed")
        );
        assert_eq!(super::guard::FORBIDDEN, "Forbidden");
    }

    #[test]
    fn hand_copied_channels_match_ipc_ts() {
        let mut from_ts = channels_in_ipc_ts();
        let mut copied: Vec<String> = CHANNELS.iter().map(|s| s.to_string()).collect();

        from_ts.sort();
        copied.sort();
        assert_eq!(from_ts, copied);
    }
}
