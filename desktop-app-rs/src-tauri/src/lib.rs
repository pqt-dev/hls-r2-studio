//! HLS R2 Studio desktop app (Tauri 2). Milestones 1-3: skeleton, IPC commands, persistence
//! (store), logging, settings, token storage, site API client, config, auth and the ffmpeg layer.
//!
//! CSP (see `app.security.csp` in tauri.conf.json; JSON cannot hold comments, so it is explained
//! here). It equals the production policy in src/shared/csp.ts plus ONE addition.
//!
//! `img-src ... https:` lets the Library screen show video thumbnails from the R2 CDN (`<img>`
//! only; scripts, styles and connections stay local).
//!
//! `connect-src ... ipc: http://ipc.localhost` is the Tauri IPC transport: `ipc:` is the custom
//! protocol used on macOS/Linux and `http://ipc.localhost` is used on Windows/Android. Without it
//! every `invoke` is blocked. No other network origin is allowed.
//!
//! Tauri itself appends nonces/hashes for its own injected scripts/styles, so `'unsafe-inline'`
//! is not needed in production. `devCsp` additionally allows `'unsafe-inline'` scripts/styles (the
//! Vite React preamble) and `http://localhost:5173` + `ws://localhost:5173` (HMR); it is used only
//! by `tauri dev`.

pub mod api;
pub mod auth;
pub mod config;
pub mod desktop;
pub mod dto;
pub mod ffmpeg;
pub mod ipc;
pub mod lifecycle;
pub mod logger;
pub mod os_open;
pub mod pipeline;
pub mod queue;
pub mod secure;
pub mod settings;
pub mod site_url;
pub mod state;
pub mod store;
#[cfg(test)]
pub mod test_support;
pub mod window;

use std::sync::Arc;

