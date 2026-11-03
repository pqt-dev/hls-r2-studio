/** Test doubles for the pipeline (fake ffmpeg runner, fake S3 client, fake register client). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../../shared/appConfig';
import type { RunProcessInput, RunResult } from '../../ffmpeg/runner';
import type { Logger } from '../../logger';
import type { PipelineDeps, RegisterClient, RegisteredVideo } from '../deps';
import type { RegisterPayload } from '../register';
import { RegisterRequestError } from '../registerClient';

export const NOOP_LOGGER: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

export const TEST_CONFIG: AppConfig = {
    r2: {
        access_key_id: 'AKIAFAKEFAKEFAKE',
        secret_access_key: 'fake-secret-fake-secret',
        bucket: 'test-bucket',
        endpoint: 'http://127.0.0.1:9',
        url: 'https://cdn.example.com',
    },
    transcode: { resolution: '720', segment_seconds: 6, fps: null },
};

export type CallKind =
    | 'probe-duration'
    | 'probe-fps'
    | 'probe-output'
    | 'transcode'
    | 'thumb-frame'
    | 'measure-saturation'
    | 'measure-detail'
    | 'crop-scale'
    | 'crop'
    | 'hstack'
    | 'sb-candidates'
    | 'sb-tile'
    | 'unknown';

export interface FakeCall {
    kind: CallKind;
    command: string;
    args: readonly string[];
    cwd: string | undefined;
}

export function classify(command: string, args: readonly string[]): CallKind {
    const has = (text: string): boolean => args.some((a) => a.includes(text));
    const starts = (text: string): boolean => args.some((a) => a.startsWith(text));

    if (command.includes('ffprobe')) {
        if (has('format=duration')) return 'probe-duration';
        if (has('stream=width,height,r_frame_rate')) return 'probe-output';
        if (has('stream=r_frame_rate')) return 'probe-fps';
        if (starts('movie=')) return has('edgedetect') ? 'measure-detail' : 'measure-saturation';

        return 'unknown';
    }

    if (args.at(-1) === 'playlist.m3u8') return 'transcode';
    if (has('thumbnail=24')) return 'thumb-frame';
    if (starts('scale=') && has('force_original_aspect_ratio')) return 'crop-scale';
    if (starts('crop=')) return 'crop';
    if (has('hstack=inputs=3')) return 'hstack';
    if (starts('fps=75/')) return 'sb-candidates';
    if (starts('tile=')) return 'sb-tile';

    return 'unknown';
}

/** Minimal JPEG header (SOI + SOF0) that `jpegSize` can read. */
export function fakeJpeg(width: number, height: number): Buffer {
    return Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        height >> 8,
        height & 255,
        width >> 8,
        width & 255,
        0x03,
        0x01,
        0x22,
        0x00,
        0x02,
        0x11,
        0x01,
        0x03,
        0x11,
        0x01,
        0xff,
        0xd9,
    ]);
}

export interface FakeRunnerOptions {
    duration?: number | string;
    fps?: string;
    outputWidth?: number;
    outputHeight?: number;
    saturation?: (call: FakeCall) => string;
    detail?: (call: FakeCall) => string;
    /** Return a result to replace the default behavior of a call (e.g. a failure). */
    override?: (call: FakeCall) => Partial<RunResult> | undefined;
    /** Return true to keep the call "running" until its abort signal fires. */
    blockOn?: (call: FakeCall) => boolean;
    onCall?: (call: FakeCall) => void;
}

function result(partial: Partial<RunResult> = {}): RunResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stderrTail: [],
        ...partial,
    };
}

export function createFakeRunner(options: FakeRunnerOptions = {}): {
    run: (input: RunProcessInput) => Promise<RunResult>;
    calls: FakeCall[];
} {
    const calls: FakeCall[] = [];
    const outW = options.outputWidth ?? 1280;
    const outH = options.outputHeight ?? 720;

    async function run(input: RunProcessInput): Promise<RunResult> {
        const call: FakeCall = {
            kind: classify(input.command, input.args),
            command: input.command,
            args: input.args,
            cwd: input.cwd,
        };

        calls.push(call);
        options.onCall?.(call);

        if (options.blockOn?.(call)) {
            await new Promise<void>((resolve) => {
                if (input.signal?.aborted) resolve();
                input.signal?.addEventListener('abort', () => resolve(), { once: true });
            });

            return result({ exitCode: null, aborted: true });
        }

        const overridden = options.override?.(call);
        if (overridden !== undefined) return result(overridden);

        const cwd = input.cwd ?? '.';
        const last = input.args.at(-1) ?? '';
        const out = (text: string): RunResult => result({ stdoutText: text });

        switch (call.kind) {
            case 'probe-duration':
                return out(`${options.duration ?? 12}\n`);
            case 'probe-fps':
                return out(`${options.fps ?? '30/1'}\n`);
            case 'probe-output':
                return out(
                    JSON.stringify({
                        streams: [
                            {
                                codec_name: 'h264',
                                width: outW,
                                height: outH,
                                r_frame_rate: '30/1',
                                bit_rate: '1500000',
                            },
                        ],
                    }),
                );
            case 'measure-saturation':
                return out(`${options.saturation?.(call) ?? '40'}\n`);
            case 'measure-detail':
                return out(`${options.detail?.(call) ?? '20'}\n`);
            case 'transcode':
                input.onStdout?.('out_time_us=3000000\nprogress=continue\n');
                await writeFile(join(cwd, 'playlist.m3u8'), '#EXTM3U\n');
                await writeFile(join(cwd, 'segment_000.ts'), Buffer.alloc(100));
                await writeFile(join(cwd, 'segment_001.ts'), Buffer.alloc(100));
                input.onStdout?.('out_time_us=12000000\nprogress=end\n');

                return result();
            case 'thumb-frame':
            case 'crop':
            case 'hstack':
                await writeFile(join(cwd, last), fakeJpeg(outW, outH));

                return result();
            case 'crop-scale':
                await writeFile(join(cwd, last), fakeJpeg(1920, 1080));

                return result();
            case 'sb-candidates':
                for (let i = 0; i < 75; i++) {
                    await writeFile(
                        join(cwd, `candidate_${String(i).padStart(4, '0')}.jpg`),
                        fakeJpeg(160, 160),
                    );
                }

                return result();
            case 'sb-tile':
                await writeFile(join(cwd, last), fakeJpeg(480, 480));

                return result();
            default:
                return result({ exitCode: 1 });
        }
    }

    return { run, calls };
}

