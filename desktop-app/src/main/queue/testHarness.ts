/** Test helpers for the job queue: a controllable fake pipeline and fake collaborators. */
import type { S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';
import type { AppConfig } from '../../shared/appConfig';
import type { AuthState, JobDto } from '../../shared/ipc';
import type { JobRecord, JobState } from '../../shared/types';
import type { PipelineDeps } from '../pipeline/deps';
import { cancelledError, PipelineError } from '../pipeline/errors';
import type {
    PipelineResult,
    RetryRegisterOptions,
    RunPipelineOptions,
} from '../pipeline/runPipeline';
import { createMemoryStore, recordingLogger } from '../testing/memoryStore';
import { JobQueue, type JobQueueOptions } from './jobQueue';

export const CONFIG: AppConfig = {
    r2: {
        access_key_id: 'AKIA',
        secret_access_key: 'secret',
        bucket: 'bucket',
        endpoint: 'https://r2.example.com',
        url: 'https://cdn.example.com',
    },
    transcode: { resolution: '720', segment_seconds: 6, fps: null },
};

export const PAYLOAD = {
    public_id: 'aaaaaaaaaaaa',
    title: 't',
    original_filename: 't.mp4',
    original_size_bytes: 1,
    disk_prefix: '2026/01/01/t-aaaaaaaaaaaa/',
    playlist_path: '2026/01/01/t-aaaaaaaaaaaa/playlist.m3u8',
    thumbnail_path: null,
    storyboards: null,
    duration: null,
    output_width: null,
    output_height: null,
    output_fps: null,
    output_bitrate_kbps: null,
    output_codec: null,
};

export interface FakeRun {
    opts: RunPipelineOptions;
    resolve(result?: Partial<PipelineResult>): void;
    reject(error: unknown): void;
    /** Rejects with a cancelled error as soon as the signal aborts. */
    cancelOnAbort(step?: JobState): void;
}

export interface FakeRegisterRun {
    opts: RetryRegisterOptions;
    resolve(): void;
    reject(error: unknown): void;
}

export function createHarness(
    overrides: Partial<JobQueueOptions> & {
        auth?: AuthState;
        config?: AppConfig | null;
        files?: Record<string, number>;
        maxConcurrent?: number;
    } = {},
) {
    const store = createMemoryStore('/tmp/hls');
    store.update((d) => {
        d.settings.maxConcurrent = overrides.maxConcurrent ?? 1;
    });

    const files = new Map<string, number>(Object.entries(overrides.files ?? {}));
    const removed: string[] = [];
    const runs: FakeRun[] = [];
    const registerRuns: FakeRegisterRun[] = [];
    const deleted: { bucket: string; prefix: string }[] = [];
    const logger = recordingLogger();
    const authListeners = new Set<(s: AuthState) => void>();
    const state = {
        auth: overrides.auth ?? ({ status: 'signed_in', r2Configured: true } as AuthState),
        config: overrides.config === undefined ? CONFIG : overrides.config,
        block: null as string | null,
        clock: Date.parse('2026-01-01T00:00:00.000Z'),
        ids: 0,
        publicIds: 0,
    };

    const deps = {
        tmpRoot: '/tmp/hls',
        createS3Client: () => ({ destroy: () => undefined }) as unknown as S3Client,
    } as unknown as PipelineDeps;

    const options: JobQueueOptions = {
        store,
        runPipelineFn: (opts) =>
            new Promise<PipelineResult>((resolve, reject) => {
                runs.push({
                    opts,
                    resolve: (result) =>
                        resolve({
                            kind: 'done',
                            registered: {
                                id: runs.length,
                                public_id: opts.job.publicId,
                                embed_url: `https://site.example.com/embed/${opts.job.publicId}`,
                            },
                            prefix: `2026/01/01/x-${opts.job.publicId}/`,
                            payload: PAYLOAD,
                            ...result,
                        }),
                    reject,
                    cancelOnAbort: (step = 'transcoding') =>
                        opts.hooks.signal.addEventListener('abort', () =>
                            reject(cancelledError(step)),
                        ),
                });
            }),
        retryRegisterFn: (opts) =>
            new Promise<PipelineResult>((resolve, reject) => {
                registerRuns.push({
                    opts,
                    resolve: () =>
                        resolve({
                            kind: 'done',
                            registered: {
                                id: 1,
                                public_id: opts.payload.public_id,
                                embed_url: `https://site.example.com/embed/${opts.payload.public_id}`,
                            },
                            prefix: opts.payload.disk_prefix,
                            payload: opts.payload,
                        }),
                    reject,
                });
            }),
        deletePrefixFn: (_client, bucket, prefix) => {
            deleted.push({ bucket, prefix });

            return Promise.resolve({ ok: true, deleted: 1 });
        },
        getDeps: () => deps,
        getConfig: () => state.config,
        getAuthState: () => state.auth,
        subscribeAuth: (listener) => {
            authListeners.add(listener);

            return () => authListeners.delete(listener);
        },
        getStartBlock: () => state.block,
        fs: {
            stat: (path) => {
                const size = files.get(path);

                if (size === undefined) return Promise.reject(new Error('ENOENT'));

                return Promise.resolve({ isFile: () => size >= 0, size: Math.max(size, 0) });
            },
            rm: (path) => {
                removed.push(path);

                return Promise.resolve();
            },
        },
        now: () => new Date(state.clock),
        generateId: () => `job-${++state.ids}`,
        generatePublicId: () => `pub${String(++state.publicIds).padStart(9, '0')}`,
        platform: 'linux',
        logger,
        throttleMs: 250,
        shutdownTimeoutMs: 200,
        ...overrides,
    };

    // Keep harness-only keys out of the queue options.
    delete (options as Partial<typeof overrides>).auth;
    delete (options as Partial<typeof overrides>).config;
    delete (options as Partial<typeof overrides>).files;
    delete (options as Partial<typeof overrides>).maxConcurrent;

    const queue = new JobQueue(options);
    const snapshots: JobDto[][] = [];
    queue.subscribe((jobs) => snapshots.push(jobs));
    const updateSpy = vi.spyOn(store, 'update');

    return {
        queue,
        store,
        state,
        runs,
        registerRuns,
        deleted,
        removed,
        logger,
        snapshots,
        updateSpy,
        files,
        setAuth(next: AuthState) {
            state.auth = next;
            for (const listener of [...authListeners]) listener(next);
        },
        job(id: string): JobRecord {
            const job = store.get().jobs.find((j) => j.id === id);

            if (!job) throw new Error(`no job ${id}`);

            return job;
        },
        states: () => store.get().jobs.map((j) => `${j.id}:${j.state}`),
        advance(ms: number) {
            state.clock += ms;
        },
    };
}

/** Lets promise continuations (then/finally) run. */
export async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

export function failedError(step: JobState, message = 'boom'): PipelineError {
    return new PipelineError({
        kind: 'failed',
        step,
        message,
        exitCode: 1,
        stderrTail: ['line 1', 'line 2'],
    });
}
