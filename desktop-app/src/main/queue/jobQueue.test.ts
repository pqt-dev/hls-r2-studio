import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../shared/types';
import { PipelineError } from '../pipeline/errors';
import { CONFIG, createHarness, failedError, flush, PAYLOAD } from './testHarness';

afterEach(() => {
    vi.useRealTimers();
});

const GB = 1024 ** 3;

describe('addFiles', () => {
    it('validates extension (case-insensitive), existence, type, size and path', async () => {
        const h = createHarness({
            auth: { status: 'signed_out' },
            files: {
                '/v/a.MP4': 10,
                '/v/b.mkv': 20,
                '/v/c.txt': 5,
                '/v/empty.mp4': 0,
                '/v/dir.mp4': -1,
            },
        });

        const result = await h.queue.addFiles([
            '/v/a.MP4',
            '/v/b.mkv',
            '/v/c.txt',
            '/v/missing.mp4',
            '/v/empty.mp4',
            '/v/dir.mp4',
            'relative/x.mp4',
        ]);

        expect(result.added).toBe(2);
        expect(result.rejected.map((r) => r.name)).toEqual([
            'c.txt',
            'missing.mp4',
            'empty.mp4',
            'dir.mp4',
            'x.mp4',
        ]);
        expect(h.store.get().jobs.map((j) => [j.sourcePath, j.sizeBytes])).toEqual([
            ['/v/a.MP4', 10],
            ['/v/b.mkv', 20],
        ]);
        // Reasons never contain the full path.
        expect(JSON.stringify(result.rejected)).not.toContain('/v/');
    });

    it('dedupes against jobs that are not in a final state, and within the batch', async () => {
        const h = createHarness({ auth: { status: 'signed_out' }, files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4', '/v/a.mp4']);
        expect(h.store.get().jobs).toHaveLength(1);

        const again = await h.queue.addFiles(['/v/a.mp4']);
        expect(again).toMatchObject({ added: 0, rejected: [{ reason: 'Already in the queue.' }] });

        // Once the job is final it can be added again.
        await h.queue.cancel('job-1');
        expect((await h.queue.addFiles(['/v/a.mp4'])).added).toBe(1);
    });

    it('orders a batch smallest-file-first and keeps batches FIFO', async () => {
        const h = createHarness({
            auth: { status: 'signed_out' },
            files: { '/v/big.mp4': 300, '/v/small.mp4': 10, '/v/mid.mp4': 100, '/v/tiny.mp4': 1 },
        });

        await h.queue.addFiles(['/v/big.mp4', '/v/small.mp4', '/v/mid.mp4']);
        await h.queue.addFiles(['/v/tiny.mp4']);

        expect(h.store.get().jobs.map((j) => j.sourcePath)).toEqual([
            '/v/small.mp4',
            '/v/mid.mp4',
            '/v/big.mp4',
            '/v/tiny.mp4',
        ]);

        h.setAuth({ status: 'signed_in', r2Configured: true });
        expect(h.runs.map((r) => r.opts.job.sourcePath)).toEqual(['/v/small.mp4']);
        h.runs[0]?.resolve();
        await flush();
        expect(h.runs.map((r) => r.opts.job.sourcePath)).toEqual(['/v/small.mp4', '/v/mid.mp4']);
    });
});

describe('scheduling', () => {
    it('respects maxConcurrent (1 and 2)', async () => {
        for (const max of [1, 2]) {
            const h = createHarness({
                maxConcurrent: max,
                files: { '/v/a.mp4': 1, '/v/b.mp4': 2, '/v/c.mp4': 3 },
            });

            await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4', '/v/c.mp4']);
            expect(h.runs).toHaveLength(max);
            expect(h.queue.hasActiveJobs()).toBe(true);

            h.runs[0]?.resolve();
            await flush();
            expect(h.runs).toHaveLength(max + 1);
        }
    });

    it('starts nothing while signed out; waiting jobs explain why', async () => {
        const h = createHarness({ auth: { status: 'signed_out' }, files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
        expect(h.queue.list()[0]).toMatchObject({
            state: 'waiting',
            waitingReason: 'Sign in to start processing.',
        });
        expect(h.queue.summary().blockedReason).toBe('Sign in to start processing.');

        h.setAuth({ status: 'signed_in', r2Configured: true });
        expect(h.runs).toHaveLength(1);
        expect(h.queue.list()[0]?.waitingReason).toBeNull();
    });

    it('holds jobs while the config is missing, offline, or ffmpeg is unavailable', async () => {
        const h = createHarness({ config: null, files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
        expect(h.queue.list()[0]?.waitingReason).toBe(
            'R2 storage is not configured on the site yet.',
        );

        h.state.config = CONFIG;
        h.state.block = 'ffmpeg is not available.';
        h.queue.kick();
        expect(h.runs).toHaveLength(0);
        expect(h.queue.list()[0]?.waitingReason).toBe('ffmpeg is not available.');

        h.state.block = null;
        h.state.auth = { status: 'offline' };
        h.queue.kick();
        expect(h.runs).toHaveLength(0);
        expect(h.queue.list()[0]?.waitingReason).toContain('Cannot reach the site');

        h.setAuth({ status: 'signed_in', r2Configured: true });
        expect(h.runs).toHaveLength(1);
    });

    it('explains when a job waits for a free slot', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1, '/v/b.mp4': 2 } });
        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4']);

        expect(h.queue.list().map((j) => j.waitingReason)).toEqual([
            null,
            'Waiting for other jobs to finish.',
        ]);
    });

    it('passes a snapshot of the config, a per-job signal and a fresh public id to the pipeline', async () => {
        const h = createHarness({ files: { '/v/My Video.mp4': 1 } });
        await h.queue.addFiles(['/v/My Video.mp4']);

        const run = h.runs[0];
        expect(run?.opts.config).toBe(CONFIG);
        expect(run?.opts.job).toMatchObject({
            id: 'job-1',
            sourcePath: '/v/My Video.mp4',
            filename: 'My Video.mp4',
            publicId: 'pub000000001',
        });
        expect(run?.opts.hooks.signal.aborted).toBe(false);
    });
});

describe('hooks and persistence', () => {
    it('maps stage, progress and prefix hooks to state', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        const hooks = h.runs[0]?.opts.hooks;

        expect(h.job('job-1').state).toBe('transcoding');
        hooks?.onPrefix?.('2026/01/01/a-pub000000001/');
        hooks?.onStage('uploading');
        hooks?.onProgress(61);

        expect(h.job('job-1')).toMatchObject({
            state: 'uploading',
            prefix: '2026/01/01/a-pub000000001/',
        });
        expect(h.queue.list()[0]).toMatchObject({
            state: 'uploading',
            stageKey: 'job.state.uploading',
            progress: 61,
            canCancel: true,
            canRetry: false,
        });
    });

    it('persists state transitions but never progress ticks', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        const hooks = h.runs[0]?.opts.hooks;
        const before = h.updateSpy.mock.calls.length;

        for (let i = 1; i <= 50; i++) hooks?.onProgress(i);
        expect(h.updateSpy.mock.calls.length).toBe(before);

        hooks?.onStage('thumbnail');
        expect(h.updateSpy.mock.calls.length).toBe(before + 1);
    });

    it('never lets progress go backwards', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        const hooks = h.runs[0]?.opts.hooks;

        hooks?.onProgress(40);
        hooks?.onProgress(30);

        expect(h.queue.list()[0]?.progress).toBe(40);
    });
});

