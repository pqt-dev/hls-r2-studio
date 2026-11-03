import { IpcChannels } from '../../shared/ipc';
import type { ActionResult, AddFilesResult, AuthState, CopyKind, JobDto } from '../../shared/ipc';
import type { JobRecord } from '../../shared/types';
import { openExternalHttps } from '../security/external';
import type { IpcHandler } from './handlers';
import {
    expectJobId,
    expectNoArgs,
    expectOneOf,
    expectSingleObject,
    expectStringArray,
} from './validate';

export const MAX_ADD_PATHS = 1000;

export interface JobsHandlerDeps {
    queue: {
        list(): JobDto[];
        addFiles(
            paths: readonly string[],
        ): Promise<{ added: number; rejected: AddFilesResult['rejected'] }>;
        cancel(id: string): Promise<ActionResult>;
        retry(id: string): Promise<ActionResult>;
        retryRegister(id: string): Promise<ActionResult>;
        remove(id: string): ActionResult;
        clearFinished(): ActionResult;
        getJob(id: string): JobRecord | undefined;
    };
    /** Site URL of the current session/settings; the only host embed links may open. */
    getSiteUrl: () => AuthState['siteUrl'];
    /** Native file dialog; null when the user cancelled. */
    pickVideoFiles: () => Promise<string[] | null>;
    writeClipboard: (text: string) => void;
    openExternal: (url: string) => Promise<void>;
}

const COPY_KINDS: readonly CopyKind[] = ['embed-url', 'shortcode'];
const FRIENDLY_ID = /^[a-z0-9]{1,32}$/;

function parseId(args: readonly unknown[], name: string): string {
    return expectJobId(expectSingleObject(args, name, ['id'])['id']);
}

/** True when `embedUrl` is https and served by the same host as the configured site. */
export function isEmbedUrlOfSite(embedUrl: string, siteUrl: string | undefined): boolean {
    if (siteUrl === undefined || siteUrl === '') return false;

    try {
        const embed = new URL(embedUrl);
        const site = new URL(siteUrl);

        return (
            embed.protocol === 'https:' && site.protocol === 'https:' && embed.host === site.host
        );
    } catch {
        return false;
    }
}

export function createJobsHandlers(deps: JobsHandlerDeps): Record<string, IpcHandler> {
    const { queue } = deps;

    return {
        [IpcChannels.jobsList]: (args) => {
            expectNoArgs(args);

            return queue.list();
        },

        [IpcChannels.jobsAddFiles]: async (args): Promise<AddFilesResult> => {
            expectNoArgs(args);

            const paths = await deps.pickVideoFiles();

            if (paths === null || paths.length === 0) {
                return { added: 0, rejected: [], canceled: true };
            }

            // The paths come from our own dialog but are validated like any other input.
            const outcome = await queue.addFiles(paths.slice(0, MAX_ADD_PATHS));

            return { ...outcome, canceled: false };
        },

        [IpcChannels.jobsAddPaths]: async (args): Promise<AddFilesResult> => {
            const object = expectSingleObject(args, 'paths', ['paths']);
            const paths = expectStringArray(object['paths'], 'paths', MAX_ADD_PATHS);
            const outcome = await queue.addFiles(paths);

            return { ...outcome, canceled: false };
        },

        [IpcChannels.jobsCancel]: (args) => queue.cancel(parseId(args, 'cancel')),
        [IpcChannels.jobsRetry]: (args) => queue.retry(parseId(args, 'retry')),
        [IpcChannels.jobsRetryRegister]: (args) =>
            queue.retryRegister(parseId(args, 'retry-register')),
        [IpcChannels.jobsRemove]: (args) => queue.remove(parseId(args, 'remove')),

        [IpcChannels.jobsClearFinished]: (args) => {
            expectNoArgs(args);

            return queue.clearFinished();
        },

        [IpcChannels.jobsOpenEmbed]: async (args): Promise<ActionResult> => {
            const embedUrl = queue.getJob(parseId(args, 'open-embed'))?.registered?.embed_url;

            if (embedUrl === undefined)
                return { ok: false, error: 'This video has no embed URL yet.' };

            if (!isEmbedUrlOfSite(embedUrl, deps.getSiteUrl())) {
                return { ok: false, error: 'The embed URL does not belong to the signed-in site.' };
            }

            const opened = await openExternalHttps(embedUrl, deps.openExternal);

            return opened ? { ok: true } : { ok: false, error: 'Could not open the link.' };
        },

        [IpcChannels.jobsCopy]: (args): ActionResult => {
            const object = expectSingleObject(args, 'copy', ['id', 'kind']);
            const id = expectJobId(object['id']);
            const kind = expectOneOf(object['kind'], 'kind', COPY_KINDS);
            const registered = queue.getJob(id)?.registered;

            if (!registered) return { ok: false, error: 'This video is not registered yet.' };

            if (kind === 'embed-url') {
                deps.writeClipboard(registered.embed_url);

                return { ok: true };
            }

            // The id ends up inside a quoted shortcode attribute: keep it strictly alphanumeric.
            if (!FRIENDLY_ID.test(registered.public_id)) {
                return { ok: false, error: 'The video ID is not valid.' };
            }

            deps.writeClipboard(`[hls_embed_vl id="${registered.public_id}"]`);

            return { ok: true };
        },
    };
}
