/**
 * Integration tests: the REAL pipeline (real ffmpeg/ffprobe, real filesystem, real AWS SDK) against
 * an in-process fake S3 server and a fake register client. Skipped when ffmpeg is not available.
 */
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/appConfig';
import { resolveBinaries, type Binaries } from '../ffmpeg/binaries';
import { SOURCE_FORMAT_WHITELIST } from '../ffmpeg/args';
import { createRunner, runCollect, runProcess } from '../ffmpeg/runner';
import { checkFfmpeg, createFfmpegTextRunner } from '../ffmpeg/selfCheck';
import { createDefaultDeps } from './defaultDeps';
import type { PipelineDeps } from './deps';
import { PipelineError } from './errors';
import { RegisterRequestError } from './registerClient';
import { resumeUpload } from './resumeUpload';
import {
    retryRegister,
    runPipeline,
    type BeforeUploadInfo,
    type PipelineHooks,
} from './runPipeline';
import type { StepEnv } from './steps/env';
import { probeDuration, probeFps } from './steps/probe';
import { createR2Client } from './steps/s3Client';
import { transcodeToHls } from './steps/transcode';
import { FakeRegister, NOOP_LOGGER, makeTempDir, type RegisterBehavior } from './testing/fakes';
import { FakeS3Server, type FakeS3ServerOptions } from './testing/fakeS3Server';

const binaries: Binaries = resolveBinaries({
    platform: process.platform,
    resourcesPath: '',
    env: process.env,
    isPackaged: false,
});

function toolAvailable(command: string): boolean {
    const probe = spawnSync(command, ['-version'], { stdio: 'ignore' });

    return probe.status === 0;
}

const available = toolAvailable(binaries.ffmpeg) && toolAvailable(binaries.ffprobe);

if (!available) {
    console.warn(
        '[integration] SKIPPED: ffmpeg/ffprobe were not found via resolveBinaries ' +
            '(set FFMPEG_PATH / FFPROBE_PATH or put them on PATH).',
    );
}

const BUCKET = 'test-bucket';
const PUBLIC_ID = 'ab12cd34ef56';
const FIXED_NOW = new Date(Date.UTC(2026, 2, 5, 10, 0, 0));
const DATE_PREFIX = '2026/03/05/';

interface Sources {
    landscape: string;
    portrait: string;
    short: string;
    noAudio: string;
    long: string;
}

let workRoot: string;
let sources: Sources;

async function generate(
    file: string,
    options: { size: string; seconds: number; audio: boolean; preset?: string },
): Promise<void> {
    const args = [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${options.size}:rate=30:duration=${options.seconds}`,
    ];

    if (options.audio) {
        args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${options.seconds}`);
    }

    args.push('-c:v', 'libx264', '-preset', options.preset ?? 'ultrafast', '-pix_fmt', 'yuv420p');
    if (options.audio) args.push('-c:a', 'aac', '-shortest');
    args.push(file);

    const result = await runProcess({
        command: binaries.ffmpeg,
        args,
        timeoutMs: 120_000,
    });

    if (result.exitCode !== 0) {
        throw new Error(`Could not generate ${file}: ${result.stderrTail.slice(-5).join('\n')}`);
    }
}

beforeAll(async () => {
    if (!available) return;

    workRoot = await makeTempDir('pipeline-int');
    sources = {
        landscape: join(workRoot, 'Video Mẫu Tiếng Việt (1).mp4'),
        portrait: join(workRoot, 'Video Dọc Mẫu (2).mp4'),
        short: join(workRoot, 'Clip ngắn.mov'),
        noAudio: join(workRoot, 'Không có tiếng.mkv'),
        long: join(workRoot, 'long source for abort.mp4'),
    };

    await Promise.all([
        generate(sources.landscape, { size: '1280x720', seconds: 12, audio: true }),
        generate(sources.portrait, { size: '720x1280', seconds: 12, audio: true }),
        generate(sources.short, { size: '640x360', seconds: 1, audio: true }),
        generate(sources.noAudio, { size: '640x360', seconds: 6, audio: false }),
        generate(sources.long, { size: '1920x1080', seconds: 90, audio: false }),
    ]);
}, 180_000);

