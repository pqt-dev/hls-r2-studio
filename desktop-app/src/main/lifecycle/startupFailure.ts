import type { Logger } from '../logger';

export interface StartupFailureDeps {
    /** Null when the failure happened before the logger existed. */
    logger: Logger | null;
    showError: (title: string, content: string) => void;
    quit: () => void;
}

export const STARTUP_ERROR_TITLE = 'HLS R2 Studio could not start';
export const STARTUP_ERROR_MESSAGE =
    'An unexpected error stopped the app from starting. Details were written to the log file. ' +
    'Please start the app again; if this keeps happening, contact support.';

/**
 * Handles an error thrown while starting up: logs it (the logger redacts), shows a native error
 * dialog and quits, so no hidden process stays behind holding the single-instance lock.
 * Never throws.
 */
export function handleStartupFailure(error: unknown, deps: StartupFailureDeps): void {
    try {
        deps.logger?.error('Startup failed', { error });
    } catch {
        // Logging must never block the exit path.
    }

    try {
        deps.showError(STARTUP_ERROR_TITLE, STARTUP_ERROR_MESSAGE);
    } catch {
        // Ignore: we still want to quit.
    }

    deps.quit();
}