use lifecycle::{
    handle_startup_failure, panic_text, show_native_error, QuitCoordinator, TauriQuitDeps,
    STARTUP_EXIT_CODE,
};
use logger::{FileLogger, FileLoggerOptions, Log};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// Brings the existing main window to the front (second launch).
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(window::MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Fatal startup error (startupFailure.ts): log, native error box with a fixed text, exit
/// non-zero. `std::process::exit` (not `AppHandle::exit`) so the quit flow cannot intercept it
/// and no hidden process keeps the single-instance lock.
fn fail_startup(app: Option<&AppHandle>, error: &str) -> ! {
    let logger: Option<Arc<dyn Log>> = app.and_then(|app| {
        if let Some(state) = app.try_state::<state::AppState>() {
            return Some(state.logger.clone() as Arc<dyn Log>);
        }

        let dir = app.path().config_dir().ok()?;
        let logs = state::logs_dir(&state::user_data_dir(&dir));

        Some(Arc::new(FileLogger::new(FileLoggerOptions::new(logs))) as Arc<dyn Log>)
    });

    handle_startup_failure(error, logger.as_deref(), show_native_error, || {
        std::process::exit(STARTUP_EXIT_CODE)
    });

    std::process::exit(STARTUP_EXIT_CODE)
}

/// The whole startup (index.ts `bootstrap`). Any error ends in `fail_startup`.
fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // State must exist before the window can invoke any command.
    let user_data = state::user_data_dir(&app.path().config_dir()?);

    // ffmpeg binaries (index.ts): resolved once, used by the queue and the self check.
    let resources_dir = app
        .path()
        .resource_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let binaries = ffmpeg::resolve_binaries(&ffmpeg::ResolveBinariesInput {
        platform: ffmpeg::Platform::current(),
        resources_dir: &resources_dir,
        env: &|key| std::env::var(key).ok(),
        is_packaged: !cfg!(debug_assertions),
    });
    let app_state = state::AppState::init(
        user_data,
        binaries.clone(),
        tauri::async_runtime::handle().inner().clone(),
    );

    app_state.logger.info(
        "App starting",
        Some(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "dev": cfg!(debug_assertions),
        })),
    );

    let handle = app.handle().clone();
    let queue = Arc::clone(&app_state.queue);

    // Push events go to the main window only; no window yet / closed: the event is dropped.
    // Auth changes also drive the queue (needs_sign_in jobs, waiting jobs).
    app_state.auth.subscribe({
        let handle = handle.clone();
        let queue = Arc::clone(&queue);

        Arc::new(move |state: &dto::AuthState| {
            let _ = handle.emit_to(window::MAIN_WINDOW_LABEL, ipc::AUTH_CHANGED_EVENT, state);
            queue.on_auth_changed(state);
        })
    });
    queue.subscribe({
        let handle = handle.clone();

        Arc::new(move |jobs: &[dto::JobDto]| {
            let _ = handle.emit_to(window::MAIN_WINDOW_LABEL, ipc::JOBS_UPDATED_EVENT, jobs);
        })
    });
    queue.subscribe_summary({
        let handle = handle.clone();

        Arc::new(move |summary: &dto::QueueSummary| {
            let _ = handle.emit_to(window::MAIN_WINDOW_LABEL, ipc::QUEUE_SUMMARY_EVENT, summary);
        })
    });

    // Close / quit flow (quitCoordinator.ts).
    let quit_flow = QuitCoordinator::new(
        Arc::new(TauriQuitDeps {
            app: handle.clone(),
            queue: Arc::clone(&queue),
            store: Arc::clone(&app_state.store),
            logger: app_state.logger.clone() as Arc<dyn Log>,
        }),
        tauri::async_runtime::handle().inner().clone(),
    );

    let auth = Arc::clone(&app_state.auth);
    let ffmpeg_status = Arc::clone(&app_state.ffmpeg);
    let ffmpeg_logger = Arc::clone(&app_state.logger) as Arc<dyn Log>;

    app.manage(app_state);
    app.manage(Arc::clone(&quit_flow));

    // Startup recovery before the window exists (running jobs become interrupted / resumable).
    tauri::async_runtime::block_on(queue.recover());

    window::create_main_window(app.handle())?;

    if let Some(window) = app.get_webview_window(window::MAIN_WINDOW_LABEL) {
        let closing = window.clone();

        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let target = closing.clone();

                if quit_flow.handle_window_close(Box::new(move || {
                    let _ = target.close();
                })) {
                    api.prevent_close();
                }
            }
        });
    }

    // Background startup work (index.ts): restore the saved session. Its state changes
    // (signing_in -> signed_in / offline / signed_out) are emitted as `auth-changed`; the
    // renderer also asks for the state on mount, so an early event is never needed.
    tauri::async_runtime::spawn(async move {
        auth.restore().await;
    });

    // ffmpeg self check: never blocks the window; a missing ffmpeg only makes `diagnostics_get`
    // report `ok: false` and keeps jobs from starting. The queue is kicked when it is done.
    tauri::async_runtime::spawn(async move {
        ffmpeg::run_startup_self_check(
            Arc::new(ffmpeg::ProcessTextRunner::new(
                Arc::new(ffmpeg::ProcessRunner::new()),
                &binaries.ffmpeg,
            )),
            ffmpeg_status,
            ffmpeg_logger,
        )
        .await;
        queue.kick();
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let built = tauri::Builder::default()
        // Registered first: a second launch exits here and only focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        // Only used from Rust (folder / file pickers, quit confirmation); no webview permission
        // is granted.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(ipc::handler())
        .setup(|app| {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(app)));

            match outcome {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => fail_startup(Some(app.handle()), &error.to_string()),
                Err(payload) => fail_startup(Some(app.handle()), &panic_text(&*payload)),
            }
        })
        .build(tauri::generate_context!());

    let app = match built {
        Ok(app) => app,
        Err(error) => fail_startup(None, &error.to_string()),
    };

    app.run(|app, event| match event {
        // Window closed / quit requested: confirm when jobs run, cancel them, flush, then exit.
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(quit_flow) = app.try_state::<Arc<QuitCoordinator>>() {
                if quit_flow.handle_before_quit() {
                    api.prevent_exit();
                }
            }
        }
        // Pending (debounced) store writes must reach the disk before the process ends.
        tauri::RunEvent::Exit => {
            if let Some(state) = app.try_state::<state::AppState>() {
                state.store.flush();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn csp_is_strict_and_only_adds_the_ipc_transport_and_https_images() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();

        for directive in [
            "default-src 'self'",
            "script-src 'self';",
            "style-src 'self';",
            "img-src 'self' data: https:",
            "connect-src 'self' ipc: http://ipc.localhost;",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ] {
            assert!(csp.contains(directive), "missing {directive}");
        }
        assert!(!csp.contains("unsafe-inline") && !csp.contains("unsafe-eval"));
    }

    #[test]
    fn window_is_created_in_code_and_capabilities_are_minimal() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"], serde_json::json!([]));

        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(caps["permissions"], serde_json::json!(["core:default"]));
        assert_eq!(caps["windows"], serde_json::json!(["main"]));
    }
}