describe('event throttling', () => {
    it('emits at most 4 progress events per second per job, stage changes immediately', async () => {
        vi.useFakeTimers();
        const h = createHarness({
            files: { '/v/a.mp4': 1 },
            now: () => new Date(Date.now()),
        });
        await h.queue.addFiles(['/v/a.mp4']);
        const hooks = h.runs[0]?.opts.hooks;
        h.snapshots.length = 0;

        // 40 ticks over one second (every 25 ms).
        for (let i = 1; i <= 40; i++) {
            hooks?.onProgress(i);
            await vi.advanceTimersByTimeAsync(25);
        }
        expect(h.snapshots.length).toBeLessThanOrEqual(4);
        expect(h.snapshots.length).toBeGreaterThanOrEqual(3);
        // The trailing emit carries the latest value.
        await vi.advanceTimersByTimeAsync(300);
        expect(h.snapshots.at(-1)?.[0]?.progress).toBe(40);

        const count = h.snapshots.length;
        hooks?.onStage('storyboard');
        expect(h.snapshots.length).toBe(count + 1);
        expect(h.snapshots.at(-1)?.[0]?.state).toBe('storyboard');
    });

    it('emits queue summaries only when they change', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        const summaries: unknown[] = [];
        h.queue.subscribeSummary((s) => summaries.push(s));
        await h.queue.addFiles(['/v/a.mp4']);
        const count = summaries.length;

        h.runs[0]?.opts.hooks.onProgress(10);
        h.runs[0]?.opts.hooks.onStage('thumbnail');
        expect(summaries.length).toBe(count);
        expect(summaries.at(-1)).toMatchObject({ running: 1, waiting: 0, total: 1 });
    });
});

