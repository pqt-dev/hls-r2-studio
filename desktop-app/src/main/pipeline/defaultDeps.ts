/** Real implementations of the side-effecting dependencies (used by the app and the smoke CLI). */
import { statfs } from 'node:fs/promises';
import type { Binaries } from '../ffmpeg/binaries';
import { createRunner } from '../ffmpeg/runner';
import type { Logger } from '../logger';
import type { PipelineDeps, RegisterClient } from './deps';
import { createR2Client } from './steps/s3Client';

export async function freeBytesOf(dir: string): Promise<number> {
    const info = await statfs(dir);

    return Number(info.bavail) * Number(info.bsize);
}

/** Sleeps `ms`, resolving early (without error) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();

            return;
        }

        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface DefaultDepsInput {
    binaries: Binaries;
    tmpRoot: string;
    register: RegisterClient;
    logger: Logger;
    platform?: NodeJS.Platform;
    threads?: number | null;
}

export function createDefaultDeps(input: DefaultDepsInput): PipelineDeps {
    return {
        binaries: input.binaries,
        run: createRunner({ platform: input.platform }),
        createS3Client: createR2Client,
        register: input.register,
        tmpRoot: input.tmpRoot,
        now: () => new Date(),
        sleep: abortableSleep,
        freeBytes: freeBytesOf,
        logger: input.logger,
        threads: input.threads,
    };
}
