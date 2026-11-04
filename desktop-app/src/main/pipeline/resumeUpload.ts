/**
 * Resumes an upload that ended as `upload_interrupted`: the temp dir (kept by runPipeline) and the
 * persisted register payload are enough, so nothing is transcoded again. Only the objects that
 * are missing on R2 (or have a different size) are uploaded, the playlist last, then the video is
 * registered like at the end of runPipeline.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../shared/appConfig';
import type { JobState } from '../../shared/types';
import type { PipelineDeps, PipelineJob } from './deps';
import {
    PipelineError,
    RESUME_UNAVAILABLE,
    cancelledError,
    scrubPaths,
    uploadInterruptedError,
} from './errors';
import { PLAYLIST_FILE, THUMBNAIL_FILE, storyboardFileName } from './fileNames';
import { overallProgress } from './progressModel';
import { validateRegisterPayload, type RegisterPayload } from './register';
import {
    classify,
    cleanupUploaded,
    destroyClient,
    registerWithRetry,
    removeJobDir,
    type PipelineHooks,
    type PipelineResult,
} from './runPipeline';
import { throwIfAborted } from './steps/env';
import { uploadFiles } from './steps/upload';
import { classifyUploadError } from './upload/classifyError';
import { progressFromUploaded } from './upload/plan';

export type ResumeUploadHooks = Pick<
    PipelineHooks,
    'onStage' | 'onProgress' | 'signal' | 'onBeforeRegister' | 'onNetworkWait' | 'onNetworkRestored'
>;

export interface ResumeUploadOptions {
    job: Pick<PipelineJob, 'id' | 'publicId'>;
    /** The register payload persisted through `onBeforeUpload` (or `upload_interrupted`). */
    payload: RegisterPayload;
    /** The temp dir kept by the interrupted run. */
    tmpDir: string;
    config: AppConfig;
    deps: PipelineDeps;
    hooks: ResumeUploadHooks;
}

const RESUME_UNAVAILABLE_MESSAGE =
    'The temporary files for this video are gone, so it cannot be resumed. Retry to process it again.';

function resumeUnavailable(prefix: string): PipelineError {
    return new PipelineError({
        kind: 'failed',
        step: 'uploading',
        message: RESUME_UNAVAILABLE_MESSAGE,
        code: RESUME_UNAVAILABLE,
        prefix,
    });
}

/** Segment file names referenced by a playlist (lines ending with `.ts`, comments skipped). */
export function parsePlaylistSegments(playlist: string): string[] {
    const names = playlist
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && line.endsWith('.ts'));

    return [...new Set(names)];
}

function samePath(a: string, b: string): boolean {
    const left = resolve(a);
    const right = resolve(b);

    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

interface LocalPlan {
    /** Every file of the video, playlist last. */
    names: string[];
    sizes: Map<string, number>;
}

/** Checks that every file the payload and the playlist refer to still exists in the temp dir. */
async function planLocalFiles(payload: RegisterPayload, tmpDir: string): Promise<LocalPlan> {
    const unavailable = (): PipelineError => resumeUnavailable(payload.disk_prefix);
    let playlist: string;

    try {
        playlist = await readFile(join(tmpDir, PLAYLIST_FILE), 'utf8');
    } catch {
        throw unavailable();
    }

    const segments = parsePlaylistSegments(playlist);

    if (segments.length === 0 || segments.some((name) => /[/\\]/.test(name))) throw unavailable();

    const storyboards = Object.keys(payload.storyboards ?? {}).map((key) =>
        storyboardFileName(Number(key.split('x')[0])),
    );
    const others = [
        ...segments,
        ...(payload.thumbnail_path === null ? [] : [THUMBNAIL_FILE]),
        ...storyboards,
    ];
    const sizes = new Map<string, number>();

    for (const name of [...others, PLAYLIST_FILE]) {
        try {
            const info = await stat(join(tmpDir, name));

            if (!info.isFile()) throw new Error('not a file');
            sizes.set(name, info.size);
        } catch {
            throw unavailable();
        }
    }

    return { names: [...others, PLAYLIST_FILE], sizes };
}

/** Object name -> size of everything under the prefix (ListObjectsV2, all pages). */
async function listRemoteSizes(
    client: S3Client,
    bucket: string,
    prefix: string,
    signal: AbortSignal,
): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    let token: string | undefined;

    do {
        const page = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
            { abortSignal: signal },
        );

        for (const entry of page.Contents ?? []) {
            if (typeof entry.Key === 'string' && entry.Key.startsWith(prefix)) {
                sizes.set(entry.Key.slice(prefix.length), entry.Size ?? -1);
            }
        }

        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    return sizes;
}

interface ResumeState {
    client: S3Client | null;
    step: JobState;
}