describe('pipeline results', () => {
    async function started(extra: Parameters<typeof createHarness>[0] = {}) {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, ...extra });
        await h.queue.addFiles(['/v/a.mp4']);

        return h;
    }

    it('done: stores the registered video and clears the payload', async () => {
        const h = await started();
        h.runs[0]?.resolve();
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'done',
            publicId: 'pub000000001',
            registered: {
                public_id: 'pub000000001',
                embed_url: 'https://site.example.com/embed/pub000000001',
            },
            errorMessage: null,
        });
        expect(h.job('job-1').finishedAt).not.toBeNull();
        expect(h.queue.list()[0]).toMatchObject({
            progress: 100,
            embedUrl: 'https://site.example.com/embed/pub000000001',
            canRemove: true,
            canCancel: false,
        });
        expect(h.queue.hasActiveJobs()).toBe(false);
    });

    it('failed: stores message, detail (redacted tail) and prefix', async () => {
        const h = await started();
        const error = new PipelineError({
            kind: 'failed',
            step: 'transcoding',
            message: 'ffmpeg failed',
            exitCode: 69,
            stderrTail: ['Authorization: Bearer abc.def', 'normal line'],
            prefix: '2026/01/01/a-pub000000001/',
        });
        h.runs[0]?.reject(error);
        await flush();

        const job = h.job('job-1');
        expect(job).toMatchObject({
            state: 'failed',
            errorMessage: 'ffmpeg failed',
            prefix: '2026/01/01/a-pub000000001/',
        });
        expect(job.errorDetail).toEqual({
            step: 'transcoding',
            exitCode: 69,
            stderrTail: ['Authorization: [REDACTED]', 'normal line'],
        });
        expect(h.queue.list()[0]).toMatchObject({ canRetry: true, canRemove: true });
    });

    it('cancelled: marks the job cancelled', async () => {
        const h = await started();
        h.runs[0]?.cancelOnAbort('uploading');
        await h.queue.cancel('job-1');
        await flush();

        expect(h.job('job-1')).toMatchObject({ state: 'cancelled' });
        expect(h.job('job-1').errorDetail?.step).toBe('uploading');
    });

    it('register_failed keeps the payload and prefix and exposes retryRegister', async () => {
        const h = await started();
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'Could not reach the site.',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'register_failed',
            registerPayload: PAYLOAD,
            prefix: PAYLOAD.disk_prefix,
        });
        expect(h.queue.list()[0]).toMatchObject({
            canRetryRegister: true,
            canRetry: false,
            canRemove: false,
            canCancel: true,
        });
        expect(h.deleted).toHaveLength(0);
    });

    it('needs_sign_in keeps the payload', async () => {
        const h = await started();
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'needs_sign_in',
                step: 'registering',
                message: 'Session expired.',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(h.job('job-1')).toMatchObject({ state: 'needs_sign_in', registerPayload: PAYLOAD });
    });

    it('an unexpected (non-pipeline) error becomes a generic failure without leaking details', async () => {
        const h = await started();
        h.runs[0]?.reject(new Error('secret internal detail /home/x'));
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'failed',
            errorMessage: 'An unexpected error occurred.',
        });
    });

    it('starts the next job after a failure', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1, '/v/b.mp4': 2 } });
        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4']);
        h.runs[0]?.reject(failedError('transcoding'));
        await flush();

        expect(h.runs).toHaveLength(2);
        expect(h.job('job-2').state).toBe('transcoding');
    });

    it('applies the history cap when a job finishes', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        const old: JobRecord[] = Array.from({ length: 200 }, (_, i) => ({
            id: `old-${i}`,
            sourcePath: `/v/old${i}.mp4`,
            sizeBytes: 1,
            state: 'done',
            publicId: null,
            prefix: null,
            errorMessage: null,
            errorDetail: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            registered: null,
        }));
        h.store.update((d) => {
            d.jobs.unshift(...old);
        });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.resolve();
        await flush();

        const jobs = h.store.get().jobs;
        expect(jobs.filter((j) => j.state === 'done')).toHaveLength(200);
        expect(jobs.some((j) => j.id === 'old-0')).toBe(false);
        expect(jobs.some((j) => j.id === 'job-1')).toBe(true);
    });
});

