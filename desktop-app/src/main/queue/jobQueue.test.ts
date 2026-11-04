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

        expect((await h.queue.remove('job-2')).ok).toBe(false); // running
        expect((await h.queue.remove('job-3')).ok).toBe(false); // waiting
        expect((await h.queue.remove('job-1')).ok).toBe(true);
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

// ---- resumable uploads (B2) -----------------------------------------------------------------

const SITE = 'https://site.example.com';
const TMP = join('/tmp/hls', 'aaaaaaaaaaaa');
const SITE_AUTH = { status: 'signed_in', r2Configured: true, siteUrl: SITE } as const;

function pausedRecord(over: Partial<JobRecord> = {}): JobRecord {
    return {
        id: 'p1',
        sourcePath: '/v/p1.mp4',
        sizeBytes: 1,
        state: 'upload_interrupted',
        publicId: 'aaaaaaaaaaaa',
        prefix: PAYLOAD.disk_prefix,
        errorMessage: 'paused',
        errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        registered: null,
        registerPayload: PAYLOAD,
        tmpDir: TMP,
        siteOrigin: SITE,
        ...over,
    };
}

function pausedHarness(
    over: Partial<JobRecord> = {},
    opts: Parameters<typeof createHarness>[0] = {},
) {
    const h = createHarness({ auth: SITE_AUTH, ...opts });

    h.store.update((d) => {
        d.jobs.push(pausedRecord(over));
    });

    return h;
}

function interruptedError(): PipelineError {
    return new PipelineError({
        kind: 'upload_interrupted',
        step: 'uploading',
        message: 'Upload stopped: the network was unavailable for 30 minutes.',
        registerPayload: PAYLOAD,
        prefix: PAYLOAD.disk_prefix,
        tmpDir: TMP,
        resumable: true,
    });
}

describe('upload persistence and pause', () => {
    it('persists payload, tmpDir and prefix durably before the first upload', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });
        const flushSpy = vi.spyOn(h.store, 'flush');

        await h.queue.addFiles(['/v/a.mp4']);

        const publicId = h.job('job-1').publicId ?? '';
        const pending = h.runs[0]?.opts.hooks.onBeforeUpload?.({
            prefix: PAYLOAD.disk_prefix,
            publicId,
            tmpDir: join('/tmp/hls', publicId),
            registerPayload: PAYLOAD,
        });

        expect(h.job('job-1')).toMatchObject({
            prefix: PAYLOAD.disk_prefix,
            tmpDir: join('/tmp/hls', publicId),
            registerPayload: PAYLOAD,
        });

        await pending;

        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(h.job('job-1').registerStarted).toBeUndefined();
    });

    it('onBeforeRegister flushes and records that the site may have registered it', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });
        const flushSpy = vi.spyOn(h.store, 'flush');

        await h.queue.addFiles(['/v/a.mp4']);
        await h.runs[0]?.opts.hooks.onBeforeRegister?.();

        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(h.job('job-1').registerStarted).toBe(true);
    });

    it('maps upload_interrupted to a resumable state without deleting anything', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(interruptedError());
        await flush();

        expect(h.job('job-1')).toMatchObject({
            state: 'upload_interrupted',
            errorMessage: expect.stringContaining('network was unavailable'),
            errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
            registerPayload: PAYLOAD,
            tmpDir: TMP,
            prefix: PAYLOAD.disk_prefix,
            finishedAt: null,
        });
        expect(h.deleted).toEqual([]);
        expect(h.removed).toEqual([]);

        const dto = h.queue.list()[0];

        expect(dto).toMatchObject({
            state: 'upload_interrupted',
            canResume: true,
            canRetry: true,
            canRemove: true,
            canCancel: false,
            waitingForNetwork: false,
        });
        expect(JSON.stringify(dto)).not.toContain(TMP);
        expect(JSON.stringify(dto)).not.toContain('disk_prefix');
        expect(h.queue.summary()).toMatchObject({ attention: 1, running: 0 });
        expect(h.queue.hasPausedUploads()).toBe(true);
    });

    it('does not keep an unresumable upload_interrupted: it fails and removes the temp dir', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.reject(
            new PipelineError({
                kind: 'upload_interrupted',
                step: 'uploading',
                message: 'x',
            }),
        );
        await flush();

        expect(h.job('job-1').state).toBe('failed');
        expect(h.removed).toEqual([join('/tmp/hls', h.job('job-1').publicId ?? '')]);
    });

    it('frees the slot of a paused upload so the next job starts', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1, '/v/b.mp4': 2 } });

        await h.queue.addFiles(['/v/a.mp4', '/v/b.mp4']);
        h.runs[0]?.reject(interruptedError());
        await flush();

        expect(h.states()).toEqual(['job-1:upload_interrupted', 'job-2:transcoding']);
    });
});

