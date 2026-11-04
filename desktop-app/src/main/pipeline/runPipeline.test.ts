import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineError } from './errors';
import { REGISTER_RETRY_DELAYS_MS } from './register';
import { RegisterRequestError } from './registerClient';
import {
    retryRegister,
    runPipeline,
    type BeforeUploadInfo,
    type PipelineHooks,
    type PipelineResult,
    type PipelineStep,
} from './runPipeline';
import {
    FakeRegister,
    FakeS3,
    TEST_CONFIG,
    createFakeRunner,
    makeTempDir,
    makeTestDeps,
    type CallKind,
    type FakeRunnerOptions,
    type FakeS3Options,
    type RegisterBehavior,
} from './testing/fakes';

const PUBLIC_ID = 'ab12cd34ef56';
const PREFIX = `2026/03/05/video-mau-tieng-viet-1-${PUBLIC_ID}/`;
const FILENAME = 'Video Mẫu Tiếng Việt (1).mp4';

let root: string;
let sourcePath: string;
let tmpRoot: string;

beforeEach(async () => {
    root = await makeTempDir('pipeline-unit');
    tmpRoot = join(root, 'tmp');
    await mkdir(tmpRoot);
    sourcePath = join(root, FILENAME);
    await writeFile(sourcePath, Buffer.alloc(2048));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

interface Harness {
    stages: PipelineStep[];
    percents: number[];
    sleeps: number[];
    controller: AbortController;
    runner: ReturnType<typeof createFakeRunner>;
    s3: FakeS3;
    register: FakeRegister;
    hooks: PipelineHooks;
    run: (over?: { filename?: string; sourcePath?: string }) => Promise<PipelineResult>;
    deps: ReturnType<typeof makeTestDeps>;
}

function harness(
    options: {
        runner?: FakeRunnerOptions;
        s3?: FakeS3Options;
        register?: RegisterBehavior;
        freeBytes?: number;
        config?: typeof TEST_CONFIG;
    } = {},
): Harness {
    const stages: PipelineStep[] = [];
    const percents: number[] = [];
    const sleeps: number[] = [];
    const controller = new AbortController();
    const runner = createFakeRunner(options.runner);
    const s3 = new FakeS3(options.s3);
    const register = new FakeRegister(options.register);
    const deps = makeTestDeps({
        runner,
        s3,
        register,
        tmpRoot,
        sleeps,
        freeBytes: options.freeBytes,
    });
    const hooks: PipelineHooks = {
        onStage: (s) => stages.push(s),
        onProgress: (p) => percents.push(p),
        signal: controller.signal,
    };

    return {
        stages,
        percents,
        sleeps,
        controller,
        runner,
        s3,
        register,
        hooks,
        deps,
        run: (over = {}) =>
            runPipeline({
                job: {
                    id: 'job-1',
                    sourcePath: over.sourcePath ?? sourcePath,
                    filename: over.filename ?? FILENAME,
                    publicId: PUBLIC_ID,
                },
                config: options.config ?? TEST_CONFIG,
                deps,
                hooks,
            }),
    };
}

async function waitFor(condition: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
        await new Promise((r) => setTimeout(r, 5));
    }
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

async function failureOf(promise: Promise<unknown>): Promise<PipelineError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);

        return error as PipelineError;
    }

    throw new Error('Expected the pipeline to fail.');
}

function kinds(h: Harness): CallKind[] {
    return h.runner.calls.map((c) => c.kind);
}

function deletes(h: Harness): string[][] {
    return h.s3.requests.filter((r) => r.type === 'delete').map((r) => r.keys);
}