describe('cancel', () => {
    it('cancels a waiting job without touching the pipeline', async () => {
        const h = createHarness({ auth: { status: 'signed_out' }, files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);

        expect(await h.queue.cancel('job-1')).toEqual({ ok: true });
        expect(h.job('job-1').state).toBe('cancelled');
        expect(h.runs).toHaveLength(0);
    });

    it.each(['transcoding', 'thumbnail', 'storyboard', 'uploading', 'registering'] as const)(
        'aborts the signal when cancelled during %s',
        async (stage) => {
            const h = createHarness({ files: { '/v/a.mp4': 1 } });
            await h.queue.addFiles(['/v/a.mp4']);
            const run = h.runs[0];
            run?.cancelOnAbort(stage);
            run?.opts.hooks.onStage(stage);

            await h.queue.cancel('job-1');
            expect(run?.opts.hooks.signal.aborted).toBe(true);
            expect(h.queue.list()[0]?.canCancel).toBe(false);

            await flush();
            expect(h.job('job-1').state).toBe('cancelled');
        },
    );

    it('abandoning a register_failed job does not delete R2 files', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'x',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(await h.queue.cancel('job-1')).toEqual({ ok: true });
        expect(h.job('job-1')).toMatchObject({ state: 'cancelled', registerPayload: null });
        expect(h.deleted).toHaveLength(0);
    });

    it('rejects cancel for finished jobs and unknown ids', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.resolve();
        await flush();

        expect((await h.queue.cancel('job-1')).ok).toBe(false);
        expect((await h.queue.cancel('nope')).ok).toBe(false);
    });
});