export interface S3Request {
    type: 'put' | 'list' | 'delete';
    keys: string[];
    contentType?: string;
}

export interface FakeS3Options {
    /** Called for each PutObject; return an Error to fail that attempt. */
    failPut?: (key: string, attempt: number) => Error | undefined;
    /** Block the PutObject (until its abort signal fires) when this returns true. */
    blockPut?: (key: string) => boolean;
}

/** Records PutObject / ListObjectsV2 / DeleteObjects calls; keeps the stored keys in memory. */
export class FakeS3 {
    readonly requests: S3Request[] = [];
    readonly objects = new Map<string, number>();
    /** Number of clients created by `asClient()` that were destroyed. */
    destroyed = 0;
    /** Number of `asClient()` calls. */
    created = 0;
    private readonly attempts = new Map<string, number>();

    constructor(private readonly options: FakeS3Options = {}) {}

    get putKeys(): string[] {
        return this.requests.filter((r) => r.type === 'put').flatMap((r) => r.keys);
    }

    asClient(): S3Client {
        this.created++;
        const send = async (
            command: { constructor: { name: string }; input: Record<string, unknown> },
            sendOptions?: { abortSignal?: AbortSignal },
        ): Promise<unknown> => {
            const name = command.constructor.name;
            const input = command.input;

            if (name === 'PutObjectCommand') {
                const key = String(input['Key']);
                const body = input['Body'] as { destroy?: () => void } | undefined;
                const attempt = (this.attempts.get(key) ?? 0) + 1;

                this.attempts.set(key, attempt);
                this.requests.push({
                    type: 'put',
                    keys: [key],
                    contentType: String(input['ContentType']),
                });
                body?.destroy?.();

                if (this.options.blockPut?.(key)) {
                    await new Promise<void>((_resolve, reject) => {
                        const signal = sendOptions?.abortSignal;
                        const abort = (): void => reject(new Error('AbortError'));
                        if (signal?.aborted) abort();
                        signal?.addEventListener('abort', abort, { once: true });
                    });
                }

                const failure = this.options.failPut?.(key, attempt);
                if (failure) throw failure;

                this.objects.set(key, Number(input['ContentLength'] ?? 0));

                return {};
            }

            if (name === 'ListObjectsV2Command') {
                const prefix = String(input['Prefix']);
                const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
                this.requests.push({ type: 'list', keys });

                return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
            }

            if (name === 'DeleteObjectsCommand') {
                const objects = (input['Delete'] as { Objects: { Key: string }[] }).Objects;
                const keys = objects.map((o) => o.Key);
                this.requests.push({ type: 'delete', keys });
                for (const key of keys) this.objects.delete(key);

                return {};
            }

            throw new Error(`Unexpected S3 command ${name}`);
        };

        const destroy = (): void => {
            this.destroyed++;
        };

        return { send, destroy } as unknown as S3Client;
    }
}

export type RegisterBehavior = (
    payload: RegisterPayload,
    attempt: number,
) => RegisteredVideo | RegisterRequestError;

/** Fake site client; each call runs `behavior`, a returned RegisterRequestError is thrown. */
export class FakeRegister implements RegisterClient {
    readonly payloads: RegisterPayload[] = [];

    constructor(
        private readonly behavior: RegisterBehavior = (payload) => ({
            id: 1,
            public_id: payload.public_id,
            embed_url: `https://site.example/embed/${payload.public_id}`,
        }),
    ) {}

    async register(payload: RegisterPayload): Promise<RegisteredVideo> {
        this.payloads.push(payload);
        const outcome = this.behavior(payload, this.payloads.length);

        if (outcome instanceof RegisterRequestError) throw outcome;

        return outcome;
    }
}

export async function makeTempDir(label: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `hls-${label}-`));
}

export interface TestDepsInput {
    runner: ReturnType<typeof createFakeRunner>;
    s3: FakeS3;
    register: RegisterClient;
    tmpRoot: string;
    sleeps?: number[];
    now?: Date;
    freeBytes?: number;
}

export function makeTestDeps(input: TestDepsInput): PipelineDeps {
    return {
        binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
        run: input.runner.run,
        createS3Client: () => input.s3.asClient(),
        register: input.register,
        tmpRoot: input.tmpRoot,
        now: () => input.now ?? new Date(Date.UTC(2026, 2, 5, 10, 0, 0)),
        sleep: async (ms) => {
            input.sleeps?.push(ms);
        },
        freeBytes: async () => input.freeBytes ?? 10 * 1024 ** 4,
        logger: NOOP_LOGGER,
    };
}