describe('runPipeline: happy path', () => {
    it('runs every step in order and registers the payload', async () => {
        const h = harness();
        const result = await h.run();
        const order = kinds(h);

        expect(result.kind).toBe('done');
        expect(result.prefix).toBe(PREFIX);
        expect(result.registered.public_id).toBe(PUBLIC_ID);
        expect(h.stages).toEqual([
            'transcoding',
            'thumbnail',
            'storyboard',
            'uploading',
            'registering',
        ]);

        const first = (kind: CallKind): number => order.indexOf(kind);
        const last = (kind: CallKind): number => order.lastIndexOf(kind);

        expect(first('probe-duration')).toBe(0);
        expect(first('probe-fps')).toBe(1);
        expect(first('transcode')).toBe(2);
        expect(first('probe-output')).toBe(3);
        expect(last('probe-output')).toBe(3);
        expect(first('thumb-frame')).toBeGreaterThan(first('probe-output'));
        expect(first('sb-candidates')).toBeGreaterThan(last('hstack'));
        expect(last('sb-tile')).toBe(order.length - 1);
        expect(order.filter((k) => k === 'sb-tile')).toHaveLength(3);
    });

    it('uploads under the prefix with the playlist last and registers a consistent payload', async () => {
        const h = harness();

        await h.run();

        const keys = h.s3.putKeys;

        expect(keys.length).toBe(2 + 1 + 3 + 1);
        expect(keys.every((k) => k.startsWith(PREFIX))).toBe(true);
        expect(keys.at(-1)).toBe(`${PREFIX}playlist.m3u8`);
        expect(keys).toContain(`${PREFIX}thumbnail.jpg`);
        expect(keys).toContain(`${PREFIX}storyboard_5x5.jpg`);
        expect(h.s3.requests.filter((r) => r.type === 'put').map((r) => r.contentType)).toContain(
            'application/vnd.apple.mpegurl',
        );
        expect(h.register.payloads).toHaveLength(1);
        expect(h.register.payloads[0]).toMatchObject({
            public_id: PUBLIC_ID,
            title: 'Video Mẫu Tiếng Việt (1)',
            original_filename: FILENAME,
            original_size_bytes: 2048,
            disk_prefix: PREFIX,
            playlist_path: `${PREFIX}playlist.m3u8`,
            thumbnail_path: `${PREFIX}thumbnail.jpg`,
            duration: 12,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            output_bitrate_kbps: 1500,
            output_codec: 'h264',
        });
        expect(Object.keys(h.register.payloads[0]?.storyboards ?? {})).toEqual([
            '3x3',
            '4x4',
            '5x5',
        ]);
    });

    it('reports a monotonic overall progress that ends at 100 and removes the temp dir', async () => {
        const h = harness();

        await h.run();

        expect(h.percents.length).toBeGreaterThan(3);
        expect([...h.percents].sort((a, b) => a - b)).toEqual(h.percents);
        expect(new Set(h.percents).size).toBe(h.percents.length);
        expect(h.percents.at(-1)).toBe(100);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
        expect(deletes(h)).toEqual([]);
    });

    it('skips the source fps probe when the config forces an fps', async () => {
        const h = harness({
            config: { ...TEST_CONFIG, transcode: { ...TEST_CONFIG.transcode, fps: 24 } },
        });

        await h.run();

        expect(kinds(h)).not.toContain('probe-fps');
        const transcode = h.runner.calls.find((c) => c.kind === 'transcode');

        expect(transcode?.args).toContain('-r');
    });

    it('uses the single-frame path for videos shorter than 3 seconds', async () => {
        const h = harness({ runner: { duration: 1.2 } });

        await h.run();

        expect(kinds(h).filter((k) => k === 'thumb-frame')).toHaveLength(1);
        expect(h.register.payloads[0]?.thumbnail_path).toBe(`${PREFIX}thumbnail.jpg`);
    });

    it('builds a triple-column thumbnail for portrait output', async () => {
        const h = harness({ runner: { outputWidth: 720, outputHeight: 1280 } });

        await h.run();

        expect(kinds(h)).toContain('hstack');
        expect(h.runner.calls.filter((c) => c.kind === 'crop-scale')).toHaveLength(3);
    });

    it('skips storyboards (null) when the duration is unknown', async () => {
        const h = harness({ runner: { duration: 'N/A' } });

        await h.run();

        expect(kinds(h)).not.toContain('sb-candidates');
        expect(h.register.payloads[0]?.storyboards).toBeNull();
        expect(h.register.payloads[0]?.duration).toBeNull();
    });
});