describe('retry', () => {
    async function failedAt(step: Parameters<typeof failedError>[0], prefix: string | null) {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.opts.hooks.onStage('uploading');
        h.runs[0]?.reject(
            new PipelineError({ kind: 'failed', step, message: 'x', prefix: prefix ?? undefined }),
        );
        await flush();

        return h;
    }

    it('re-runs with a NEW public id and deletes the old R2 prefix after a partial upload', async () => {
        const prefix = '2026/01/01/a-pub000000001/';
        const h = await failedAt('uploading', prefix);

        expect(await h.queue.retry('job-1')).toEqual({ ok: true });

        expect(h.deleted).toEqual([{ bucket: 'bucket', prefix }]);
        expect(h.removed).toEqual([join('/tmp/hls', 'pub000000001')]);
        expect(h.runs).toHaveLength(2);
        expect(h.runs[1]?.opts.job.publicId).toBe('pub000000002');
        expect(h.job('job-1')).toMatchObject({
            state: 'transcoding',
            publicId: 'pub000000002',
            errorMessage: null,
            errorDetail: null,
            prefix: null,
        });
    });

    it('does not touch R2 when nothing was uploaded', async () => {
        const h = await failedAt('transcoding', null);
        await h.queue.retry('job-1');

        expect(h.deleted).toHaveLength(0);
    });

    it('does not delete files when the failure happened while registering', async () => {
        const h = await failedAt('registering', '2026/01/01/a-pub000000001/');
        await h.queue.retry('job-1');

        expect(h.deleted).toHaveLength(0);
    });

    it('still retries when no config is available for the cleanup', async () => {
        const h = await failedAt('uploading', '2026/01/01/a-pub000000001/');
        h.state.config = null;

        expect(await h.queue.retry('job-1')).toEqual({ ok: true });
        expect(h.deleted).toHaveLength(0);
        expect(h.job('job-1').state).toBe('waiting');
    });

    it('works for cancelled and interrupted jobs, and rejects other states', async () => {
        const h = createHarness({
            files: { '/v/a.mp4': 1, '/v/b.mp4': 2 },
            auth: { status: 'signed_out' },
        });
        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4']);
        await h.queue.cancel('job-1');
        h.store.update((d) => {
            const job = d.jobs.find((j) => j.id === 'job-2');
            if (job) job.state = 'interrupted';
        });

        expect((await h.queue.retry('job-1')).ok).toBe(true);
        expect((await h.queue.retry('job-2')).ok).toBe(true);
        expect((await h.queue.retry('job-1')).ok).toBe(false); // now waiting
        expect((await h.queue.retry('nope')).ok).toBe(false);
    });

    it('a double click cannot start two runs', async () => {
        const h = await failedAt('uploading', '2026/01/01/a-pub000000001/');
        const [a, b] = await Promise.all([h.queue.retry('job-1'), h.queue.retry('job-1')]);

        expect([a.ok, b.ok].sort()).toEqual([false, true]);
        expect(h.runs).toHaveLength(2);
    });
});

describe('retryRegister', () => {
    async function registerFailed(kind: 'register_failed' | 'needs_sign_in' = 'register_failed') {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind,
                step: 'registering',
                message: 'x',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        return h;
    }

    it('calls the pipeline retryRegister with the stored payload (no re-upload) and finishes', async () => {
        const h = await registerFailed();

        expect(await h.queue.retryRegister('job-1')).toEqual({ ok: true });
        expect(h.runs).toHaveLength(1);
        expect(h.registerRuns[0]?.opts.payload).toEqual(PAYLOAD);
        expect(h.job('job-1').state).toBe('registering');

        h.registerRuns[0]?.resolve();
        await flush();

        expect(h.job('job-1')).toMatchObject({ state: 'done', registerPayload: null });
        expect(h.job('job-1').registered?.public_id).toBe(PAYLOAD.public_id);
    });

    it('returns to register_failed when the retry fails the same way', async () => {
        const h = await registerFailed();
        await h.queue.retryRegister('job-1');
        h.registerRuns[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'still down',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'register_failed',
            errorMessage: 'still down',
        });
    });

    it('a definitive rejection fails the job and removes the useless R2 files', async () => {
        const h = await registerFailed();
        await h.queue.retryRegister('job-1');
        h.registerRuns[0]?.reject(
            new PipelineError({
                kind: 'failed',
                step: 'registering',
                message: 'rejected',
                prefix: PAYLOAD.disk_prefix,
                definitive: true,
            }),
        );
        await flush();

        expect(h.job('job-1').state).toBe('failed');
        expect(h.deleted).toEqual([{ bucket: 'bucket', prefix: PAYLOAD.disk_prefix }]);
    });

    it('a failure that is not definitive (no known server code) keeps the R2 files', async () => {
        const h = await registerFailed();
        await h.queue.retryRegister('job-1');
        h.registerRuns[0]?.reject(
            new PipelineError({
                kind: 'failed',
                step: 'registering',
                message: 'invalid stored data',
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(h.job('job-1').state).toBe('failed');
        expect(h.deleted).toEqual([]);
    });

    it('cancelling a register retry only stops the attempt', async () => {
        const h = await registerFailed();
        await h.queue.retryRegister('job-1');
        await h.queue.cancel('job-1');
        expect(h.registerRuns[0]?.opts.hooks.signal.aborted).toBe(true);
        h.registerRuns[0]?.reject(
            new PipelineError({ kind: 'cancelled', step: 'registering', message: 'c' }),
        );
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'register_failed',
            registerPayload: PAYLOAD,
        });
        expect(h.deleted).toHaveLength(0);
    });

    it('requires being signed in and an eligible job', async () => {
        const h = await registerFailed('needs_sign_in');
        h.state.auth = { status: 'signed_out' };

        expect((await h.queue.retryRegister('job-1')).ok).toBe(false);
        expect((await h.queue.retryRegister('nope')).ok).toBe(false);
        expect(h.registerRuns).toHaveLength(0);
    });
});