export async function resumeUpload(options: ResumeUploadOptions): Promise<PipelineResult> {
    const { job, payload, tmpDir, deps, hooks } = options;

    // Nothing below this guard may delete anything: the caller falls back to a fresh retry.
    if (validateRegisterPayload(payload).length > 0 || payload.public_id !== job.publicId) {
        deps.logger.error('Stored register payload is invalid.');
        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message: 'The stored video data is invalid, so the upload cannot be resumed.',
            prefix: payload.disk_prefix,
        });
    }

    // The temp dir is deleted on success: only ever touch the dir runPipeline would have made.
    if (!samePath(tmpDir, join(deps.tmpRoot, job.publicId)))
        throw resumeUnavailable(payload.disk_prefix);

    const plan = await planLocalFiles(payload, tmpDir);
    const state: ResumeState = { client: null, step: 'uploading' };

    try {
        const result = await execute(options, plan, state);

        await removeJobDir(tmpDir, deps.logger);

        return result;
    } catch (error) {
        const failure = classify(error, state, hooks.signal, deps.logger);

        if (failure.kind === 'upload_interrupted') {
            failure.registerPayload = payload;
            failure.tmpDir = tmpDir;
            failure.resumable = true;
        } else {
            // The R2 objects of this prefix (also those of the earlier run) are useless now.
            if (failure.kind === 'failed' || failure.kind === 'cancelled') {
                await cleanupUploaded(options.config, deps, payload.disk_prefix);
            }

            await removeJobDir(tmpDir, deps.logger);
        }

        failure.prefix = payload.disk_prefix;
        failure.stderrTail = scrubPaths(failure.stderrTail, [
            { path: tmpDir, label: '<job-dir>' },
            { path: deps.tmpRoot, label: '<tmp-root>' },
        ]);

        throw failure;
    } finally {
        destroyClient(state.client, deps.logger);
        state.client = null;
    }
}

async function execute(
    options: ResumeUploadOptions,
    plan: LocalPlan,
    state: ResumeState,
): Promise<PipelineResult> {
    const { payload, tmpDir, config, deps, hooks } = options;
    const prefix = payload.disk_prefix;
    let overall = 0;

    function report(stage: 'upload' | 'register', fraction: number): void {
        const next = overallProgress(stage, fraction, overall);

        if (next === overall) return;
        overall = next;
        hooks.onProgress(next);
    }

    throwIfAborted({ signal: hooks.signal, step: 'uploading' });
    hooks.onStage('uploading');
    report('upload', 0);

    // ---- which objects are already on R2 ----
    const remote = await listRemote(options);
    const missing = plan.names.filter(
        (name) => name !== PLAYLIST_FILE && remote.get(name) !== plan.sizes.get(name),
    );
    const skipped = plan.names.length - 1 - missing.length;

    report('upload', progressFromUploaded(skipped, plan.names.length));

    // ---- upload the rest, playlist always last (even when it exists already) ----
    state.client = deps.createS3Client(config.r2);
    await uploadFiles({
        client: state.client,
        bucket: config.r2.bucket,
        prefix,
        dir: tmpDir,
        files: [...missing, PLAYLIST_FILE],
        sizes: plan.sizes,
        totalCount: plan.names.length,
        initialDone: skipped,
        signal: hooks.signal,
        sleep: deps.sleep,
        logger: deps.logger,
        onProgress: (fraction) => report('upload', fraction),
        onUploadStarted: () => undefined,
        onNetworkWait: hooks.onNetworkWait,
        onNetworkRestored: hooks.onNetworkRestored,
        ...deps.uploadTuning,
    });

    // ---- register ----
    state.step = 'registering';
    hooks.onStage('registering');
    report('register', 0);
    await hooks.onBeforeRegister?.();

    const registered = await registerWithRetry(payload, deps, hooks.signal);

    report('register', 1);

    return { kind: 'done', registered, prefix, payload };
}

async function listRemote(options: ResumeUploadOptions): Promise<Map<string, number>> {
    const { payload, config, deps, hooks } = options;
    let client: S3Client | null = null;

    try {
        client = deps.createS3Client(config.r2, 'cleanup');

        return await listRemoteSizes(client, config.r2.bucket, payload.disk_prefix, hooks.signal);
    } catch (error) {
        if (hooks.signal.aborted) throw cancelledError('uploading');

        deps.logger.warn('Listing the uploaded objects failed.', { error });

        // Still offline: keep everything so the user can resume again later.
        if (classifyUploadError(error, hooks.signal) === 'network') throw uploadInterruptedError();

        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message:
                'Could not read the uploaded files from R2. Check the R2 settings and your connection.',
            cause: error,
        });
    } finally {
        destroyClient(client, deps.logger);
    }
}