describe('runPipeline: step 0 checks', () => {
    it('rejects an unsupported extension before touching anything', async () => {
        const h = harness();
        const bad = join(root, 'notes.txt');

        await writeFile(bad, 'x');
        const error = await failureOf(h.run({ sourcePath: bad }));

        expect(error).toMatchObject({ kind: 'failed', step: 'waiting' });
        expect(error.message).toMatch(/Unsupported file type/);
        expect(h.runner.calls).toHaveLength(0);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
    });

    it.each(['mp4', 'MOV', 'mkv', 'avi', 'webm'])('accepts the .%s extension', async (ext) => {
        const h = harness();
        const file = join(root, `clip.${ext}`);

        await writeFile(file, Buffer.alloc(10));
        await expect(h.run({ sourcePath: file, filename: `clip.${ext}` })).resolves.toMatchObject({
            kind: 'done',
        });
    });

    it('fails when the source file does not exist, without leaking its path', async () => {
        const h = harness();
        const error = await failureOf(h.run({ sourcePath: join(root, 'missing.mp4') }));

        expect(error.message).toBe('The source file was not found.');
        expect(error.message).not.toContain(root);
    });

    it('fails early when there is not enough free disk space', async () => {
        const h = harness({ freeBytes: 1024 ** 3 });
        const error = await failureOf(h.run());

        expect(error).toMatchObject({ kind: 'failed', step: 'waiting' });
        expect(error.message).toMatch(/free disk space/);
        expect(h.runner.calls).toHaveLength(0);
        expect(h.s3.requests).toHaveLength(0);
    });

    it('needs size * 1.5 + 1 GiB of free space', async () => {
        const needed = Math.ceil(2048 * 1.5 + 1024 ** 3);

        await expect(harness({ freeBytes: needed - 1 }).run()).rejects.toBeInstanceOf(
            PipelineError,
        );
        await expect(harness({ freeBytes: needed }).run()).resolves.toMatchObject({ kind: 'done' });
    });
});