describe('auto resume after sign-in', () => {
    it('retry-registers every needs_sign_in job and resumes waiting jobs', async () => {
        const h = createHarness({
            files: { '/v/a.mp4': 1, '/v/b.mp4': 2 },
            auth: { status: 'signed_in', r2Configured: true },
        });
        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'needs_sign_in',
                step: 'registering',
                message: 'expired',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        // Session lost; a new file is added but cannot start.
        h.setAuth({ status: 'signed_out' });
        await h.queue.addFiles(['/v/b.mp4']);
        expect(h.runs).toHaveLength(1);
        expect(h.registerRuns).toHaveLength(0);

        h.setAuth({ status: 'signed_in', r2Configured: true });
        await flush();

        expect(h.registerRuns).toHaveLength(1);
        expect(h.runs).toHaveLength(2);
        expect(h.job('job-1').state).toBe('registering');
        expect(h.job('job-2').state).toBe('transcoding');
    });
});

describe('recovery', () => {
    it('turns running jobs into interrupted and removes their temp dirs', async () => {
        const h = createHarness({ auth: { status: 'signed_out' } });
        const base = (
            id: string,
            state: JobRecord['state'],
            publicId: string | null,
        ): JobRecord => ({
            id,
            sourcePath: `/v/${id}.mp4`,
            sizeBytes: 1,
            state,
            publicId,
            prefix: publicId === null ? null : `2026/01/01/x-${publicId}/`,
            errorMessage: null,
            errorDetail: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            registered: null,
            registerPayload: state === 'register_failed' ? PAYLOAD : null,
        });
        h.store.update((d) => {
            d.jobs.push(
                base('t', 'transcoding', 'aaaaaaaaaaaa'),
                base('u', 'uploading', 'bbbbbbbbbbbb'),
                base('r', 'registering', 'cccccccccccc'),
                base('evil', 'thumbnail', '../../etc'),
                base('w', 'waiting', null),
                base('rf', 'register_failed', 'dddddddddddd'),
                base('d', 'done', 'eeeeeeeeeeee'),
            );
        });

        await h.queue.recover();

        expect(h.states()).toEqual([
            't:interrupted',
            'u:interrupted',
            'r:interrupted',
            'evil:interrupted',
            'w:waiting',
            'rf:register_failed',
            'd:done',
        ]);
        expect(h.removed.sort()).toEqual([
            join('/tmp/hls', 'aaaaaaaaaaaa'),
            join('/tmp/hls', 'bbbbbbbbbbbb'),
            join('/tmp/hls', 'cccccccccccc'),
        ]);
        expect(h.job('u')).toMatchObject({
            errorMessage: expect.stringContaining('closed while this job was running'),
            errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
        });
        expect(h.job('rf').registerPayload).toEqual(PAYLOAD);
        expect(h.queue.list().find((j) => j.id === 'u')).toMatchObject({ canRetry: true });
    });
});