afterAll(async () => {
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

interface Env {
    server: FakeS3Server;
    tmpRoot: string;
    sleeps: number[];
    register: FakeRegister;
    deps: PipelineDeps;
    controller: AbortController;
    hooks: PipelineHooks;
    percents: number[];
    stages: string[];
}

const created: Env[] = [];

async function setup(
    options: {
        failWhen?: FakeS3ServerOptions['failWhen'];
        register?: RegisterBehavior;
    } = {},
): Promise<Env> {
    const server = new FakeS3Server({ bucket: BUCKET, failWhen: options.failWhen });

    await server.start();

    const tmpRoot = join(workRoot, `tmp-${created.length}`);

    await mkdir(tmpRoot, { recursive: true });

    const register = new FakeRegister(options.register);
    const sleeps: number[] = [];
    const base = createDefaultDeps({
        binaries,
        tmpRoot,
        register,
        logger: NOOP_LOGGER,
    });
    const deps: PipelineDeps = {
        ...base,
        now: () => FIXED_NOW,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
    };
    const controller = new AbortController();
    const percents: number[] = [];
    const stages: string[] = [];
    const env: Env = {
        server,
        tmpRoot,
        sleeps,
        register,
        deps,
        controller,
        percents,
        stages,
        hooks: {
            signal: controller.signal,
            onProgress: (p) => percents.push(p),
            onStage: (s) => stages.push(s),
        },
    };

    created.push(env);

    return env;
}

afterEach(async () => {
    while (created.length > 0) await created.pop()?.server.stop();
});

function config(server: FakeS3Server, over: Partial<AppConfig['transcode']> = {}): AppConfig {
    return {
        r2: {
            access_key_id: 'AKIAFAKEFAKEFAKE',
            secret_access_key: 'fake-secret-fake-secret',
            bucket: BUCKET,
            endpoint: server.endpoint,
            url: 'https://cdn.example.com',
        },
        transcode: { resolution: '720', segment_seconds: 6, fps: null, ...over },
    };
}

function job(file: string, name: string) {
    return { id: 'job', sourcePath: file, filename: name, publicId: PUBLIC_ID };
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

async function probeImage(path: string): Promise<{ width: number; height: number }> {
    const result = await runCollect({
        command: binaries.ffprobe,
        args: [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height',
            '-of',
            'json',
            path,
        ],
        timeoutMs: 30_000,
    });
    const stream = (
        JSON.parse(result.stdoutText) as { streams: { width: number; height: number }[] }
    ).streams[0];

    if (stream === undefined) throw new Error('No video stream');

    return stream;
}

async function savedObject(env: Env, key: string, name: string): Promise<string> {
    const data = env.server.objects.get(key);

    if (data === undefined) throw new Error(`Missing object ${key}`);

    const path = join(workRoot, name);

    await writeFile(path, data);

    return path;
}

function ffprobeProcesses(needle: string): number {
    const out = spawnSync('pgrep', ['-f', needle], { encoding: 'utf8' });

    return out.stdout.split('\n').filter((l) => l.trim() !== '').length;
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

const SUITE_NOTE = available
    ? ''
    : ' [SKIPPED: ffmpeg/ffprobe not found via resolveBinaries; set FFMPEG_PATH/FFPROBE_PATH]';

describe.skipIf(!available)(`pipeline integration (real ffmpeg, fake S3)${SUITE_NOTE}`, () => {
    beforeEach(() => {
        expect(created).toHaveLength(0);
    });

    it('passes the ffmpeg self check (spec 4.2) on this machine', async () => {
        const result = await checkFfmpeg(createFfmpegTextRunner(createRunner(), binaries.ffmpeg));

        expect(result.missing).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.version).not.toBeNull();
    });

    it('processes a landscape video end to end', async () => {
        const env = await setup();
        const result = await runPipeline({
            job: job(sources.landscape, 'Video Mẫu Tiếng Việt (1).mp4'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });
        const prefix = `${DATE_PREFIX}video-mau-tieng-viet-1-${PUBLIC_ID}/`;

        expect(result.prefix).toBe(prefix);

        // Keys and order.
        const puts = env.server.puts;
        const keys = puts.map((p) => p.key);

        expect(keys.every((k) => k.startsWith(prefix))).toBe(true);
        expect(keys.at(-1)).toBe(`${prefix}playlist.m3u8`);
        expect(new Set(keys).size).toBe(keys.length);

        const names = keys.map((k) => k.slice(prefix.length)).sort();
        const segments = names.filter((n) => /^segment_\d{3}\.ts$/.test(n));

        expect(segments.length).toBe(2);
        expect(names).toEqual(
            [
                ...segments,
                'playlist.m3u8',
                'storyboard_3x3.jpg',
                'storyboard_4x4.jpg',
                'storyboard_5x5.jpg',
                'thumbnail.jpg',
            ].sort(),
        );
        expect([...env.server.objects.keys()].sort()).toEqual([...keys].sort());

        // Headers.
        for (const put of puts) {
            const expected = put.key.endsWith('.m3u8')
                ? 'application/vnd.apple.mpegurl'
                : put.key.endsWith('.ts')
                  ? 'video/mp2t'
                  : 'image/jpeg';

            expect(put.headers['content-type']).toBe(expected);
            expect(put.headers['x-amz-acl']).toBeUndefined();
            expect(put.headers['cache-control']).toBeUndefined();
            expect(put.headers['content-length']).toBe(
                String(env.server.objects.get(put.key)?.length),
            );
            expect(put.bytes).toBeGreaterThan(0);
        }

        // Images.
        const thumb = await probeImage(
            await savedObject(env, `${prefix}thumbnail.jpg`, 'thumb-l.jpg'),
        );

        expect(thumb).toEqual({ width: 1080, height: 1080 });

        for (const [grid, size] of [
            ['3x3', 480],
            ['4x4', 640],
            ['5x5', 800],
        ] as const) {
            const image = await probeImage(
                await savedObject(env, `${prefix}storyboard_${grid}.jpg`, `sb-l-${grid}.jpg`),
            );

            expect(image).toEqual({ width: size, height: size });
        }

        // Playlist content references the uploaded segments.
        const playlist = env.server.objects.get(`${prefix}playlist.m3u8`)?.toString('utf8') ?? '';

        for (const segment of segments) expect(playlist).toContain(segment);

        // Register payload.
        expect(env.register.payloads).toHaveLength(1);

        const payload = env.register.payloads[0];

        expect(payload).toMatchObject({
            public_id: PUBLIC_ID,
            title: 'Video Mẫu Tiếng Việt (1)',
            original_filename: 'Video Mẫu Tiếng Việt (1).mp4',
            disk_prefix: prefix,
            playlist_path: `${prefix}playlist.m3u8`,
            thumbnail_path: `${prefix}thumbnail.jpg`,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            output_codec: 'h264',
            storyboards: {
                '3x3': { path: `${prefix}storyboard_3x3.jpg` },
                '4x4': { path: `${prefix}storyboard_4x4.jpg` },
                '5x5': { path: `${prefix}storyboard_5x5.jpg` },
            },
        });
        expect(payload?.duration).toBeGreaterThan(11.5);
        expect(payload?.duration).toBeLessThan(12.5);
        expect(payload?.output_bitrate_kbps).toBeGreaterThan(0);

        // Progress, stages, cleanup.
        expect(env.stages).toEqual([
            'transcoding',
            'thumbnail',
            'storyboard',
            'uploading',
            'registering',
        ]);
        expect([...env.percents].sort((a, b) => a - b)).toEqual(env.percents);
        expect(env.percents.at(-1)).toBe(100);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
        expect(env.server.requests.filter((r) => r.type === 'delete')).toHaveLength(0);
    }, 120_000);

    it('processes a portrait video (triple-column thumbnail) with a Vietnamese file name', async () => {
        const env = await setup();

        await runPipeline({
            job: job(sources.portrait, 'Video Dọc Mẫu (2).mp4'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });

        const prefix = `${DATE_PREFIX}video-doc-mau-2-${PUBLIC_ID}/`;
        const thumb = await probeImage(
            await savedObject(env, `${prefix}thumbnail.jpg`, 'thumb-p.jpg'),
        );

        expect(thumb).toEqual({ width: 1080, height: 1080 });
        expect(env.register.payloads[0]).toMatchObject({
            output_width: 720,
            output_height: 1280,
            disk_prefix: prefix,
        });
        expect(env.server.puts.at(-1)?.key).toBe(`${prefix}playlist.m3u8`);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
    }, 120_000);

    it('handles a 1 second clip (short thumbnail path)', async () => {
        const env = await setup();

        await runPipeline({
            job: job(sources.short, 'Clip ngắn.mov'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });

        const prefix = `${DATE_PREFIX}clip-ngan-${PUBLIC_ID}/`;
        const thumb = await probeImage(
            await savedObject(env, `${prefix}thumbnail.jpg`, 'thumb-s.jpg'),
        );

        // Short path: the frame is written as is (no smart crop to 1080x1080).
        expect(thumb).toEqual({ width: 640, height: 360 });
        expect(env.register.payloads[0]?.thumbnail_path).toBe(`${prefix}thumbnail.jpg`);
        expect(env.register.payloads[0]?.duration).toBeLessThan(1.5);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
    }, 120_000);

    it('handles a video without an audio track', async () => {
        const env = await setup();

        await runPipeline({
            job: job(sources.noAudio, 'Không có tiếng.mkv'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });

        const prefix = `${DATE_PREFIX}khong-co-tieng-${PUBLIC_ID}/`;

        expect(env.server.objects.has(`${prefix}playlist.m3u8`)).toBe(true);
        expect(env.register.payloads[0]).toMatchObject({ output_codec: 'h264' });
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
    }, 120_000);

    it('abort during the transcode kills ffmpeg and cleans the temp dir and R2', async () => {
        const env = await setup();
        let transcodeStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            transcodeStarted = resolve;
        });
        const baseRun = env.deps.run;

        env.deps.run = (input) => {
            if (input.args.at(-1) === 'playlist.m3u8') transcodeStarted();

            return baseRun(input);
        };

        const pending = runPipeline({
            job: job(sources.long, 'long source for abort.mp4'),
            config: config(env.server, { resolution: '1080' }),
            deps: env.deps,
            hooks: env.hooks,
        });
        const outcome = failureOf(pending);

        await started;
        await new Promise((r) => setTimeout(r, 800));

        if (process.platform !== 'win32') {
            expect(ffprobeProcesses('long source for abort')).toBeGreaterThan(0);
        }

        env.controller.abort();
        const error = await outcome;

        expect(error.kind).toBe('cancelled');
        expect(error.message).not.toContain(workRoot);

        if (process.platform !== 'win32') {
            expect(ffprobeProcesses('long source for abort')).toBe(0);
        }

        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
        expect(await readdir(env.tmpRoot)).toEqual([]);
        expect(env.server.objects.size).toBe(0);
        expect(env.server.puts).toHaveLength(0);
        expect(env.register.payloads).toHaveLength(0);
    }, 120_000);

    it('a persistent HTTP 403 on the 3rd uploaded file fails the job and cleans the prefix', async () => {
        const seen: string[] = [];
        const env = await setup({
            failWhen: (request) => {
                if (request.type !== 'put') return undefined;
                if (!seen.includes(request.key)) seen.push(request.key);

                return seen.indexOf(request.key) === 2 ? 403 : undefined;
            },
        });
        const error = await failureOf(
            runPipeline({
                job: job(sources.noAudio, 'Không có tiếng.mkv'),
                config: config(env.server),
                deps: env.deps,
                hooks: env.hooks,
            }),
        );
        const failedKey = seen[2] ?? '';

        expect(error).toMatchObject({ kind: 'failed', step: 'uploading' });
        // 3 attempts of ours (delays 1 s, 2 s). The SDK does not retry streamed bodies itself.
        expect(env.sleeps).toEqual([1000, 2000]);
        expect(env.server.puts.filter((p) => p.key === failedKey)).toHaveLength(3);
        expect(env.server.puts.some((p) => p.key.endsWith('playlist.m3u8'))).toBe(false);
        expect(env.server.requests.some((r) => r.type === 'delete')).toBe(true);
        expect(env.server.objects.size).toBe(0);
        expect(env.register.payloads).toHaveLength(0);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
    }, 120_000);

    it('recovers when an upload fails a few times and then succeeds', async () => {
        let failures = 0;
        const env = await setup({
            failWhen: (request) => {
                if (
                    request.type === 'put' &&
                    request.key.endsWith('segment_000.ts') &&
                    failures < 2
                ) {
                    failures++;

                    return 500;
                }

                return undefined;
            },
        });

        await runPipeline({
            job: job(sources.noAudio, 'Không có tiếng.mkv'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });

        expect(failures).toBe(2);
        expect(env.server.objects.size).toBeGreaterThan(5);
        expect(env.register.payloads).toHaveLength(1);
    }, 120_000);

    it('register failing 6 times keeps R2 and retryRegister succeeds without a new upload', async () => {
        const env = await setup({ register: () => new RegisterRequestError({ kind: 'network' }) });
        const error = await failureOf(
            runPipeline({
                job: job(sources.noAudio, 'Không có tiếng.mkv'),
                config: config(env.server),
                deps: env.deps,
                hooks: env.hooks,
            }),
        );

        expect(error.kind).toBe('register_failed');
        expect(env.register.payloads).toHaveLength(6);
        expect(env.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
        expect(env.server.requests.some((r) => r.type === 'delete')).toBe(false);
        expect(env.server.objects.size).toBeGreaterThan(5);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);

        const payload = error.registerPayload;

        expect(payload?.playlist_path).toMatch(/playlist\.m3u8$/);

        const putsBefore = env.server.puts.length;
        const second = new FakeRegister();

        env.deps.register = second;

        const result = await retryRegister({
            payload: payload as NonNullable<typeof payload>,
            deps: env.deps,
            hooks: env.hooks,
        });

        expect(result.registered.public_id).toBe(PUBLIC_ID);
        expect(second.payloads).toEqual([payload]);
        expect(env.server.puts).toHaveLength(putsBefore);
        expect(env.server.objects.has(payload?.playlist_path ?? '')).toBe(true);
    }, 120_000);
});

describe.skipIf(!available)(`network drops during the upload${SUITE_NOTE}`, () => {
    /** Counts every process the pipeline spawns, and the transcode runs among them. */
    function countProcesses(env: Env): {
        all: () => number;
        transcodes: () => number;
        reset: () => void;
    } {
        let all = 0;
        let transcodes = 0;
        const inner = env.deps.run;

        env.deps.run = (input) => {
            all++;
            if (input.args.at(-1) === 'playlist.m3u8') transcodes++;

            return inner(input);
        };

        return {
            all: () => all,
            transcodes: () => transcodes,
            reset: () => {
                all = 0;
                transcodes = 0;
            },
        };
    }

    /** A clock that only moves when the pipeline "sleeps", so a 30 minute outage is instant. */
    function fakeClock(env: Env): void {
        let now = 1_700_000_000_000;

        env.deps.sleep = async (ms) => {
            env.sleeps.push(ms);
            now += ms;
        };
        env.deps.uploadTuning = { now: () => now, jitter: () => 0 };
    }

    it('a transient outage (dropped sockets, then 503s) finishes the job without transcoding again', async () => {
        let puts = 0;
        const env = await setup({
            failWhen: (request) => {
                if (request.type !== 'put') return undefined;

                puts++;

                if (puts <= 4) return 'destroy';
                if (puts <= 7) return 503;

                return undefined;
            },
        });
        const counter = countProcesses(env);
        const waits: number[] = [];
        let restored = 0;

        fakeClock(env);
        env.hooks.onNetworkWait = (info) => waits.push(info.nextRetryInMs);
        env.hooks.onNetworkRestored = () => restored++;

        const result = await runPipeline({
            job: job(sources.noAudio, 'Không có tiếng.mkv'),
            config: config(env.server),
            deps: env.deps,
            hooks: env.hooks,
        });

        expect(result.registered.public_id).toBe(PUBLIC_ID);
        expect(counter.transcodes()).toBe(1);
        expect(env.sleeps.length).toBeGreaterThanOrEqual(7);
        expect(
            env.sleeps.every((ms) => [2000, 5000, 10000, 20000, 30000, 60000].includes(ms)),
        ).toBe(true);
        expect(waits.length).toBeGreaterThan(0);
        expect(restored).toBeGreaterThanOrEqual(1);
        expect(env.server.requests.some((r) => r.type === 'delete')).toBe(false);
        const names = [...env.server.objects.keys()].map((k) => k.slice(result.prefix.length));

        expect(names).toEqual(
            expect.arrayContaining(['playlist.m3u8', 'thumbnail.jpg', 'storyboard_3x3.jpg']),
        );
        expect(env.register.payloads).toEqual([result.payload]);
        expect(await exists(join(env.tmpRoot, PUBLIC_ID))).toBe(false);
    }, 120_000);

    it('a permanent outage is upload_interrupted; resumeUpload then finishes with zero ffmpeg runs', async () => {
        let outage = true;
        let puts = 0;
        const env = await setup({
            failWhen: (request) => {
                if (request.type !== 'put' || !outage) return undefined;

                // The first 3 files get through, then the connection dies for good.
                return ++puts <= 3 ? undefined : 'destroy';
            },
        });
        const counter = countProcesses(env);
        let beforeUpload: BeforeUploadInfo | null = null;

        fakeClock(env);
        env.hooks.onBeforeUpload = async (info) => {
            beforeUpload = info;
        };

        const error = await failureOf(
            runPipeline({
                job: job(sources.noAudio, 'Không có tiếng.mkv'),
                config: config(env.server),
                deps: env.deps,
                hooks: env.hooks,
            }),
        );
        const tmpDir = join(env.tmpRoot, PUBLIC_ID);

        expect(error.kind).toBe('upload_interrupted');
        expect(error.resumable).toBe(true);
        expect(error.tmpDir).toBe(tmpDir);
        expect(error.registerPayload).toEqual(
            (beforeUpload as BeforeUploadInfo | null)?.registerPayload,
        );
        expect(counter.transcodes()).toBe(1);
        expect(env.server.objects.size).toBe(3);
        expect(env.server.requests.some((r) => r.type === 'delete')).toBe(false);
        expect(await exists(join(tmpDir, 'playlist.m3u8'))).toBe(true);
        expect(env.register.payloads).toHaveLength(0);

        // The network is back.
        outage = false;
        counter.reset();

        const uploaded = new Set(env.server.objects.keys());
        const putsBefore = env.server.puts.length;
        const payload = error.registerPayload as NonNullable<typeof error.registerPayload>;
        const stages: string[] = [];
        const result = await resumeUpload({
            job: job(sources.noAudio, 'Không có tiếng.mkv'),
            payload,
            tmpDir,
            config: config(env.server),
            deps: env.deps,
            hooks: { ...env.hooks, onStage: (s) => stages.push(s) },
        });
        const resumedPuts = env.server.puts.slice(putsBefore).map((p) => p.key);

        expect(counter.all()).toBe(0);
        expect(counter.transcodes()).toBe(0);
        expect(resumedPuts.every((key) => !uploaded.has(key))).toBe(true);
        expect(resumedPuts.at(-1)).toBe(payload.playlist_path);
        expect(new Set([...uploaded, ...resumedPuts])).toEqual(new Set(env.server.objects.keys()));
        expect(env.server.objects.has(payload.playlist_path)).toBe(true);
        expect(env.server.objects.has(payload.thumbnail_path ?? '')).toBe(true);
        expect(stages).toEqual(['uploading', 'registering']);
        expect(result.registered.public_id).toBe(PUBLIC_ID);
        expect(env.register.payloads).toEqual([payload]);
        expect(await exists(tmpDir)).toBe(false);
    }, 120_000);
});

// Exercise createR2Client directly so a config mistake shows up even without a full run.
describe.skipIf(!available)(`createR2Client${SUITE_NOTE}`, () => {
    it('talks path-style to a custom endpoint', async () => {
        const server = new FakeS3Server({ bucket: BUCKET });

        await server.start();

        try {
            const { PutObjectCommand } = await import('@aws-sdk/client-s3');
            const client = createR2Client(config(server).r2);

            await client.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: 'a/b.txt',
                    Body: 'hello',
                    ContentType: 'text/plain',
                }),
            );

            expect(server.objects.get('a/b.txt')?.toString()).toBe('hello');
            expect(server.requests[0]?.headers['content-type']).toBe('text/plain');
        } finally {
            await server.stop();
        }
    });
});

// The demuxer allow-list (-format_whitelist) must not break any accepted container.
describe.skipIf(!available)(`source demuxer allow-list${SUITE_NOTE}`, () => {
    const CODECS: Record<string, string[]> = {
        mp4: ['-c:v', 'libx264', '-c:a', 'aac'],
        mov: ['-c:v', 'libx264', '-c:a', 'aac'],
        mkv: ['-c:v', 'libx264', '-c:a', 'aac'],
        avi: ['-c:v', 'libx264', '-c:a', 'aac'],
        webm: ['-c:v', 'libvpx', '-c:a', 'libopus'],
    };
    let dir: string;

    beforeAll(async () => {
        dir = join(workRoot, 'allow-list');
        await mkdir(dir, { recursive: true });
    });

    async function makeSample(extension: string): Promise<string> {
        const file = join(dir, `sample.${extension}`);
        const codecs = CODECS[extension] ?? [];
        const base = [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=160x90:rate=15:duration=2',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=2',
            '-pix_fmt',
            'yuv420p',
        ];
        let result = await runProcess({
            command: binaries.ffmpeg,
            args: [...base, ...codecs, '-shortest', file],
            timeoutMs: 60_000,
        });

        if (result.exitCode !== 0 && extension === 'webm') {
            // Fall back to a video-only VP8 file when the Opus encoder is not built in.
            result = await runProcess({
                command: binaries.ffmpeg,
                args: [...base.slice(0, 5), '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', file],
                timeoutMs: 60_000,
            });
        }

        if (result.exitCode !== 0) {
            throw new Error(
                `Could not generate ${file}: ${result.stderrTail.slice(-5).join('\n')}`,
            );
        }

        return file;
    }

    function stepEnv(cwd: string): StepEnv {
        return {
            run: createRunner(),
            ffmpeg: binaries.ffmpeg,
            ffprobe: binaries.ffprobe,
            cwd,
            signal: new AbortController().signal,
            logger: NOOP_LOGGER,
            step: 'transcoding',
        };
    }

    it.each(['mp4', 'mov', 'mkv', 'avi', 'webm'])(
        'probes and transcodes a .%s file with the whitelist active',
        async (extension) => {
            const sample = await makeSample(extension);
            const cwd = join(dir, `out-${extension}`);

            await mkdir(cwd, { recursive: true });

            const env = stepEnv(cwd);
            const duration = await probeDuration(env, sample);
            const fps = await probeFps(env, sample);

            expect(duration).toBeGreaterThan(0.5);
            expect(fps).toBeGreaterThan(0);

            await transcodeToHls(env, {
                input: sample,
                transcode: { resolution: '480', segment_seconds: 2, fps: null },
                duration,
                outputFps: fps,
                onFraction: () => undefined,
            });

            expect((await readdir(cwd)).sort()).toContain('playlist.m3u8');
            expect(await readdir(cwd)).toContain('segment_000.ts');
        },
        60_000,
    );

    it('fails to probe an HLS playlist disguised as evil.mp4', async () => {
        const evil = join(dir, 'evil.mp4');

        await writeFile(
            evil,
            '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n',
        );

        await expect(probeDuration(stepEnv(dir), evil)).rejects.toBeInstanceOf(PipelineError);
    }, 30_000);

    it('the whitelist itself rejects the hls demuxer (and its absence would not)', async () => {
        const sample = await makeSample('mp4');
        const hlsDir = join(dir, 'real-hls');

        await mkdir(hlsDir, { recursive: true });

        const made = await runCollect({
            command: binaries.ffmpeg,
            args: ['-y', '-i', sample, '-c', 'copy', '-f', 'hls', join(hlsDir, 'p.m3u8')],
            timeoutMs: 30_000,
        });

        expect(made.exitCode).toBe(0);

        const playlist = join(hlsDir, 'p.m3u8');

        const withList = await runCollect({
            command: binaries.ffprobe,
            args: ['-v', 'error', '-format_whitelist', SOURCE_FORMAT_WHITELIST, playlist],
            timeoutMs: 30_000,
        });
        const without = await runCollect({
            command: binaries.ffprobe,
            args: ['-v', 'error', playlist],
            timeoutMs: 30_000,
        });

        expect(withList.exitCode).not.toBe(0);
        expect(without.exitCode).toBe(0);
    }, 30_000);
});