describe('runPipeline: failures', () => {
    it('fails the job when the transcode exits non-zero and scrubs paths from stderr', async () => {
        const h = harness({
            runner: {
                override: (call) =>
                    call.kind === 'transcode'
                        ? {
                              exitCode: 1,
                              stderrTail: [`${sourcePath}: Invalid data found`, 'second line'],
                          }
                        : undefined,
            },
        });
        const error = await failureOf(h.run());

        expect(error).toMatchObject({ kind: 'failed', step: 'transcoding', exitCode: 1 });
        expect(error.stderrTail).toEqual(['<source>: Invalid data found', 'second line']);
        expect(error.message).not.toContain(root);
        expect(h.s3.requests).toHaveLength(0);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
    });

    it('fails when ffprobe cannot read the source', async () => {
        const h = harness({
            runner: {
                override: (c) => (c.kind === 'probe-duration' ? { exitCode: 1 } : undefined),
            },
        });

        expect(await failureOf(h.run())).toMatchObject({ kind: 'failed', step: 'transcoding' });
    });

    it('treats a thumbnail failure as "no thumbnail"', async () => {
        const h = harness({
            runner: { override: (c) => (c.kind === 'thumb-frame' ? { exitCode: 1 } : undefined) },
        });

        await h.run();

        expect(h.register.payloads[0]?.thumbnail_path).toBeNull();
        expect(h.s3.putKeys).not.toContain(`${PREFIX}thumbnail.jpg`);
    });

    it('treats a storyboard failure as "no storyboards"', async () => {
        const h = harness({
            runner: { override: (c) => (c.kind === 'sb-candidates' ? { exitCode: 1 } : undefined) },
        });

        await h.run();

        expect(h.register.payloads[0]?.storyboards).toBeNull();
        expect(h.s3.putKeys.some((k) => k.includes('storyboard_'))).toBe(false);
    });

    it('keeps the other grids when one storyboard grid fails', async () => {
        const h = harness({
            runner: {
                override: (c) =>
                    c.kind === 'sb-tile' && c.args.includes('tile=4x4')
                        ? { exitCode: 1 }
                        : undefined,
            },
        });

        await h.run();

        expect(Object.keys(h.register.payloads[0]?.storyboards ?? {})).toEqual(['3x3', '5x5']);
    });

    it('deletes the R2 prefix when the upload fails after it started', async () => {
        const h = harness({
            s3: {
                failPut: (key) =>
                    key.endsWith('segment_001.ts') ? new Error('HTTP 500') : undefined,
            },
        });
        const error = await failureOf(h.run());

        expect(error).toMatchObject({ kind: 'failed', step: 'uploading' });
        expect(h.s3.putKeys.filter((k) => k.endsWith('segment_001.ts'))).toHaveLength(3);
        expect(h.sleeps).toEqual([1000, 2000]);
        expect(h.s3.putKeys).not.toContain(`${PREFIX}playlist.m3u8`);
        expect(
            deletes(h)
                .flat()
                .every((k) => k.startsWith(PREFIX)),
        ).toBe(true);
        expect(h.s3.objects.size).toBe(0);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
        expect(h.register.payloads).toHaveLength(0);
    });

    it('retries a transient upload failure and finishes', async () => {
        const h = harness({
            s3: {
                failPut: (key, attempt) =>
                    key.endsWith('segment_000.ts') && attempt < 3 ? new Error('reset') : undefined,
            },
        });

        await expect(h.run()).resolves.toMatchObject({ kind: 'done' });
        expect(h.sleeps).toEqual([1000, 2000]);
    });
});

describe('runPipeline: cancellation', () => {
    const stagesToAbort: [string, CallKind][] = [
        ['probe', 'probe-duration'],
        ['transcode', 'transcode'],
        ['thumbnail', 'thumb-frame'],
        ['storyboard', 'sb-candidates'],
    ];

    it.each(stagesToAbort)(
        'aborting during %s cancels without touching R2',
        async (_name, kind) => {
            const h = harness({ runner: { blockOn: (c) => c.kind === kind } });
            const pending = h.run();

            await waitFor(() => h.runner.calls.some((c) => c.kind === kind));
            h.controller.abort();
            const error = await failureOf(pending);

            expect(error.kind).toBe('cancelled');
            expect(h.s3.requests).toHaveLength(0);
            expect(h.register.payloads).toHaveLength(0);
            expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
        },
    );

    it('aborting before the pipeline starts the first process cancels immediately', async () => {
        const h = harness();

        h.controller.abort();
        const error = await failureOf(h.run());

        expect(error.kind).toBe('cancelled');
        expect(h.runner.calls).toHaveLength(0);
    });

    it('aborting during the upload deletes the prefix and keeps nothing', async () => {
        const h = harness({ s3: { blockPut: (key) => key.endsWith('segment_001.ts') } });
        const pending = h.run();

        await waitFor(() => h.s3.putKeys.some((k) => k.endsWith('segment_001.ts')));
        h.controller.abort();
        const error = await failureOf(pending);

        expect(error.kind).toBe('cancelled');
        expect(error.prefix).toBe(PREFIX);
        expect(h.s3.objects.size).toBe(0);
        expect(deletes(h).length).toBeGreaterThan(0);
        expect(h.s3.putKeys).not.toContain(`${PREFIX}playlist.m3u8`);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
    });
});

