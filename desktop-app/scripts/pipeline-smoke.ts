/**
 * Manual smoke test: runs the REAL pipeline (ffmpeg + S3) on one video file.
 * Not part of the Electron bundle. Usage: `npm run smoke -- <video file>`; see README.
 *
 * Environment:
 *   SMOKE_FAKE_S3=1                  use an in-process fake S3 server (no credentials needed)
 *   SMOKE_R2_ENDPOINT, SMOKE_R2_BUCKET, SMOKE_R2_ACCESS_KEY_ID, SMOKE_R2_SECRET_ACCESS_KEY
 *                                    real R2 / S3 config (when SMOKE_FAKE_S3 is not set)
 *   SMOKE_RESOLUTION (480|720|1080, default 720), SMOKE_SEGMENT_SECONDS (default 6),
 *   SMOKE_FPS (default: keep source), SMOKE_TMP_ROOT (default: OS temp dir)
 *   FFMPEG_PATH / FFPROBE_PATH       ffmpeg binaries (default: from PATH)
 * The site register call is faked (the payload is printed); no site is contacted.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AppConfig } from '../src/shared/appConfig';
import { resolveBinaries } from '../src/main/ffmpeg/binaries';
import { createRunner } from '../src/main/ffmpeg/runner';
import { checkFfmpeg, createFfmpegTextRunner } from '../src/main/ffmpeg/selfCheck';
import { redact } from '../src/main/logger';
import type { Logger } from '../src/main/logger';
import { createDefaultDeps } from '../src/main/pipeline/defaultDeps';
import type { RegisterClient } from '../src/main/pipeline/deps';
import { generatePublicId } from '../src/main/pipeline/publicId';
import { PipelineError } from '../src/main/pipeline/errors';
import { runPipeline } from '../src/main/pipeline/runPipeline';
import { FakeS3Server } from '../src/main/pipeline/testing/fakeS3Server';

function required(name: string): string {
    const value = process.env[name];

    if (!value) throw new Error(`Missing environment variable ${name}`);

    return value;
}

const logger: Logger = {
    debug: () => undefined,
    info: (m, meta) => console.log(`[info] ${m}`, meta === undefined ? '' : redact(meta)),
    warn: (m, meta) => console.warn(`[warn] ${m}`, meta === undefined ? '' : redact(meta)),
    error: (m, meta) => console.error(`[error] ${m}`, meta === undefined ? '' : redact(meta)),
};

async function main(): Promise<number> {
    const file = process.argv[2];

    if (!file) {
        console.error('Usage: npm run smoke -- <video file>');

        return 2;
    }

    const binaries = resolveBinaries({
        platform: process.platform,
        resourcesPath: '',
        env: process.env,
        isPackaged: false,
    });
    const check = await checkFfmpeg(createFfmpegTextRunner(createRunner(), binaries.ffmpeg));

    console.log(`ffmpeg ${check.version ?? '?'} self check: ${check.ok ? 'ok' : 'FAILED'}`);

    if (!check.ok) {
        console.error(`Missing: ${check.missing.join(', ')}`);

        return 1;
    }

    const fake =
        process.env['SMOKE_FAKE_S3'] === '1' ? new FakeS3Server({ bucket: 'smoke' }) : null;

    await fake?.start();

    const resolution = process.env['SMOKE_RESOLUTION'] ?? '720';

    if (resolution !== '480' && resolution !== '720' && resolution !== '1080') {
        throw new Error('SMOKE_RESOLUTION must be 480, 720 or 1080');
    }

    const config: AppConfig = {
        r2: fake
            ? {
                  endpoint: fake.endpoint,
                  bucket: 'smoke',
                  access_key_id: 'fake',
                  secret_access_key: 'fake',
                  url: fake.endpoint,
              }
            : {
                  endpoint: required('SMOKE_R2_ENDPOINT'),
                  bucket: required('SMOKE_R2_BUCKET'),
                  access_key_id: required('SMOKE_R2_ACCESS_KEY_ID'),
                  secret_access_key: required('SMOKE_R2_SECRET_ACCESS_KEY'),
                  url: process.env['SMOKE_R2_URL'] ?? '',
              },
        transcode: {
            resolution,
            segment_seconds: Number(process.env['SMOKE_SEGMENT_SECONDS'] ?? 6),
            fps: process.env['SMOKE_FPS'] ? Number(process.env['SMOKE_FPS']) : null,
        },
    };

    const register: RegisterClient = {
        register: async (payload) => {
            console.log('Register payload (faked, not sent):');
            console.log(JSON.stringify(payload, null, 2));

            return {
                id: 0,
                public_id: payload.public_id,
                embed_url: `https://site.invalid/embed/${payload.public_id}`,
            };
        },
    };

    const ownTmpRoot = process.env['SMOKE_TMP_ROOT']
        ? null
        : await mkdtemp(join(tmpdir(), 'hls-smoke-'));
    const tmpRoot = process.env['SMOKE_TMP_ROOT'] ?? ownTmpRoot ?? tmpdir();
    const deps = createDefaultDeps({ binaries, tmpRoot, register, logger });
    const controller = new AbortController();

    process.once('SIGINT', () => controller.abort());

    try {
        const sourcePath = resolve(file);
        const result = await runPipeline({
            job: {
                id: 'smoke',
                sourcePath,
                filename: basename(sourcePath),
                publicId: generatePublicId(),
            },
            config,
            deps,
            hooks: {
                signal: controller.signal,
                onStage: (stage) => console.log(`-> ${stage}`),
                onProgress: (percent) => console.log(`   ${percent}%`),
                onPrefix: (prefix) => console.log(`   prefix ${prefix}`),
            },
        });

        console.log(`Done: ${result.registered.embed_url} (prefix ${result.prefix})`);

        if (fake) {
            console.log(`Fake S3 holds ${fake.objects.size} objects:`);
            for (const [key, data] of fake.objects) console.log(`  ${key} (${data.length} bytes)`);
        }

        return 0;
    } catch (error) {
        if (error instanceof PipelineError) {
            console.error(`Pipeline ${error.kind} at ${error.step}: ${error.message}`);
            if (error.stderrTail.length > 0) console.error(error.stderrTail.slice(-20).join('\n'));
        } else {
            console.error(error);
        }

        return 1;
    } finally {
        await fake?.stop();
        if (ownTmpRoot) await rm(ownTmpRoot, { recursive: true, force: true });
    }
}

process.exitCode = await main();