describe('network wait', () => {
    it('sets and clears the runtime flags; the state stays uploading', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });
        const since = h.state.clock - 5000;

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.opts.hooks.onStage('uploading');
        h.runs[0]?.opts.hooks.onNetworkWait?.({
            since,
            attempt: 1,
            nextRetryInMs: 2000,
            budgetRemainingMs: 1000,
        });

        expect(h.queue.list()[0]).toMatchObject({
            state: 'uploading',
            waitingForNetwork: true,
            networkWaitSince: new Date(since).toISOString(),
            canCancel: true,
        });
        // Never persisted.
        expect(JSON.stringify(h.store.get().jobs)).not.toContain('waitingForNetwork');
        expect(h.snapshots.at(-1)?.[0]?.waitingForNetwork).toBe(true);

        h.runs[0]?.opts.hooks.onNetworkRestored?.();

        expect(h.queue.list()[0]).toMatchObject({ state: 'uploading', waitingForNetwork: false });
        expect(h.queue.list()[0]?.networkWaitSince).toBeUndefined();
        expect(h.snapshots.at(-1)?.[0]?.waitingForNetwork).toBe(false);
    });

    it('emits the first wait immediately and throttles repeated notifications', async () => {
        vi.useFakeTimers();

        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });
        const info = { since: h.state.clock, attempt: 1, nextRetryInMs: 1, budgetRemainingMs: 1 };

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.opts.hooks.onStage('uploading');

        const before = h.snapshots.length;

        h.runs[0]?.opts.hooks.onNetworkWait?.(info);
        expect(h.snapshots.length).toBe(before + 1);

        for (let i = 0; i < 10; i++) h.runs[0]?.opts.hooks.onNetworkWait?.(info);

        // Same clock: everything else is coalesced into one trailing emit.
        expect(h.snapshots.length).toBe(before + 1);
        vi.advanceTimersByTime(300);
        expect(h.snapshots.length).toBe(before + 2);
    });

    it('cancelling during the wait deletes R2 files and the temp dir like a normal cancel', async () => {
        const h = createHarness({ auth: SITE_AUTH, files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        h.runs[0]?.cancelOnAbort('uploading');
        h.runs[0]?.opts.hooks.onNetworkWait?.({
            since: h.state.clock,
            attempt: 1,
            nextRetryInMs: 1,
            budgetRemainingMs: 1,
        });

        expect(await h.queue.cancel('job-1')).toEqual({ ok: true });
        await flush();

        expect(h.job('job-1').state).toBe('cancelled');
        expect(h.job('job-1').tmpDir).toBeUndefined();
        expect(h.queue.list()[0]?.waitingForNetwork).toBe(false);
    });
});