describe('runPipeline: register', () => {
    const network = (): RegisterRequestError => new RegisterRequestError({ kind: 'network' });

    it('retries with the 1, 2, 4, 8, 16 s backoff and succeeds on a later attempt', async () => {
        const h = harness({
            register: (payload, attempt) =>
                attempt < 4
                    ? network()
                    : { id: 7, public_id: payload.public_id, embed_url: 'https://x/embed/y' },
        });
        const result = await h.run();

        expect(result.registered.id).toBe(7);
        expect(h.register.payloads).toHaveLength(4);
        expect(h.sleeps).toEqual([1000, 2000, 4000]);
    });

    it('after 6 network failures keeps R2 and returns register_failed with the payload', async () => {
        const h = harness({ register: () => network() });
        const error = await failureOf(h.run());

        expect(error.kind).toBe('register_failed');
        expect(error.step).toBe('registering');
        expect(h.register.payloads).toHaveLength(6);
        expect(h.sleeps).toEqual([...REGISTER_RETRY_DELAYS_MS]);
        expect(error.registerPayload?.disk_prefix).toBe(PREFIX);
        expect(deletes(h)).toEqual([]);
        expect(h.s3.objects.size).toBe(7);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
    });

    it('retryRegister finishes the registration without any new upload', async () => {
        const first = harness({ register: () => network() });
        const error = await failureOf(first.run());
        const payload = error.registerPayload;

        expect(payload).toBeDefined();

        const second = harness();
        const result = await retryRegister({
            payload: payload as NonNullable<typeof payload>,
            deps: second.deps,
            hooks: second.hooks,
        });

        expect(result.registered.public_id).toBe(PUBLIC_ID);
        expect(second.s3.requests).toHaveLength(0);
        expect(second.runner.calls).toHaveLength(0);
        expect(second.stages).toEqual(['registering']);
        expect(second.percents.at(-1)).toBe(100);
    });

    it('retryRegister can fail again with needs_sign_in and keeps the payload', async () => {
        const h = harness({
            register: () => new RegisterRequestError({ kind: 'http', status: 401 }),
        });
        const error = await failureOf(
            retryRegister({
                payload: await buildPayload(),
                deps: h.deps,
                hooks: h.hooks,
            }),
        );

        expect(error).toMatchObject({ kind: 'needs_sign_in' });
        expect(error.registerPayload).toBeDefined();
    });

    it('401 surfaces needs_sign_in without retries and without touching R2', async () => {
        const h = harness({
            register: () => new RegisterRequestError({ kind: 'http', status: 401 }),
        });
        const error = await failureOf(h.run());

        expect(error.kind).toBe('needs_sign_in');
        expect(error.registerPayload?.public_id).toBe(PUBLIC_ID);
        expect(h.register.payloads).toHaveLength(1);
        expect(h.sleeps).toEqual([]);
        expect(deletes(h)).toEqual([]);
        expect(h.s3.objects.size).toBe(7);
    });

    it('honors Retry-After on HTTP 429 and otherwise uses the normal backoff', async () => {
        const h = harness({
            register: (payload, attempt) =>
                attempt === 1
                    ? new RegisterRequestError({ kind: 'http', status: 429, retryAfterSeconds: 3 })
                    : attempt === 2
                      ? new RegisterRequestError({ kind: 'http', status: 429 })
                      : { id: 1, public_id: payload.public_id, embed_url: 'https://x/e' },
        });

        await h.run();

        expect(h.sleeps).toEqual([3000, 2000]);
    });

    it.each([400, 403, 404, 405])(
        'HTTP %i keeps R2 and yields register_failed with the payload (no backoff)',
        async (status) => {
            const h = harness({
                register: () => new RegisterRequestError({ kind: 'http', status }),
            });
            const error = await failureOf(h.run());

            expect(error.kind).toBe('register_failed');
            expect(error.registerPayload?.disk_prefix).toBe(PREFIX);
            expect(h.register.payloads).toHaveLength(1);
            expect(h.sleeps).toEqual([]);
            expect(deletes(h)).toEqual([]);
            expect(h.s3.objects.size).toBe(7);
        },
    );

    it('retryRegister after HTTP 403 keeps the payload (register_failed)', async () => {
        const h = harness({
            register: () => new RegisterRequestError({ kind: 'http', status: 403 }),
        });
        const error = await failureOf(
            retryRegister({ payload: await buildPayload(), deps: h.deps, hooks: h.hooks }),
        );

        expect(error.kind).toBe('register_failed');
        expect(error.registerPayload).toBeDefined();
    });

    it('fails the job and deletes the R2 prefix on a definitive 409', async () => {
        const h = harness({
            register: () =>
                new RegisterRequestError({
                    kind: 'http',
                    status: 409,
                    errorCode: 'public_id_conflict',
                }),
        });
        const error = await failureOf(h.run());

        expect(error.kind).toBe('failed');
        expect(h.s3.objects.size).toBe(0);
    });

    it('fails the job and deletes the R2 prefix on a definitive 422', async () => {
        const h = harness({
            register: () =>
                new RegisterRequestError({
                    kind: 'http',
                    status: 422,
                    errorCode: 'playlist_not_found',
                }),
        });
        const error = await failureOf(h.run());

        expect(error.kind).toBe('failed');
        expect(error.message).toMatch(/playlist was not found/);
        expect(h.register.payloads).toHaveLength(1);
        expect(h.s3.objects.size).toBe(0);
    });

    it('a cancel between register retries keeps R2 and yields register_failed', async () => {
        const h = harness({ register: () => network() });
        const original = h.deps.sleep;

        h.deps.sleep = async (ms, signal) => {
            h.controller.abort();
            await original(ms, signal);
        };

        const error = await failureOf(h.run());

        expect(error.kind).toBe('register_failed');
        expect(error.message).toMatch(/interrupted/);
        // The abort happened during the backoff sleep: no further request may be sent.
        expect(h.register.payloads).toHaveLength(1);
        expect(deletes(h)).toEqual([]);
    });

    it('a cancel during the 3rd backoff sleep stops after exactly 3 requests', async () => {
        const h = harness({ register: () => network() });
        const original = h.deps.sleep;
        let sleeps = 0;

        h.deps.sleep = async (ms, signal) => {
            if (++sleeps === 3) h.controller.abort();
            await original(ms, signal);
        };

        const error = await failureOf(h.run());

        expect(error.kind).toBe('register_failed');
        expect(h.register.payloads).toHaveLength(3);
    });

    it.each([
        [409, undefined],
        [409, 'something_else'],
        [422, undefined],
        [422, 'validation_failed'],
    ])(
        'a generic HTTP %i (%s) keeps R2 and the payload (register_failed, no delete)',
        async (status, errorCode) => {
            const h = harness({
                register: () => new RegisterRequestError({ kind: 'http', status, errorCode }),
            });
            const error = await failureOf(h.run());

            expect(error.kind).toBe('register_failed');
            expect(error.registerPayload?.disk_prefix).toBe(PREFIX);
            expect(deletes(h)).toEqual([]);
            expect(h.s3.objects.size).toBe(7);
        },
    );

    it('retryRegister with a generic 422 keeps the payload (register_failed)', async () => {
        const h = harness({
            register: () => new RegisterRequestError({ kind: 'http', status: 422 }),
        });
        const error = await failureOf(
            retryRegister({ payload: await buildPayload(), deps: h.deps, hooks: h.hooks }),
        );

        expect(error.kind).toBe('register_failed');
        expect(error.registerPayload).toBeDefined();
    });
});

