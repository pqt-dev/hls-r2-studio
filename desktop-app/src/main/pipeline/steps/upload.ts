/** R2 upload (spec 4.4 step 6): 5 concurrent PutObject streams, playlist.m3u8 strictly last. */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from '../../logger';
import { PLAYLIST_FILE } from '../fileNames';
import { PipelineError, cancelledError, uploadInterruptedError } from '../errors';
import { runPool } from '../pool';
import { classifyUploadError } from '../upload/classifyError';
import {
    UPLOAD_CONCURRENCY,
    UPLOAD_RETRY_DELAYS_MS,
    contentTypeFor,
    listUploadFiles,
    objectKey,
    progressFromUploaded,
} from '../upload/plan';

/** Continuous network failure (no successful file) after which the upload is interrupted. */
export const NETWORK_STALL_BUDGET_MS = 30 * 60 * 1000;
/** Waits between attempts of a file that keeps failing with a network error; the last repeats. */
export const NETWORK_BACKOFF_MS: readonly number[] = [2000, 5000, 10000, 20000, 30000, 60000];
/** `onNetworkWait` is called at most this often. */
export const NETWORK_WAIT_NOTIFY_INTERVAL_MS = 5000;

export interface NetworkWaitInfo {
    /** Epoch ms when the current outage started (first network failure since the last success). */
    since: number;
    /** Network failures seen since the outage started (all files together). */
    attempt: number;
    nextRetryInMs: number;
    budgetRemainingMs: number;
}

/** Test seams for the network-wait policy. All optional. */
export interface UploadTuning {
    /** Epoch ms clock. Default `Date.now`. */
    now?: () => number;
    /** Extra ms added to a backoff delay. Default: up to 20% of the delay, random. */
    jitter?: (baseMs: number) => number;
    /** Default {@link NETWORK_STALL_BUDGET_MS}. */
    stallBudgetMs?: number;
}

export interface NetworkHooks {
    onNetworkWait?: (info: NetworkWaitInfo) => void;
    /** Called when the first upload succeeds after `onNetworkWait` was called. */
    onNetworkRestored?: () => void;
}

export interface UploadFilesInput extends NetworkHooks, UploadTuning {
    client: S3Client;
    bucket: string;
    prefix: string;
    /** Job directory holding the files. */
    dir: string;
    /** Names to upload; when it contains the playlist it is uploaded strictly last. */
    files: readonly string[];
    /** Byte size of each file in `files`. */
    sizes: ReadonlyMap<string, number>;
    /** Progress is `(initialDone + uploaded) / totalCount` (files skipped on resume count as done). */
    totalCount: number;
    initialDone: number;
    signal: AbortSignal;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    logger: Logger;
    /** Upload stage fraction (files done / total), never decreasing. */
    onProgress: (fraction: number) => void;
    /** Called once, right before the first PutObject is sent (R2 may now hold objects). */
    onUploadStarted: () => void;
}

export interface UploadInput
    extends
        NetworkHooks,
        UploadTuning,
        Omit<UploadFilesInput, 'files' | 'sizes' | 'totalCount' | 'initialDone'> {
    /** Called once, after the playlist (the last file) was uploaded. */
    onPlaylistUploaded: () => void;
}

export interface UploadResult {
    /** Names of the uploaded files, playlist last. */
    files: string[];
}

/**
 * Shared (per upload step, not per file) network stall state: the outage starts at the first
 * network failure after the last success and any success ends it.
 */
class NetworkStall {
    private failingSince: number | null = null;
    private attempts = 0;
    private lastNotifyAt = Number.NEGATIVE_INFINITY;
    private notified = false;
    private readonly now: () => number;
    private readonly jitter: (baseMs: number) => number;
    private readonly budgetMs: number;

    constructor(
        tuning: UploadTuning,
        private readonly hooks: NetworkHooks,
        private readonly logger: Logger,
    ) {
        this.now = tuning.now ?? Date.now;
        this.jitter = tuning.jitter ?? ((base) => base * 0.2 * Math.random());
        this.budgetMs = tuning.stallBudgetMs ?? NETWORK_STALL_BUDGET_MS;
    }

    /** Delay before the next attempt of a file (`fileFailures` = its network failures so far), or null when the budget is used up. */
    onNetworkFailure(fileFailures: number): number | null {
        const now = this.now();

        this.failingSince ??= now;

        const remaining = this.budgetMs - (now - this.failingSince);

        if (remaining <= 0) return null;

        this.attempts++;

        const base = NETWORK_BACKOFF_MS[Math.min(fileFailures, NETWORK_BACKOFF_MS.length - 1)] ?? 0;
        const delay = Math.min(base + Math.max(0, this.jitter(base)), remaining);

        if (now - this.lastNotifyAt >= NETWORK_WAIT_NOTIFY_INTERVAL_MS) {
            this.lastNotifyAt = now;
            this.notified = true;
            this.callHook(() =>
                this.hooks.onNetworkWait?.({
                    since: this.failingSince ?? now,
                    attempt: this.attempts,
                    nextRetryInMs: delay,
                    budgetRemainingMs: remaining,
                }),
            );
        }

        return delay;
    }

