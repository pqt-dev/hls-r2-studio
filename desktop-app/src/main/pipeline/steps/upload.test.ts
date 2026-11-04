import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineError } from '../errors';
import { FakeS3, NOOP_LOGGER, makeTempDir, type FakeS3Options } from '../testing/fakes';
import {
    NETWORK_STALL_BUDGET_MS,
    NETWORK_WAIT_NOTIFY_INTERVAL_MS,
    uploadDirectory,
    type NetworkWaitInfo,
} from './upload';

const PREFIX = '2026/03/05/clip-ab12cd34ef56/';
const START = 1_700_000_000_000;

let dir: string;

beforeEach(async () => {
    dir = await makeTempDir('upload-step');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function writeFiles(segments: number): Promise<void> {
    await mkdir(dir, { recursive: true });

    for (let i = 0; i < segments; i++) {
        await writeFile(join(dir, `segment_${String(i).padStart(3, '0')}.ts`), Buffer.alloc(10));
    }

    await writeFile(join(dir, 'playlist.m3u8'), '#EXTM3U\n');
}

function netError(code = 'ECONNRESET'): Error {
    return Object.assign(new Error(code), { code });
}

function httpError(status: number, name = 'AccessDenied'): Error {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

interface Rig {
    clock: { now: number };
    sleeps: number[];
    waits: NetworkWaitInfo[];
    restored: number[];
    progress: number[];
    s3: FakeS3;
    controller: AbortController;
    run: () => Promise<unknown>;
}

/** Fake clock that only moves when a (fake) sleep happens, so budgets are deterministic. */
function rig(
    s3Options: (clock: { now: number }) => FakeS3Options,
    over: {
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
        stallBudgetMs?: number;
        throwingHooks?: boolean;
    } = {},
): Rig {
    const clock = { now: START };
    const sleeps: number[] = [];
    const waits: NetworkWaitInfo[] = [];
    const restored: number[] = [];
    const progress: number[] = [];
    const s3 = new FakeS3(s3Options(clock));
    const controller = new AbortController();

    return {
        clock,
        sleeps,
        waits,
        restored,
        progress,
        s3,
        controller,
        run: () =>
            uploadDirectory({
                client: s3.asClient(),
                bucket: 'b',
                prefix: PREFIX,
                dir,
                signal: controller.signal,
                sleep:
                    over.sleep ??
                    (async (ms) => {
                        sleeps.push(ms);
                        clock.now += ms;
                    }),
                logger: NOOP_LOGGER,
                onProgress: (f) => progress.push(f),
                onUploadStarted: () => undefined,
                onPlaylistUploaded: () => undefined,
                onNetworkWait: (info) => {
                    waits.push(info);
                    if (over.throwingHooks) throw new Error('hook failed');
                },
                onNetworkRestored: () => {
                    restored.push(clock.now);
                    if (over.throwingHooks) throw new Error('hook failed');
                },
                now: () => clock.now,
                jitter: () => 0,
                stallBudgetMs: over.stallBudgetMs,
            }),
    };
}

async function failureOf(promise: Promise<unknown>): Promise<PipelineError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);

        return error as PipelineError;
    }

    throw new Error('Expected the upload to fail.');
}