describe('remove and clearFinished', () => {
    it('removes only final jobs', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1, '/v/b.mp4': 2, '/v/c.mp4': 3 } });
        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4', '/v/c.mp4']);
        h.runs[0]?.resolve();
        await flush();

        expect(h.queue.remove('job-2').ok).toBe(false); // running
        expect(h.queue.remove('job-3').ok).toBe(false); // waiting
        expect(h.queue.remove('job-1').ok).toBe(true);
        expect(h.states()).toEqual(['job-2:transcoding', 'job-3:waiting']);
    });

    it('clearFinished drops done/failed/cancelled/interrupted but keeps active and attention jobs', async () => {
        const h = createHarness({ auth: { status: 'signed_out' } });
        const make = (id: string, state: JobRecord['state']): JobRecord => ({
            id,
            sourcePath: `/v/${id}.mp4`,
            sizeBytes: 1,
            state,
            publicId: null,
            prefix: null,
            errorMessage: null,
            errorDetail: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            registered: null,
        });
        h.store.update((d) => {
            d.jobs.push(
                make('1', 'done'),
                make('2', 'failed'),
                make('3', 'cancelled'),
                make('4', 'interrupted'),
                make('5', 'waiting'),
                make('6', 'register_failed'),
                make('7', 'needs_sign_in'),
            );
        });

        h.queue.clearFinished();

        expect(h.states()).toEqual(['5:waiting', '6:register_failed', '7:needs_sign_in']);
    });
});

describe('shutdown', () => {
    it('aborts all running jobs, waits for their cleanup and starts nothing new', async () => {
        const h = createHarness({
            maxConcurrent: 2,
            files: { '/v/a.mp4': 1, '/v/b.mp4': 2, '/v/c.mp4': 3 },
        });
        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4', '/v/c.mp4']);
        h.runs.forEach((run) => run.cancelOnAbort());

        await h.queue.shutdown();
        await flush();

        expect(h.runs.every((run) => run.opts.hooks.signal.aborted)).toBe(true);
        expect(h.runs).toHaveLength(2);
        expect(h.job('job-1').state).toBe('cancelled');
        expect(h.job('job-3').state).toBe('waiting');
        expect(h.queue.hasActiveJobs()).toBe(false);
    });

    it('gives up waiting after the timeout', async () => {
        vi.useFakeTimers();
        const h = createHarness({ files: { '/v/a.mp4': 1 }, now: () => new Date(Date.now()) });
        await h.queue.addFiles(['/v/a.mp4']);

        const done = h.queue.shutdown();
        await vi.advanceTimersByTimeAsync(250);
        await done;

        expect(h.runs[0]?.opts.hooks.signal.aborted).toBe(true);
    });
});

describe('big files', () => {
    it('records the size reported by stat', async () => {
        const h = createHarness({
            auth: { status: 'signed_out' },
            files: { '/v/big.mp4': 5 * GB },
        });
        await h.queue.addFiles(['/v/big.mp4']);
        expect(h.queue.list()[0]?.sizeBytes).toBe(5 * GB);
    });
});

const SITE_A = 'https://a.example.com';
const SITE_B = 'https://b.example.com';

function signedIn(siteUrl: string) {
    return { status: 'signed_in', r2Configured: true, siteUrl } as const;
}

describe('gate requires a session and a config', () => {
    it('does not start while signed_in but the token is missing', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, hasSession: () => false });

        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
        expect(h.queue.summary().blockedReason).toBe('Sign in to start processing.');
    });

    it('does not start while signed_in but the config is empty', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, config: null });

        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
    });

    it('does not start while signed out even if a config is still present', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, auth: { status: 'signed_out' } });

        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
    });
});

