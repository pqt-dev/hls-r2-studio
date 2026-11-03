import { IpcChannels } from '../../shared/ipc';
import type { ActionResult, DiagnosticsDto } from '../../shared/ipc';
import { createAuthHandlers, type AuthHandlerDeps } from './authHandlers';
import { createJobsHandlers, type JobsHandlerDeps } from './jobsHandlers';
import type { NoticesOutcome } from './notices';
import { expectNoArgs } from './validate';

/** A channel handler: validates the raw payload, then runs. Electron-free so it can be tested. */
export type IpcHandler = (args: readonly unknown[]) => unknown | Promise<unknown>;

export interface AppHandlerDeps {
    getAppVersion: () => string;
    getDiagnostics: () => DiagnosticsDto;
    /** Opens the logs folder; resolves to an empty string on success or an error text. */
    openLogsFolder: () => Promise<string>;
    /** Opens the third-party notices file. */
    openNotices: () => Promise<NoticesOutcome>;
}

export type HandlerDeps = AppHandlerDeps & AuthHandlerDeps & JobsHandlerDeps;

export function createHandlers(deps: HandlerDeps): Record<string, IpcHandler> {
    return {
        [IpcChannels.appGetVersion]: (args) => {
            expectNoArgs(args);

            return deps.getAppVersion();
        },
        [IpcChannels.diagnosticsGet]: (args) => {
            expectNoArgs(args);

            return deps.getDiagnostics();
        },
        [IpcChannels.appOpenLogsFolder]: async (args): Promise<ActionResult> => {
            expectNoArgs(args);

            const error = await deps.openLogsFolder();

            return error === ''
                ? { ok: true }
                : { ok: false, error: 'Could not open the logs folder.' };
        },
        [IpcChannels.appOpenNotices]: async (args): Promise<ActionResult> => {
            expectNoArgs(args);

            switch (await deps.openNotices()) {
                case 'opened':
                    return { ok: true };
                case 'not_found':
                    return { ok: false, error: 'Notices file not found.' };
                case 'failed':
                    return { ok: false, error: 'Could not open the notices file.' };
            }
        },
        ...createAuthHandlers(deps),
        ...createJobsHandlers(deps),
    };
}