describe('runPipeline: durable registering transition', () => {
    it('awaits onBeforeRegister after the registering stage and before the first request', async () => {
        const h = harness();
        const events: string[] = [];

        h.hooks.onStage = (stage) => events.push(`stage:${stage}`);
        h.hooks.onBeforeRegister = async () => {
            await Promise.resolve();
            events.push(`before-register:${h.register.payloads.length}`);
        };

        await h.run();

        expect(events.slice(-2)).toEqual(['stage:registering', 'before-register:0']);
    });

    it('also runs before the register-only retry', async () => {
        const h = harness();
        const events: string[] = [];

        h.hooks.onBeforeRegister = () => {
            events.push(`before:${h.register.payloads.length}`);

            return Promise.resolve();
        };

        await retryRegister({ payload: await buildPayload(), deps: h.deps, hooks: h.hooks });

        expect(events).toEqual(['before:0']);
    });
});

describe('runPipeline: S3 client lifecycle and key length', () => {
    it('destroys every S3 client after a successful run', async () => {
        const h = harness();

        await h.run();

        expect(h.s3.created).toBe(1);
        expect(h.s3.destroyed).toBe(1);
    });

    it('destroys the upload client and the cleanup client after a failed upload', async () => {
        const h = harness({ s3: { failPut: () => new Error('boom') } });

        await failureOf(h.run());

        expect(h.s3.created).toBe(2);
        expect(h.s3.destroyed).toBe(2);
    });

    it('caps a 240-character file name so every registered path fits 255 characters', async () => {
        const h = harness();
        const filename = `${'a'.repeat(236)}.mp4`;
        const result = await h.run({ filename });
        const payload = result.payload;
        const paths = [
            payload.disk_prefix,
            payload.playlist_path,
            payload.thumbnail_path,
            ...Object.values(payload.storyboards ?? {}).map((entry) => entry.path),
        ];

        expect(paths.length).toBeGreaterThan(3);
        expect(paths.every((path) => (path ?? '').length <= 255)).toBe(true);
        expect(payload.disk_prefix).toBe(`2026/03/05/${'a'.repeat(100)}-${PUBLIC_ID}/`);
    });
});

