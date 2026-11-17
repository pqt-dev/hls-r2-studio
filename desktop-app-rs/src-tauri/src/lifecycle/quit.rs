//! Close/quit flow (port of desktop-app/src/main/lifecycle/quitCoordinator.ts): confirm when
//! jobs run, cancel them (the queue waits up to 15 s for their cleanup), flush the store, then
//! really quit. Paused uploads (`upload_interrupted`) are not running, so their temp files and
//! R2 objects stay for a resume on the next launch.
//!
//! Wiring (lib.rs): the main window's `CloseRequested` -> `handle_window_close` (prevent the
//! close when it returns true); `RunEvent::ExitRequested` -> `handle_before_quit` (prevent the
//! exit when it returns true); `QuitDeps::quit` calls `AppHandle::exit(0)`, whose own
//! `ExitRequested` then passes because the flow is finalized.

use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use tokio::runtime::Handle;

pub const QUIT_DIALOG_TITLE: &str = "HLS R2 Studio";
pub const QUIT_DIALOG_MESSAGE: &str = "Jobs are still running. Quit and cancel them?";
pub const QUIT_BUTTON: &str = "Quit";
pub const KEEP_WORKING_BUTTON: &str = "Keep working";

#[async_trait]
pub trait QuitDeps: Send + Sync {
    fn has_active_jobs(&self) -> bool;
    /// Shows "Jobs are still running. Quit and cancel them?"; true = quit.
    async fn confirm(&self) -> bool;
    /// Cancels running jobs and waits (bounded) for their cleanup.
    async fn shutdown(&self) -> Result<(), String>;
    async fn flush(&self);
    fn quit(&self);
    fn on_error(&self, _error: &str) {}
}

#[derive(Default)]
struct Flags {
    confirmed: bool,
    finalized: bool,
    asking: bool,
    quitting: bool,
}

pub struct QuitCoordinator {
    deps: Arc<dyn QuitDeps>,
    runtime: Handle,
    flags: Mutex<Flags>,
}

impl QuitCoordinator {
    pub fn new(deps: Arc<dyn QuitDeps>, runtime: Handle) -> Arc<Self> {
        Arc::new(Self {
            deps,
            runtime,
            flags: Mutex::new(Flags::default()),
        })
    }

    fn flags(&self) -> MutexGuard<'_, Flags> {
        self.flags.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Window close request. Returns true when the close must be prevented; `close_window` is
    /// called once the user confirmed (the re-issued close then passes).
    pub fn handle_window_close(
        self: &Arc<Self>,
        close_window: Box<dyn FnOnce() + Send + 'static>,
    ) -> bool {
        {
            let mut flags = self.flags();

            if flags.confirmed || flags.finalized || !self.deps.has_active_jobs() {
                return false;
            }

            if flags.asking {
                return true;
            }

            flags.asking = true;
        }

        let me = Arc::clone(self);

        self.runtime.spawn(async move {
            let ok = me.deps.confirm().await;

            if ok {
                me.flags().confirmed = true;
                close_window();
            }

            me.flags().asking = false;
        });

        true
    }