describe('jobs are bound to the site they were uploaded for', () => {
    async function needsSignInOnA() {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, auth: signedIn(SITE_A) });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'needs_sign_in',
                step: 'registering',
                message: 'expired',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        return h;
    }

    it('records the site origin when the job starts', async () => {
        const h = await needsSignInOnA();

        expect(h.job('job-1').siteOrigin).toBe(SITE_A);
    });

    it('does not auto-register against another site and explains why', async () => {
        const h = await needsSignInOnA();

        h.setAuth({ status: 'signed_out', siteUrl: SITE_B });
        h.setAuth(signedIn(SITE_B));
        await flush();

        expect(h.registerRuns).toHaveLength(0);
        expect(h.job('job-1')).toMatchObject({
            state: 'needs_sign_in',
            errorMessage:
                'This video was uploaded for a.example.com; sign in to that site to finish it.',
        });
        expect(h.deleted).toEqual([]);
    });

    it('refuses a manual register retry against another site', async () => {
        const h = await needsSignInOnA();

        h.setAuth(signedIn(SITE_B));

        expect(await h.queue.retryRegister('job-1')).toEqual({
            ok: false,
            error: 'This video was uploaded for a.example.com; sign in to that site to finish it.',
        });
        expect(h.registerRuns).toHaveLength(0);
        expect(h.job('job-1').state).toBe('needs_sign_in');
    });

    it('resumes automatically once signed in to the original site again', async () => {
        const h = await needsSignInOnA();

        h.setAuth(signedIn(SITE_B));
        h.setAuth(signedIn(SITE_A));
        await flush();

        expect(h.registerRuns).toHaveLength(1);
    });

    it('never deletes R2 files with the config of another site (retry of a failed job)', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, auth: signedIn(SITE_A) });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.opts.hooks.onStage('uploading');
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'failed',
                step: 'uploading',
                message: 'x',
                prefix: '2026/01/01/a-pub000000001/',
            }),
        );
        await flush();
        h.setAuth(signedIn(SITE_B));

        expect(await h.queue.retry('job-1')).toEqual({ ok: true });
        expect(h.deleted).toEqual([]);
        expect(h.job('job-1').siteOrigin).toBe(SITE_B);
    });

    it('tolerates old records without a site origin', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 }, auth: signedIn(SITE_A) });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'x',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();
        h.store.update((d) => {
            const job = d.jobs[0];

            if (job) delete job.siteOrigin;
        });

        expect(await h.queue.retryRegister('job-1')).toEqual({ ok: true });
    });

    it('a job can still be cancelled while it belongs to another site (nothing is deleted)', async () => {
        const h = await needsSignInOnA();

        h.setAuth(signedIn(SITE_B));

        expect(await h.queue.cancel('job-1')).toEqual({ ok: true });
        expect(h.job('job-1').state).toBe('cancelled');
        expect(h.deleted).toEqual([]);
    });
});

describe('crash window around registering', () => {
    it('flushes the store before the first register request (pipeline hook)', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        const flushSpy = vi.spyOn(h.store, 'flush');

        await h.queue.addFiles(['/v/a.mp4']);
        await h.runs[0]?.opts.hooks.onBeforeRegister?.();

        expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('flushes the store before the register-only retry too', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });
        const flushSpy = vi.spyOn(h.store, 'flush');

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'x',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();
        await h.queue.retryRegister('job-1');
        await h.registerRuns[0]?.opts.hooks.onBeforeRegister?.();

        expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('Retry of an interrupted job never deletes its old prefix and keeps a note in the log', async () => {
        const h = createHarness({ files: { '/v/a.mp4': 1 } });

        // Record left by a previous run of the app: it died while "uploading".
        h.store.update((d) => {
            d.jobs.push({
                id: 'job-1',
                sourcePath: '/v/a.mp4',
                sizeBytes: 1,
                state: 'interrupted',
                publicId: 'pub000000001',
                prefix: '2026/01/01/a-pub000000001/',
                errorMessage: 'interrupted',
                errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                startedAt: null,
                finishedAt: null,
                registered: null,
            });
        });

        expect(await h.queue.retry('job-1')).toEqual({ ok: true });

        expect(h.deleted).toEqual([]);
        expect(h.logger.entries.some((e) => /may be orphaned/.test(e.message))).toBe(true);
    });
});