describe('uploadDirectory: network waits', () => {
    it('keeps retrying a network failure with 2, 5, 10, 20, 30, 60, 60 s delays and then succeeds', async () => {
        await writeFiles(0);

        const r = rig(() => ({
            failPut: (_key, attempt) => (attempt <= 7 ? netError() : undefined),
        }));

        await r.run();

        expect(r.sleeps).toEqual([2000, 5000, 10000, 20000, 30000, 60000, 60000]);
        expect(r.s3.objects.has(`${PREFIX}playlist.m3u8`)).toBe(true);
        expect(r.s3.putKeys).toHaveLength(8);
        expect(r.restored).toHaveLength(1);
        expect(r.waits.length).toBeGreaterThan(0);
        expect(r.waits[0]).toEqual({
            since: START,
            attempt: 1,
            nextRetryInMs: 2000,
            budgetRemainingMs: NETWORK_STALL_BUDGET_MS,
        });
    });

    it('does not spend the 3 attempt budget on network failures', async () => {
        await writeFiles(1);

        const r = rig(() => ({
            failPut: (key, attempt) =>
                key.endsWith('.ts') && attempt <= 10 ? netError() : undefined,
        }));

        await r.run();

        expect(r.s3.putKeys.filter((k) => k.endsWith('.ts'))).toHaveLength(11);
    });

    it('throttles onNetworkWait and reports the restore once', async () => {
        await writeFiles(0);

        const r = rig(() => ({
            failPut: (_key, attempt) => (attempt <= 7 ? netError() : undefined),
        }));

        await r.run();

        // Waits start at t=0 and every later one must be at least the notify interval after.
        const sinceStart = r.waits.map((w) => w.budgetRemainingMs);

        expect(r.waits.length).toBeLessThan(7);

        for (let i = 1; i < sinceStart.length; i++) {
            const gap = (sinceStart[i - 1] ?? 0) - (sinceStart[i] ?? 0);

            expect(gap).toBeGreaterThanOrEqual(NETWORK_WAIT_NOTIFY_INTERVAL_MS);
        }
    });

    it('does not call onNetworkRestored when no wait happened', async () => {
        await writeFiles(2);

        const r = rig(() => ({}));

        await r.run();

        expect(r.waits).toEqual([]);
        expect(r.restored).toEqual([]);
        expect(r.progress.at(-1)).toBe(1);
    });

    it('survives throwing status hooks', async () => {
        await writeFiles(0);

        const r = rig(
            () => ({ failPut: (_key, attempt) => (attempt <= 1 ? netError() : undefined) }),
            { throwingHooks: true },
        );

        await r.run();

        expect(r.waits).toHaveLength(1);
        expect(r.restored).toHaveLength(1);
        expect(r.s3.objects.has(`${PREFIX}playlist.m3u8`)).toBe(true);
    });

    it('throws upload_interrupted when the whole stall budget is used up, using every wait', async () => {
        await writeFiles(0);

        const r = rig(() => ({ failPut: () => netError('ETIMEDOUT') }));
        const failure = await failureOf(r.run());

        expect(failure.kind).toBe('upload_interrupted');
        expect(failure.step).toBe('uploading');
        expect(failure.resumable).toBe(true);
        expect(failure.message).toBe(
            'Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.',
        );
        expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(NETWORK_STALL_BUDGET_MS);
        expect(r.restored).toEqual([]);
        // Nothing was ever uploaded, and the step never deletes anything.
        expect(r.s3.requests.every((q) => q.type === 'put')).toBe(true);
    });

    it('a success resets the stall budget', async () => {
        await writeFiles(1);

        const minutes = (n: number): number => START + n * 60_000;
        // The segment succeeds after 25 min of outage, the playlist after another 25 min: 50 min
        // in total, which only works when the success in between reset the budget.
        const r = rig((clock) => {
            let segmentUp = Number.POSITIVE_INFINITY;

            return {
                failPut: (key) => {
                    if (key.endsWith('.ts')) {
                        if (clock.now < minutes(25)) return netError();
                        segmentUp = Math.min(segmentUp, clock.now);

                        return undefined;
                    }

                    return clock.now < segmentUp + 25 * 60_000 ? netError() : undefined;
                },
            };
        });

        await r.run();

        expect(r.s3.objects.has(`${PREFIX}playlist.m3u8`)).toBe(true);
        expect(r.clock.now - START).toBeGreaterThan(NETWORK_STALL_BUDGET_MS);
        expect(r.restored).toHaveLength(2);
    });

    it('without a success in between the same 50 min outage is interrupted', async () => {
        await writeFiles(0);

        const r = rig((clock) => ({
            failPut: () => (clock.now < START + 50 * 60_000 ? netError() : undefined),
        }));

        expect((await failureOf(r.run())).kind).toBe('upload_interrupted');
    });

    it('shares one stall budget between the concurrent files', async () => {
        await writeFiles(0);

        const single = rig(() => ({ failPut: () => netError() }));

        await failureOf(single.run());

        const singleAttempts = single.s3.putKeys.length;

        await rm(dir, { recursive: true, force: true });
        await writeFiles(5);

        // Under the fake clock the 5 waits of a round run one after another (5x the time), so with
        // a shared budget the whole step makes about as many attempts as ONE file did alone.
        const many = rig(() => ({ failPut: () => netError() }));
        const failure = await failureOf(many.run());

        expect(failure.kind).toBe('upload_interrupted');
        expect(many.s3.putKeys.length).toBeLessThan(singleAttempts * 2);
        expect(new Set(many.waits.map((w) => w.since)).size).toBe(1);
    });

    it('stops the other waiting files as soon as one file is interrupted', async () => {
        await writeFiles(5);

        const r = rig(() => ({ failPut: () => netError() }));

        await failureOf(r.run());

        const settled = r.s3.putKeys.length;

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(r.s3.putKeys).toHaveLength(settled);
    });

    it('aborts a wait immediately when the job is cancelled', async () => {
        await writeFiles(0);

        let signalWaiting: () => void = () => undefined;
        const waiting = new Promise<void>((resolve) => {
            signalWaiting = resolve;
        });
        const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
            new Promise((resolve) => {
                signalWaiting();
                signal?.addEventListener('abort', () => resolve(), { once: true });
            });
        const r = rig(() => ({ failPut: () => netError() }), { sleep });
        const promise = r.run();

        await waiting;
        r.controller.abort();

        const failure = await failureOf(promise);

        expect(failure.kind).toBe('cancelled');
        expect(r.s3.putKeys).toHaveLength(1);
    });
});

describe('uploadDirectory: other errors keep the old policy', () => {
    it('HTTP 403 gets 3 attempts (1 s and 2 s waits) and then fails', async () => {
        await writeFiles(0);

        const r = rig(() => ({ failPut: () => httpError(403) }));
        const failure = await failureOf(r.run());

        expect(failure.kind).toBe('failed');
        expect(failure.message).toBe(
            'Uploading to R2 failed. Check the R2 settings and your connection.',
        );
        expect(r.sleeps).toEqual([1000, 2000]);
        expect(r.s3.putKeys).toHaveLength(3);
        expect(r.waits).toEqual([]);
    });

    it('a transient non-network failure is still retried', async () => {
        await writeFiles(0);

        const r = rig(() => ({
            failPut: (_key, attempt) => (attempt === 1 ? httpError(400, 'BadDigest') : undefined),
        }));

        await r.run();

        expect(r.sleeps).toEqual([1000]);
    });

    it('stays within the old budget even when the network flaps in between', async () => {
        await writeFiles(0);

        const kinds = [netError(), httpError(403), httpError(403), httpError(403)];
        const r = rig(() => ({ failPut: (_key, attempt) => kinds[attempt - 1] }));
        const failure = await failureOf(r.run());

        expect(failure.kind).toBe('failed');
        expect(r.sleeps).toEqual([2000, 1000, 2000]);
    });
});