async function buildPayload(): Promise<NonNullable<PipelineError['registerPayload']>> {
    const h = harness({ register: () => new RegisterRequestError({ kind: 'network' }) });
    const error = await failureOf(h.run());

    return error.registerPayload as NonNullable<PipelineError['registerPayload']>;
}

function networkError(): Error {
    return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

/** Gives the harness a fake clock that only advances when the upload step sleeps. */
function useFakeClock(h: Harness): { now: number } {
    const clock = { now: 1_700_000_000_000 };

    h.deps.sleep = async (ms) => {
        h.sleeps.push(ms);
        clock.now += ms;
    };
    h.deps.uploadTuning = { now: () => clock.now, jitter: () => 0 };

    return clock;
}

describe('runPipeline: network drops during the upload', () => {
    it('survives a long outage without failing, re-transcoding or deleting anything', async () => {
        const h = harness({
            s3: {
                failPut: (key, attempt) =>
                    key.endsWith('segment_000.ts') && attempt <= 6 ? networkError() : undefined,
            },
        });
        const waits: number[] = [];
        let restored = 0;

        useFakeClock(h);
        h.hooks.onNetworkWait = (info) => waits.push(info.nextRetryInMs);
        h.hooks.onNetworkRestored = () => restored++;

        await expect(h.run()).resolves.toMatchObject({ kind: 'done' });

        expect(h.sleeps).toEqual([2000, 5000, 10000, 20000, 30000, 60000]);
        expect(waits.length).toBeGreaterThan(0);
        expect(restored).toBeGreaterThanOrEqual(1);
        expect(deletes(h)).toEqual([]);
        expect(h.runner.calls.filter((c) => c.kind === 'transcode')).toHaveLength(1);
    });

    it('calls onBeforeUpload once, before the first PutObject, with the final register payload', async () => {
        const h = harness();
        const infos: BeforeUploadInfo[] = [];
        let putsAtCall = -1;

        h.hooks.onBeforeUpload = async (info) => {
            putsAtCall = h.s3.putKeys.length;
            infos.push(info);
        };

        const result = await h.run();

        expect(infos).toHaveLength(1);
        expect(putsAtCall).toBe(0);
        expect(infos[0]).toEqual({
            prefix: PREFIX,
            publicId: PUBLIC_ID,
            tmpDir: join(tmpRoot, PUBLIC_ID),
            registerPayload: result.payload,
        });
        expect(infos[0]?.registerPayload).toEqual(h.register.payloads[0]);
        expect(h.stages.indexOf('uploading')).toBeGreaterThanOrEqual(0);
    });

    it('a failing onBeforeUpload stops the job before anything is uploaded', async () => {
        const h = harness();

        h.hooks.onBeforeUpload = async () => {
            throw new Error('disk full');
        };

        await failureOf(h.run());

        expect(h.s3.putKeys).toEqual([]);
        expect(h.s3.created).toBe(0);
    });

    it('upload_interrupted keeps the temp dir and the R2 objects and carries the resume data', async () => {
        const h = harness({
            s3: { failPut: (key) => (key.endsWith('segment_001.ts') ? networkError() : undefined) },
        });
        let beforeUpload: BeforeUploadInfo | null = null;

        useFakeClock(h);
        h.hooks.onBeforeUpload = async (info) => {
            beforeUpload = info;
        };

        const error = await failureOf(h.run());

        expect(error.kind).toBe('upload_interrupted');
        expect(error.step).toBe('uploading');
        expect(error.resumable).toBe(true);
        expect(error.prefix).toBe(PREFIX);
        expect(error.tmpDir).toBe(join(tmpRoot, PUBLIC_ID));
        expect(error.registerPayload).toEqual(
            (beforeUpload as BeforeUploadInfo | null)?.registerPayload,
        );
        expect(error.message).toBe(
            'Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.',
        );

        // Nothing deleted on R2 (segment_000 stays), and the temp dir is intact.
        expect(deletes(h)).toEqual([]);
        expect(h.s3.objects.has(`${PREFIX}segment_000.ts`)).toBe(true);
        expect(await exists(join(tmpRoot, PUBLIC_ID, 'playlist.m3u8'))).toBe(true);
        expect(await exists(join(tmpRoot, PUBLIC_ID, 'segment_001.ts'))).toBe(true);
        expect(h.register.payloads).toHaveLength(0);

        // The upload client is destroyed, no cleanup client was created.
        expect(h.s3.created).toBe(1);
        expect(h.s3.destroyed).toBe(1);
    });

    it('cancelling while waiting for the network is a plain cancel (R2 and temp dir removed)', async () => {
        const h = harness({ s3: { failPut: () => networkError() } });

        h.deps.sleep = async (ms, signal) => {
            h.sleeps.push(ms);
            h.controller.abort();
            void signal;
        };

        const error = await failureOf(h.run());

        expect(error.kind).toBe('cancelled');
        expect(error.resumable).toBe(false);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
        expect(h.s3.objects.size).toBe(0);
    });

    it('a non-network failure keeps cleaning up (403: 3 attempts, prefix and temp dir removed)', async () => {
        const h = harness({
            s3: {
                failPut: (key) =>
                    key.endsWith('segment_000.ts')
                        ? Object.assign(new Error('denied'), {
                              name: 'AccessDenied',
                              $metadata: { httpStatusCode: 403 },
                          })
                        : undefined,
            },
        });
        const error = await failureOf(h.run());

        expect(error.kind).toBe('failed');
        expect(error.resumable).toBe(false);
        expect(h.sleeps).toEqual([1000, 2000]);
        expect(await exists(join(tmpRoot, PUBLIC_ID))).toBe(false);
        expect(deletes(h).length).toBeGreaterThan(0);
    });
});