describe('resume', () => {
    it('continues without the pipeline, with the stored payload and the kept temp dir', async () => {
        const h = pausedHarness();

        expect(await h.queue.resume('p1')).toEqual({ ok: true });

        expect(h.runs).toHaveLength(0);
        expect(h.resumeRuns).toHaveLength(1);
        expect(h.resumeRuns[0]?.opts).toMatchObject({
            job: { id: 'p1', publicId: 'aaaaaaaaaaaa' },
            payload: PAYLOAD,
            tmpDir: TMP,
            config: CONFIG,
        });
        expect(h.job('p1')).toMatchObject({ state: 'uploading', errorMessage: null });
        expect(h.job('p1').mode).toBeUndefined();

        h.resumeRuns[0]?.opts.hooks.onStage('uploading');
        h.resumeRuns[0]?.opts.hooks.onProgress(50);
        expect(h.queue.list()[0]).toMatchObject({ state: 'uploading', progress: 50 });

        await h.resumeRuns[0]?.opts.hooks.onBeforeRegister?.();
        expect(h.job('p1').registerStarted).toBe(true);

        h.resumeRuns[0]?.resolve();
        await flush();

        const job = h.job('p1');

        expect(job.state).toBe('done');
        expect(job.registered?.public_id).toBe('aaaaaaaaaaaa');
        expect(job.registerPayload).toBeNull();
        expect(job.tmpDir).toBeUndefined();
        expect(job.registerStarted).toBeUndefined();
    });

    it('wires network wait hooks for a resumed upload', async () => {
        const h = pausedHarness();

        await h.queue.resume('p1');
        h.resumeRuns[0]?.opts.hooks.onNetworkWait?.({
            since: h.state.clock,
            attempt: 1,
            nextRetryInMs: 1,
            budgetRemainingMs: 1,
        });
        expect(h.queue.list()[0]?.waitingForNetwork).toBe(true);
    });

    it('goes back to upload_interrupted when the network fails again', async () => {
        const h = pausedHarness();

        await h.queue.resume('p1');
        h.resumeRuns[0]?.reject(interruptedError());
        await flush();

        expect(h.job('p1')).toMatchObject({ state: 'upload_interrupted', tmpDir: TMP });
        expect(h.deleted).toEqual([]);
        expect(h.removed).toEqual([]);
    });

    it('respects maxConcurrent: the resume waits for a free slot', async () => {
        const h = pausedHarness({}, { files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        expect(h.runs).toHaveLength(1);

        await h.queue.resume('p1');

        expect(h.job('p1').state).toBe('waiting');
        expect(h.job('p1').mode).toBe('resume');
        expect(h.resumeRuns).toHaveLength(0);
        expect(h.queue.list().find((j) => j.id === 'p1')?.waitingReason).toBe(
            'Waiting for other jobs to finish.',
        );

        h.runs[0]?.resolve();
        await flush();

        expect(h.resumeRuns).toHaveLength(1);
        expect(h.job('p1').state).toBe('uploading');
    });

    it('a running resume occupies a processing slot', async () => {
        const h = pausedHarness({}, { files: { '/v/a.mp4': 1 } });

        await h.queue.resume('p1');
        await h.queue.addFiles(['/v/a.mp4']);

        expect(h.runs).toHaveLength(0);
        h.resumeRuns[0]?.resolve();
        await flush();
        expect(h.runs).toHaveLength(1);
    });

    it('register failures after a resume map like in the pipeline', async () => {
        const h = pausedHarness();

        await h.queue.resume('p1');
        h.resumeRuns[0]?.reject(
            new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: 'site down',
                registerPayload: PAYLOAD,
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();

        expect(h.job('p1')).toMatchObject({ state: 'register_failed', registerPayload: PAYLOAD });
        expect(h.job('p1').tmpDir).toBeUndefined();
    });

    it('a failed resume removes leftovers of the temp dir', async () => {
        const h = pausedHarness();

        await h.queue.resume('p1');
        h.resumeRuns[0]?.reject(failedError('uploading'));
        await flush();

        expect(h.job('p1').state).toBe('failed');
        expect(h.removed).toEqual([TMP]);
    });

    it('cancelling a resume run ends as cancelled', async () => {
        const h = pausedHarness();

        await h.queue.resume('p1');
        h.resumeRuns[0]?.opts.hooks.signal.addEventListener('abort', () =>
            h.resumeRuns[0]?.reject(
                new PipelineError({ kind: 'cancelled', step: 'uploading', message: 'c' }),
            ),
        );
        await h.queue.cancel('p1');
        await flush();

        expect(h.job('p1')).toMatchObject({ state: 'cancelled', registerPayload: null });
    });

    it.each([
        ['not registered yet', undefined, 1],
        ['registerStarted false', false, 1],
    ])(
        'resume_unavailable falls back to a new run and deletes the old prefix (%s)',
        async (_n, started, deletes) => {
            const h = pausedHarness(started === undefined ? {} : { registerStarted: started });

            await h.queue.resume('p1');
            h.resumeRuns[0]?.reject(
                new PipelineError({
                    kind: 'failed',
                    step: 'uploading',
                    message: 'gone',
                    code: 'resume_unavailable',
                    prefix: PAYLOAD.disk_prefix,
                }),
            );
            await flush();
            await flush();

            expect(h.deleted).toHaveLength(deletes);
            expect(h.deleted[0]?.prefix).toBe(PAYLOAD.disk_prefix);
            expect(h.removed).toContain(TMP);
            // A brand-new run with a NEW public id.
            expect(h.runs).toHaveLength(1);
            expect(h.runs[0]?.opts.job.publicId).not.toBe('aaaaaaaaaaaa');
            expect(h.job('p1')).toMatchObject({ state: 'transcoding', registerPayload: null });
            expect(h.job('p1').tmpDir).toBeUndefined();
        },
    );

    it('resume_unavailable never deletes R2 files when the register call had started', async () => {
        const h = pausedHarness({ registerStarted: true });

        await h.queue.resume('p1');
        h.resumeRuns[0]?.reject(
            new PipelineError({
                kind: 'failed',
                step: 'uploading',
                message: 'gone',
                code: 'resume_unavailable',
                prefix: PAYLOAD.disk_prefix,
            }),
        );
        await flush();
        await flush();

        expect(h.deleted).toEqual([]);
        expect(h.removed).toContain(TMP);
        expect(h.runs).toHaveLength(1);
        expect(h.job('p1').registerStarted).toBeUndefined();
    });

    it('is refused for other states, unknown ids, a missing payload and double clicks', async () => {
        const h = pausedHarness({}, { files: { '/v/a.mp4': 1 } });

        h.store.update((d) => {
            d.jobs.push(
                pausedRecord({ id: 'nopayload', registerPayload: null }),
                pausedRecord({ id: 'failed', state: 'failed' }),
            );
        });

        expect((await h.queue.resume('nope')).ok).toBe(false);
        expect((await h.queue.resume('nopayload')).ok).toBe(false);
        expect((await h.queue.resume('failed')).ok).toBe(false);
        expect(await h.queue.resume('p1')).toEqual({ ok: true });
        expect((await h.queue.resume('p1')).ok).toBe(false);
        expect(h.resumeRuns).toHaveLength(1);
    });

    it('requires being signed in', async () => {
        const h = pausedHarness({}, { auth: { status: 'signed_out' } });

        expect(await h.queue.resume('p1')).toEqual({
            ok: false,
            error: 'Sign in to resume this upload.',
        });
        expect(h.job('p1').state).toBe('upload_interrupted');
    });

    it('refuses to resume against another site', async () => {
        const h = pausedHarness({ siteOrigin: 'https://other.example.com' });
        const result = await h.queue.resume('p1');

        expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining('other.example.com'),
        });
        expect(h.resumeRuns).toHaveLength(0);
        expect(h.job('p1').state).toBe('upload_interrupted');
    });

    it('a queued resume returns to the paused state when the site changed meanwhile', async () => {
        const h = pausedHarness({}, { files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        await h.queue.resume('p1');
        h.setAuth({
            status: 'signed_in',
            r2Configured: true,
            siteUrl: 'https://other.example.com',
        });
        h.runs[0]?.resolve();
        await flush();

        expect(h.job('p1')).toMatchObject({
            state: 'upload_interrupted',
            errorMessage: expect.stringContaining('site.example.com'),
        });
        expect(h.job('p1').mode).toBeUndefined();
        expect(h.resumeRuns).toHaveLength(0);
    });

    it('does not resume automatically after signing in again', async () => {
        const h = pausedHarness({}, { auth: { status: 'signed_out' } });

        h.setAuth(SITE_AUTH);
        await flush();

        expect(h.resumeRuns).toHaveLength(0);
        expect(h.job('p1').state).toBe('upload_interrupted');
    });

    it('cancelling a queued resume discards the kept files like a running cancel', async () => {
        const h = pausedHarness({}, { files: { '/v/a.mp4': 1 } });

        await h.queue.addFiles(['/v/a.mp4']);
        await h.queue.resume('p1');
        expect(await h.queue.cancel('p1')).toEqual({ ok: true });

        expect(h.job('p1')).toMatchObject({ state: 'cancelled', registerPayload: null });
        expect(h.job('p1').mode).toBeUndefined();
        expect(h.deleted.map((d) => d.prefix)).toEqual([PAYLOAD.disk_prefix]);
        expect(h.removed).toEqual([TMP]);
    });

    it('cannot cancel a paused upload directly', async () => {
        const h = pausedHarness();

        expect((await h.queue.cancel('p1')).ok).toBe(false);
    });
});

describe('start over, remove and clearFinished for paused uploads', () => {
    it('Start over removes the temp dir and the old prefix, then runs with a NEW public id', async () => {
        const h = pausedHarness();

        expect(await h.queue.retry('p1')).toEqual({ ok: true });

        expect(h.deleted.map((d) => d.prefix)).toEqual([PAYLOAD.disk_prefix]);
        expect(h.removed).toEqual([TMP]);
        expect(h.runs).toHaveLength(1);
        expect(h.runs[0]?.opts.job.publicId).not.toBe('aaaaaaaaaaaa');
        expect(h.job('p1')).toMatchObject({ state: 'transcoding', registerPayload: null });
        expect(h.job('p1').tmpDir).toBeUndefined();
        expect(h.resumeRuns).toHaveLength(0);
    });

    it('Start over keeps the R2 files when the register call had started', async () => {
        const h = pausedHarness({ registerStarted: true });

        await h.queue.retry('p1');

        expect(h.deleted).toEqual([]);
        expect(h.removed).toEqual([TMP]);
        expect(h.logger.entries.some((e) => /may be orphaned/.test(e.message))).toBe(true);
        expect(h.job('p1').registerStarted).toBeUndefined();
    });

    it('Start over still works when no config is available for the cleanup', async () => {
        const h = pausedHarness({}, { config: null });

        await h.queue.retry('p1');

        expect(h.deleted).toEqual([]);
        expect(h.removed).toEqual([TMP]);
        expect(h.job('p1').state).toBe('waiting');
    });

    it('Remove deletes the temp dir and the R2 prefix', async () => {
        const h = pausedHarness();

        expect(await h.queue.remove('p1')).toEqual({ ok: true });

        expect(h.states()).toEqual([]);
        expect(h.removed).toEqual([TMP]);
        expect(h.deleted.map((d) => d.prefix)).toEqual([PAYLOAD.disk_prefix]);
    });

    it('Remove keeps the R2 files when the site may have registered the video', async () => {
        const h = pausedHarness({ registerStarted: true });

        await h.queue.remove('p1');

        expect(h.removed).toEqual([TMP]);
        expect(h.deleted).toEqual([]);
    });

    it('Remove skips the R2 cleanup for another site or without a config, but still removes the dir', async () => {
        const other = pausedHarness({ siteOrigin: 'https://other.example.com' });
        const noConfig = pausedHarness({}, { config: null });

        await other.queue.remove('p1');
        await noConfig.queue.remove('p1');

        expect(other.deleted).toEqual([]);
        expect(other.removed).toEqual([TMP]);
        expect(noConfig.deleted).toEqual([]);
        expect(noConfig.removed).toEqual([TMP]);
        expect(other.states()).toEqual([]);
    });

    it('clearFinished never touches paused uploads', async () => {
        const h = pausedHarness();

        h.store.update((d) => {
            d.jobs.push(pausedRecord({ id: 'f', state: 'failed', tmpDir: undefined }));
        });
        h.queue.clearFinished();

        expect(h.states()).toEqual(['p1:upload_interrupted']);
        expect(h.removed).toEqual([]);
        expect(h.deleted).toEqual([]);
    });

    it('keeps the source file deduplicated while the upload is paused', async () => {
        const h = pausedHarness({}, { files: { '/v/p1.mp4': 1 } });
        const result = await h.queue.addFiles(['/v/p1.mp4']);

        expect(result.added).toBe(0);
    });
});

describe('recovery of paused uploads', () => {
    function running(id: string, state: JobRecord['state'], over: Partial<JobRecord> = {}) {
        const publicId = `${id}`.padEnd(12, 'x');

        return pausedRecord({
            id,
            state,
            publicId,
            tmpDir: join('/tmp/hls', publicId),
            registerPayload: PAYLOAD,
            errorMessage: null,
            errorDetail: null,
            ...over,
        });
    }

    it('keeps uploads that have payload and temp dir, interrupts the rest', async () => {
        const h = createHarness({
            auth: { status: 'signed_out' },
            files: {
                [join('/tmp/hls', 'upxxxxxxxxxx')]: -1,
                [join('/tmp/hls', 'rgxxxxxxxxxx')]: -1,
            },
        });

        h.store.update((d) => {
            d.jobs.push(
                running('up', 'uploading'),
                running('rg', 'registering', { registerStarted: true }),
                running('gone', 'uploading'),
                running('nopay', 'uploading', { registerPayload: null }),
                running('tc', 'transcoding', { registerPayload: null, tmpDir: undefined }),
                running('wr', 'waiting', { mode: 'resume' }),
                running('keep', 'upload_interrupted'),
            );
        });

        await h.queue.recover();

        expect(h.states()).toEqual([
            'up:upload_interrupted',
            'rg:upload_interrupted',
            'gone:interrupted',
            'nopay:interrupted',
            'tc:interrupted',
            'wr:upload_interrupted',
            'keep:upload_interrupted',
        ]);
        expect(h.job('up')).toMatchObject({
            errorMessage: 'The app was closed during upload. Resume to continue.',
            errorDetail: { step: 'uploading' },
            registerPayload: PAYLOAD,
            tmpDir: join('/tmp/hls', 'upxxxxxxxxxx'),
            finishedAt: null,
        });
        expect(h.job('rg').registerStarted).toBe(true);
        expect(h.job('wr').mode).toBeUndefined();
        expect(h.job('gone').tmpDir).toBeUndefined();
        // Kept jobs keep their temp dirs; the others are cleaned like before. Never R2.
        expect(h.removed.sort()).toEqual(
            [
                join('/tmp/hls', 'gonexxxxxxxx'),
                join('/tmp/hls', 'nopayxxxxxxx'),
                join('/tmp/hls', 'tcxxxxxxxxxx'),
            ].sort(),
        );
        expect(h.deleted).toEqual([]);
        expect(h.queue.hasPausedUploads()).toBe(true);
        expect(h.queue.list().find((j) => j.id === 'up')).toMatchObject({ canResume: true });
    });
});
