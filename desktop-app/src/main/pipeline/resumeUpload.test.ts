import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigR2 } from '../../shared/appConfig';
import { PipelineError } from './errors';
import { buildRegisterPayload, type RegisterPayload } from './register';
import { RegisterRequestError } from './registerClient';
import { resumeUpload, parsePlaylistSegments, type ResumeUploadHooks } from './resumeUpload';
import type { PipelineStep } from './runPipeline';
import type { S3ClientPurpose } from './steps/s3Client';
import {
    FakeRegister,
    FakeS3,
    TEST_CONFIG,
    createFakeRunner,
    makeTempDir,
    makeTestDeps,
    type FakeS3Options,
    type RegisterBehavior,
} from './testing/fakes';

const PUBLIC_ID = 'ab12cd34ef56';
const PREFIX = `2026/03/05/clip-${PUBLIC_ID}/`;
const SEGMENTS = ['segment_000.ts', 'segment_001.ts', 'segment_002.ts'];
const PLAYLIST_TEXT = `#EXTM3U\n#EXT-X-VERSION:3\n${SEGMENTS.map((s) => `#EXTINF:6.0,\n${s}`).join('\n')}\n#EXT-X-ENDLIST\n`;
/** Every file of the video with its local size. */
const SIZES: Record<string, number> = {
    'segment_000.ts': 100,
    'segment_001.ts': 101,
    'segment_002.ts': 102,
    'thumbnail.jpg': 20,
    'storyboard_3x3.jpg': 30,
    'storyboard_5x5.jpg': 50,
    'playlist.m3u8': PLAYLIST_TEXT.length,
};

let root: string;
let tmpRoot: string;
let tmpDir: string;