    /// App exit request. Returns true when the exit must be prevented (the flow then quits by
    /// itself once the jobs are stopped and the store is flushed, or stays when declined).
    pub fn handle_before_quit(self: &Arc<Self>) -> bool {
        {
            let mut flags = self.flags();

            if flags.finalized {
                return false;
            }

            if flags.quitting || flags.asking {
                return true;
            }

            flags.quitting = true;
        }

        let me = Arc::clone(self);

        self.runtime.spawn(async move {
            let must_ask = {
                let mut flags = me.flags();
                let ask = !flags.confirmed && me.deps.has_active_jobs();

                if ask {
                    flags.asking = true;
                }

                ask
            };

            if must_ask {
                let ok = me.deps.confirm().await;
                let mut flags = me.flags();

                flags.asking = false;

                if !ok {
                    flags.quitting = false;

                    return;
                }

                flags.confirmed = true;
            }

            match me.deps.shutdown().await {
                Ok(()) => me.deps.flush().await,
                Err(error) => me.deps.on_error(&error),
            }

            me.flags().finalized = true;
            me.deps.quit();
        });

        true
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::test_support::tick;

    struct Deps {
        active: AtomicBool,
        answer: bool,
        shutdown_fails: bool,
        order: Mutex<Vec<&'static str>>,
        confirms: AtomicUsize,
    }

    #[async_trait]
    impl QuitDeps for Deps {
        fn has_active_jobs(&self) -> bool {
            self.active.load(Ordering::SeqCst)
        }

        async fn confirm(&self) -> bool {
            self.confirms.fetch_add(1, Ordering::SeqCst);
            self.order.lock().unwrap().push("confirm");
            self.answer
        }

        async fn shutdown(&self) -> Result<(), String> {
            self.order.lock().unwrap().push("shutdown");
            self.active.store(false, Ordering::SeqCst);

            if self.shutdown_fails {
                Err("x".into())
            } else {
                Ok(())
            }
        }

        async fn flush(&self) {
            self.order.lock().unwrap().push("flush");
        }

        fn quit(&self) {
            self.order.lock().unwrap().push("quit");
        }
    }

    fn setup(active: bool, answer: bool) -> (Arc<QuitCoordinator>, Arc<Deps>) {
        let deps = Arc::new(Deps {
            active: AtomicBool::new(active),
            answer,
            shutdown_fails: false,
            order: Mutex::new(vec![]),
            confirms: AtomicUsize::new(0),
        });

        (
            QuitCoordinator::new(Arc::clone(&deps) as Arc<dyn QuitDeps>, Handle::current()),
            deps,
        )
    }

    fn order(deps: &Deps) -> Vec<&'static str> {
        deps.order.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn lets_the_window_close_freely_when_nothing_runs() {
        let (c, deps) = setup(false, true);

        assert!(!c.handle_window_close(Box::new(|| ())));
        tick().await;
        assert_eq!(deps.confirms.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn asks_before_closing_while_jobs_run_and_closes_after_confirmation() {
        let (c, deps) = setup(true, true);
        let closed = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&closed);

        assert!(c.handle_window_close(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })));
        tick().await;

        assert_eq!(deps.confirms.load(Ordering::SeqCst), 1);
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        // The re-issued close is not blocked again.
        assert!(!c.handle_window_close(Box::new(|| ())));
    }

    #[tokio::test]
    async fn keeps_the_window_open_when_the_user_declines() {
        let (c, _deps) = setup(true, false);
        let closed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&closed);

        assert!(c.handle_window_close(Box::new(move || flag.store(true, Ordering::SeqCst))));
        tick().await;

        assert!(!closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_second_close_while_asking_is_blocked_without_a_second_dialog() {
        let (c, deps) = setup(true, false);

        assert!(c.handle_window_close(Box::new(|| ())));
        assert!(c.handle_window_close(Box::new(|| ())));
        tick().await;

        assert_eq!(deps.confirms.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn quit_with_running_jobs_confirms_cancels_flushes_then_quits() {
        let (c, deps) = setup(true, true);

        assert!(c.handle_before_quit());
        tick().await;

        assert_eq!(order(&deps), ["confirm", "shutdown", "flush", "quit"]);
        assert!(!c.handle_before_quit());
    }

    #[tokio::test]
    async fn quit_without_jobs_does_not_ask_but_still_flushes() {
        let (c, deps) = setup(false, true);

        assert!(c.handle_before_quit());
        tick().await;

        assert_eq!(order(&deps), ["shutdown", "flush", "quit"]);
    }

    #[tokio::test]
    async fn declining_the_quit_cancels_it() {
        let (c, deps) = setup(true, false);

        assert!(c.handle_before_quit());
        tick().await;

        assert_eq!(order(&deps), ["confirm"]);
        // A later quit asks again.
        assert!(c.handle_before_quit());
        tick().await;
        assert_eq!(deps.confirms.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn still_quits_when_shutdown_fails() {
        let deps = Arc::new(Deps {
            active: AtomicBool::new(false),
            answer: true,
            shutdown_fails: true,
            order: Mutex::new(vec![]),
            confirms: AtomicUsize::new(0),
        });
        let c = QuitCoordinator::new(Arc::clone(&deps) as Arc<dyn QuitDeps>, Handle::current());

        c.handle_before_quit();
        tick().await;

        assert_eq!(order(&deps), ["shutdown", "quit"]);
    }

    #[tokio::test]
    async fn the_window_close_confirmation_also_covers_the_following_quit() {
        let (c, deps) = setup(true, true);

        c.handle_window_close(Box::new(|| ()));
        tick().await;
        // The last window closed: the app now exits without asking again.
        deps.active.store(true, Ordering::SeqCst);
        assert!(c.handle_before_quit());
        tick().await;

        assert_eq!(deps.confirms.load(Ordering::SeqCst), 1);
        assert_eq!(order(&deps), ["confirm", "shutdown", "flush", "quit"]);
    }
}
