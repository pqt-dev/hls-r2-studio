/** Close/quit flow: confirm when jobs run, abort them, flush the store, then really quit. */

export interface QuitDeps {
    hasActiveJobs: () => boolean;
    /** Shows "Jobs are still running. Quit and cancel them?"; true = quit. */
    confirm: () => Promise<boolean>;
    /** Aborts running jobs and waits for their cleanup. */
    shutdown: () => Promise<void>;
    flush: () => Promise<void>;
    quit: () => void;
    onError?: (error: unknown) => void;
}

export interface PreventableEvent {
    preventDefault(): void;
}

export interface QuitCoordinator {
    /** Wire to the window `close` event. */
    handleWindowClose(event: PreventableEvent, closeWindow: () => void): void;
    /** Wire to the app `before-quit` event. */
    handleBeforeQuit(event: PreventableEvent): void;
}

export function createQuitCoordinator(deps: QuitDeps): QuitCoordinator {
    let confirmed = false;
    let finalized = false;
    let asking = false;
    let quitting = false;

    return {
        handleWindowClose(event, closeWindow) {
            if (confirmed || finalized || !deps.hasActiveJobs()) return;

            event.preventDefault();

            if (asking) return;

            asking = true;
            void deps
                .confirm()
                .then((ok) => {
                    if (ok) {
                        confirmed = true;
                        closeWindow();
                    }
                })
                .finally(() => {
                    asking = false;
                });
        },

        handleBeforeQuit(event) {
            if (finalized) return;

            event.preventDefault();

            if (quitting || asking) return;

            quitting = true;
            void (async () => {
                if (!confirmed && deps.hasActiveJobs()) {
                    asking = true;
                    const ok = await deps.confirm().finally(() => {
                        asking = false;
                    });

                    if (!ok) {
                        quitting = false;

                        return;
                    }

                    confirmed = true;
                }

                try {
                    await deps.shutdown();
                    await deps.flush();
                } catch (error) {
                    deps.onError?.(error);
                }

                finalized = true;
                deps.quit();
            })();
        },
    };
}