beforeEach(async () => {
    root = await makeTempDir('resume');
    tmpRoot = join(root, 'tmp');
    tmpDir = join(tmpRoot, PUBLIC_ID);
    await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function writeVideoFiles(): Promise<void> {
    for (const [name, size] of Object.entries(SIZES)) {
        await writeFile(
            join(tmpDir, name),
            name === 'playlist.m3u8' ? PLAYLIST_TEXT : Buffer.alloc(size),
        );
    }
}

function payload(): RegisterPayload {
    return buildRegisterPayload({
        publicId: PUBLIC_ID,
        prefix: PREFIX,
        originalFilename: 'clip.mp4',
        originalSizeBytes: 5000,
        duration: 12,
        hasThumbnail: true,
        storyboardGrids: [3, 5],
        output: { width: 1280, height: 720, fps: 30, bitrateKbps: 1500, codec: 'h264' },
    });
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

interface Rig {
    s3: FakeS3;
    register: FakeRegister;
    runner: ReturnType<typeof createFakeRunner>;
    controller: AbortController;
    stages: PipelineStep[];
    percents: number[];
    sleeps: number[];
    purposes: (S3ClientPurpose | undefined)[];
    clients: { created: number };
    hooks: ResumeUploadHooks;
    deps: ReturnType<typeof makeTestDeps>;
    run: (over?: { payload?: RegisterPayload; tmpDir?: string }) => ReturnType<typeof resumeUpload>;
}

function rig(
    options: {
        s3?: FakeS3Options;
        register?: RegisterBehavior;
        remote?: Record<string, number>;
    } = {},
): Rig {
    const sleeps: number[] = [];
    const stages: PipelineStep[] = [];
    const percents: number[] = [];
    const purposes: (S3ClientPurpose | undefined)[] = [];
    const controller = new AbortController();
    const runner = createFakeRunner();
    const s3 = new FakeS3(options.s3);
    const register = new FakeRegister(options.register);
    const deps = makeTestDeps({ runner, s3, register, tmpRoot, sleeps });

    for (const [name, size] of Object.entries(options.remote ?? {})) {
        s3.objects.set(PREFIX + name, size);
    }

    deps.createS3Client = (_r2: AppConfigR2, purpose?: S3ClientPurpose) => {
        purposes.push(purpose);

        return s3.asClient();
    };

    const hooks: ResumeUploadHooks = {
        onStage: (s) => stages.push(s as PipelineStep),
        onProgress: (p) => percents.push(p),
        signal: controller.signal,
    };

    return {
        s3,
        register,
        runner,
        controller,
        stages,
        percents,
        sleeps,
        purposes,
        clients: { created: 0 },
        hooks,
        deps,
        run: (over = {}) =>
            resumeUpload({
                job: { id: 'job-1', publicId: PUBLIC_ID },
                payload: over.payload ?? payload(),
                tmpDir: over.tmpDir ?? tmpDir,
                config: TEST_CONFIG,
                deps,
                hooks,
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

    throw new Error('Expected resumeUpload to fail.');
}

function putNames(r: Rig): string[] {
    return r.s3.putKeys.map((k) => k.slice(PREFIX.length));
}

function networkError(): Error {
    return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

function useFakeClock(r: Rig): void {
    const clock = { now: 1_700_000_000_000 };

    r.deps.sleep = async (ms) => {
        r.sleeps.push(ms);
        clock.now += ms;
    };
    r.deps.uploadTuning = { now: () => clock.now, jitter: () => 0 };
}

describe('parsePlaylistSegments', () => {
    it('returns the .ts lines and ignores tags and blank lines', () => {
        expect(parsePlaylistSegments(PLAYLIST_TEXT)).toEqual(SEGMENTS);
        expect(parsePlaylistSegments('#EXTM3U\r\nsegment_000.ts\r\n\r\n')).toEqual([
            'segment_000.ts',
        ]);
        expect(parsePlaylistSegments('#EXTM3U\n#EXT-X-ENDLIST\n')).toEqual([]);
    });
});

describe('resumeUpload: local files are gone', () => {
    async function expectUnavailable(r: Rig, over?: Parameters<Rig['run']>[0]): Promise<void> {
        const error = await failureOf(r.run(over));

        expect(error.kind).toBe('failed');
        expect(error.code).toBe('resume_unavailable');
        expect(error.message).toBe(
            'The temporary files for this video are gone, so it cannot be resumed. Retry to process it again.',
        );
        // Nothing was touched: no S3 client at all, no register call, no process.
        expect(r.s3.created).toBe(0);
        expect(r.s3.requests).toEqual([]);
        expect(r.register.payloads).toEqual([]);
        expect(r.runner.calls).toHaveLength(0);
    }

    it.each(['segment_001.ts', 'thumbnail.jpg', 'storyboard_5x5.jpg', 'playlist.m3u8'])(
        'reports resume_unavailable when %s is missing and deletes nothing',
        async (name) => {
            await writeVideoFiles();
            await rm(join(tmpDir, name));

            const r = rig({ remote: { 'segment_000.ts': 100 } });

            await expectUnavailable(r);
            expect(await exists(tmpDir)).toBe(true);
            expect(await exists(join(tmpDir, 'segment_000.ts'))).toBe(true);
            expect(r.s3.objects.size).toBe(1);
        },
    );

    it('reports resume_unavailable when the temp dir does not exist', async () => {
        await rm(tmpDir, { recursive: true, force: true });
        await expectUnavailable(rig());
    });

    it('reports resume_unavailable when a segment is a directory', async () => {
        await writeVideoFiles();
        await rm(join(tmpDir, 'segment_002.ts'));
        await mkdir(join(tmpDir, 'segment_002.ts'));
        await expectUnavailable(rig());
    });

    it('refuses a temp dir that is not <tmpRoot>/<publicId> (it would be deleted on success)', async () => {
        const elsewhere = join(root, 'elsewhere');

        await mkdir(elsewhere);
        tmpDir = elsewhere;
        await writeVideoFiles();
        tmpDir = join(tmpRoot, PUBLIC_ID);

        await expectUnavailable(rig(), { tmpDir: elsewhere });
        expect(await exists(join(elsewhere, 'playlist.m3u8'))).toBe(true);
    });

    it('rejects an invalid stored payload without touching anything', async () => {
        await writeVideoFiles();

        const r = rig();
        const error = await failureOf(r.run({ payload: { ...payload(), title: '' } }));

        expect(error.kind).toBe('failed');
        expect(error.code).toBeNull();
        expect(r.s3.requests).toEqual([]);
        expect(await exists(tmpDir)).toBe(true);
    });
});

describe('resumeUpload: uploading the rest', () => {
    it('skips same-size objects, re-uploads size mismatches, uploads the playlist last and registers', async () => {
        await writeVideoFiles();

        const r = rig({
            remote: {
                'segment_000.ts': 100, // same size: skipped
                'segment_001.ts': 7, // different size: re-uploaded
                'thumbnail.jpg': 20, // skipped
                'playlist.m3u8': SIZES['playlist.m3u8'] ?? 0, // same size, but still re-uploaded last
            },
        });
        const result = await r.run();

        expect([...putNames(r)].sort()).toEqual(
            [
                'playlist.m3u8',
                'segment_001.ts',
                'segment_002.ts',
                'storyboard_3x3.jpg',
                'storyboard_5x5.jpg',
            ].sort(),
        );
        expect(putNames(r).at(-1)).toBe('playlist.m3u8');
        expect(r.s3.objects.get(`${PREFIX}segment_001.ts`)).toBe(101);

        expect(result.kind).toBe('done');
        expect(result.prefix).toBe(PREFIX);
        expect(result.payload).toEqual(payload());
        expect(r.register.payloads).toEqual([payload()]);

        // No ffmpeg / ffprobe.
        expect(r.runner.calls).toHaveLength(0);
        // Listing uses the cleanup client settings.
        expect(r.purposes[0]).toBe('cleanup');
        expect(r.stages).toEqual(['uploading', 'registering']);
        expect(r.percents.at(-1)).toBe(100);
        expect([...r.percents].sort((a, b) => a - b)).toEqual(r.percents);
        // Temp dir removed on success; R2 untouched.
        expect(await exists(tmpDir)).toBe(false);
        expect(r.s3.requests.some((q) => q.type === 'delete')).toBe(false);
        expect(r.s3.destroyed).toBe(r.s3.created);
    });

    it('uploads only the playlist when everything else is already on R2', async () => {
        await writeVideoFiles();

        const r = rig({ remote: { ...SIZES } });

        await r.run();

        expect(putNames(r)).toEqual(['playlist.m3u8']);
        expect(r.register.payloads).toHaveLength(1);
    });

    it('reads every page of the remote listing', async () => {
        await writeVideoFiles();

        const r = rig({ s3: { listPageSize: 2 }, remote: { ...SIZES } });

        await r.run();

        expect(r.s3.requests.filter((q) => q.type === 'list')).toHaveLength(4);
        expect(putNames(r)).toEqual(['playlist.m3u8']);
    });

    it('uploads everything when nothing is on R2 yet', async () => {
        await writeVideoFiles();

        const r = rig();

        await r.run();

        expect(putNames(r)).toHaveLength(Object.keys(SIZES).length);
        expect(putNames(r).at(-1)).toBe('playlist.m3u8');
    });

    it('does not upload leftovers of the temp dir that the playlist does not reference', async () => {
        await writeVideoFiles();
        await writeFile(join(tmpDir, 'segment_009.ts'), Buffer.alloc(5));

        const r = rig({ remote: { ...SIZES } });

        await r.run();

        expect(putNames(r)).toEqual(['playlist.m3u8']);
    });
});

describe('resumeUpload: failures', () => {
    it('a second network outage keeps the temp dir and the R2 objects (upload_interrupted again)', async () => {
        await writeVideoFiles();

        const r = rig({
            remote: { 'segment_000.ts': 100 },
            s3: { failPut: (key) => (key.endsWith('segment_002.ts') ? networkError() : undefined) },
        });

        useFakeClock(r);

        const error = await failureOf(r.run());

        expect(error.kind).toBe('upload_interrupted');
        expect(error.resumable).toBe(true);
        expect(error.tmpDir).toBe(tmpDir);
        expect(error.registerPayload).toEqual(payload());
        expect(error.prefix).toBe(PREFIX);
        expect(await exists(join(tmpDir, 'playlist.m3u8'))).toBe(true);
        expect(r.s3.requests.some((q) => q.type === 'delete')).toBe(false);
        expect(r.s3.objects.has(`${PREFIX}segment_000.ts`)).toBe(true);
        expect(r.register.payloads).toEqual([]);
        expect(r.runner.calls).toHaveLength(0);
        expect(r.s3.destroyed).toBe(r.s3.created);
    });

    it('still being offline while listing is upload_interrupted too and keeps everything', async () => {
        await writeVideoFiles();

        const r = rig({ s3: { failList: () => networkError() } });
        const error = await failureOf(r.run());

        expect(error.kind).toBe('upload_interrupted');
        expect(await exists(tmpDir)).toBe(true);
        expect(r.s3.requests.some((q) => q.type === 'delete')).toBe(false);
    });

    it('a non-network upload error deletes the R2 prefix and the temp dir like runPipeline', async () => {
        await writeVideoFiles();

        const r = rig({
            remote: { 'segment_000.ts': 100 },
            s3: {
                failPut: (key) =>
                    key.endsWith('segment_001.ts')
                        ? Object.assign(new Error('denied'), {
                              name: 'AccessDenied',
                              $metadata: { httpStatusCode: 403 },
                          })
                        : undefined,
            },
        });
        const error = await failureOf(r.run());

        expect(error.kind).toBe('failed');
        expect(error.resumable).toBe(false);
        expect(r.s3.putKeys.filter((k) => k.endsWith('segment_001.ts'))).toHaveLength(3);
        expect(r.s3.objects.size).toBe(0);
        expect(await exists(tmpDir)).toBe(false);
    });

    it('a cancel deletes the R2 prefix and the temp dir', async () => {
        await writeVideoFiles();

        const r = rig({ remote: { 'segment_000.ts': 100 }, s3: { blockPut: () => true } });
        const promise = r.run();

        await new Promise((resolve) => setTimeout(resolve, 30));
        r.controller.abort();

        const error = await failureOf(promise);

        expect(error.kind).toBe('cancelled');
        expect(r.s3.objects.size).toBe(0);
        expect(await exists(tmpDir)).toBe(false);
        expect(r.register.payloads).toEqual([]);
    });

    it('HTTP 401 at register gives needs_sign_in: payload kept, R2 kept, temp dir removed', async () => {
        await writeVideoFiles();

        const r = rig({
            register: () => new RegisterRequestError({ kind: 'http', status: 401 }),
        });
        const error = await failureOf(r.run());

        expect(error.kind).toBe('needs_sign_in');
        expect(error.registerPayload).toEqual(payload());
        expect(r.register.payloads).toHaveLength(1);
        expect(r.s3.objects.size).toBe(Object.keys(SIZES).length);
        expect(r.s3.requests.some((q) => q.type === 'delete')).toBe(false);
        expect(await exists(tmpDir)).toBe(false);
        expect(r.stages).toEqual(['uploading', 'registering']);
    });

    it('a definitive register rejection deletes the R2 prefix', async () => {
        await writeVideoFiles();

        const r = rig({
            remote: { 'segment_000.ts': 100 },
            register: () =>
                new RegisterRequestError({
                    kind: 'http',
                    status: 409,
                    errorCode: 'public_id_conflict',
                }),
        });
        const error = await failureOf(r.run());

        expect(error.kind).toBe('failed');
        expect(error.definitive).toBe(true);
        expect(r.s3.objects.size).toBe(0);
        expect(await exists(tmpDir)).toBe(false);
    });

    it('register failing repeatedly keeps R2 and the payload (register_failed)', async () => {
        await writeVideoFiles();

        const r = rig({ register: () => new RegisterRequestError({ kind: 'network' }) });
        const error = await failureOf(r.run());

        expect(error.kind).toBe('register_failed');
        expect(error.registerPayload).toEqual(payload());
        expect(r.register.payloads).toHaveLength(6);
        expect(r.s3.objects.size).toBe(Object.keys(SIZES).length);
    });

    it('awaits onBeforeRegister after the registering stage and before the first request', async () => {
        await writeVideoFiles();

        const r = rig();
        const order: string[] = [];

        r.hooks.onStage = (s) => order.push(`stage:${s}`);
        r.hooks.onBeforeRegister = async () => {
            order.push(`before-register:${r.register.payloads.length}`);
        };
        await r.run();

        expect(order).toEqual(['stage:uploading', 'stage:registering', 'before-register:0']);
    });

    it('fires the network hooks while waiting', async () => {
        await writeVideoFiles();

        const r = rig({
            s3: {
                failPut: (key, attempt) =>
                    key.endsWith('segment_000.ts') && attempt <= 2 ? networkError() : undefined,
            },
        });
        const calls: string[] = [];

        useFakeClock(r);
        r.hooks.onNetworkWait = (info) => calls.push(`wait:${info.nextRetryInMs}`);
        r.hooks.onNetworkRestored = () => calls.push('restored');
        await r.run();

        expect(calls[0]).toBe('wait:2000');
        expect(calls).toContain('restored');
    });
});