    onSuccess(): void {
        const wasNotified = this.notified;

        this.failingSince = null;
        this.attempts = 0;
        this.notified = false;
        this.lastNotifyAt = Number.NEGATIVE_INFINITY;

        if (wasNotified) this.callHook(() => this.hooks.onNetworkRestored?.());
    }

    private callHook(call: () => void): void {
        try {
            call();
        } catch (error) {
            this.logger.warn('A network status hook failed.', { error });
        }
    }
}

/**
 * Uploads `files` (playlist last) with the retry policy: a network failure is retried with
 * exponential backoff until the shared stall budget is used up (then `upload_interrupted`), any
 * other failure gets {@link UPLOAD_RETRY_DELAYS_MS} (3 attempts) and then fails.
 */
export async function uploadFiles(input: UploadFilesInput): Promise<void> {
    const others = input.files.filter((n) => n !== PLAYLIST_FILE);
    const hasPlaylist = input.files.includes(PLAYLIST_FILE);
    const stall = new NetworkStall(input, input, input.logger);
    // Aborted on the first failure so files that wait for the network stop at once.
    const internal = new AbortController();
    const signal = AbortSignal.any([input.signal, internal.signal]);
    let first: { error: unknown } | null = null;
    let done = input.initialDone;
    let started = false;

    function markStarted(): void {
        if (started) return;
        started = true;
        input.onUploadStarted();
    }

    async function putOne(name: string): Promise<void> {
        const size = input.sizes.get(name) ?? 0;
        let otherFailures = 0;
        let networkFailures = 0;

        for (;;) {
            if (signal.aborted) throw cancelledError('uploading');
            markStarted();

            const body = createReadStream(join(input.dir, name));

            try {
                await input.client.send(
                    new PutObjectCommand({
                        Bucket: input.bucket,
                        Key: objectKey(input.prefix, name),
                        Body: body,
                        ContentLength: size,
                        ContentType: contentTypeFor(name),
                    }),
                    { abortSignal: signal },
                );
                stall.onSuccess();
                break;
            } catch (error) {
                // Own cancel, or a sibling file already failed: stop without retrying.
                if (signal.aborted) throw cancelledError('uploading');

                if (classifyUploadError(error, signal) === 'network') {
                    const delay = stall.onNetworkFailure(networkFailures++);

                    if (delay === null) {
                        input.logger.warn(
                            `Upload of ${name} stopped: the network stall budget is used up.`,
                            {
                                error,
                            },
                        );
                        throw uploadInterruptedError();
                    }

                    input.logger.warn(`Upload of ${name} hit a network error; waiting to retry.`, {
                        attempt: networkFailures,
                        delayMs: delay,
                        error,
                    });
                    await input.sleep(delay, signal);
                } else {
                    const delay = UPLOAD_RETRY_DELAYS_MS[otherFailures++];

                    if (delay === undefined) throw error;

                    input.logger.warn(`Upload of ${name} failed; retrying.`, {
                        attempt: otherFailures,
                        delayMs: delay,
                        error,
                    });
                    await input.sleep(delay, signal);
                }
            } finally {
                body.destroy();
            }
        }

        done++;
        input.onProgress(progressFromUploaded(done, input.totalCount));
    }

    async function guarded(name: string): Promise<void> {
        try {
            await putOne(name);
        } catch (error) {
            first ??= { error };
            internal.abort();
            throw error;
        }
    }

    try {
        await runPool(others, UPLOAD_CONCURRENCY, guarded);

        if (input.signal.aborted) throw cancelledError('uploading');

        if (hasPlaylist) await guarded(PLAYLIST_FILE);
    } catch (thrown) {
        const error = (first as { error: unknown } | null)?.error ?? thrown;

        if (input.signal.aborted) throw cancelledError('uploading');
        if (error instanceof PipelineError) throw error;
        input.logger.error('Upload failed.', { error });
        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message: 'Uploading to R2 failed. Check the R2 settings and your connection.',
            cause: error,
        });
    }
}

export async function uploadDirectory(input: UploadInput): Promise<UploadResult> {
    const names = listUploadFiles(await readdir(input.dir));

    if (!names.includes(PLAYLIST_FILE)) {
        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message: 'The playlist file is missing, so nothing can be uploaded.',
        });
    }

    const sizes = new Map<string, number>();

    for (const name of names) sizes.set(name, (await stat(join(input.dir, name))).size);

    await uploadFiles({
        ...input,
        files: names,
        sizes,
        totalCount: names.length,
        initialDone: 0,
    });

    input.onPlaylistUploaded();

    return { files: names };
}
