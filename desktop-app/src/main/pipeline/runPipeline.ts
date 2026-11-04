/** The full job pipeline (spec 4.4): checks, prefix, probe, transcode, thumbnail, storyboard, upload, register. */
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../shared/appConfig';
import type { JobState } from '../../shared/types';
import type { Logger } from '../logger';
import type { PipelineDeps, PipelineJob, RegisteredVideo } from './deps';
import { PipelineError, cancelledError, scrubPaths } from './errors';
import { buildPrefix, isValidPrefix } from './prefix';
import { isValidPublicId } from './publicId';
import {
    REGISTER_RETRY_DELAYS_MS,
    buildRegisterPayload,
    mapRegisterError,
    validatePrefixLength,
    validateRegisterPayload,
    type RegisterErrorInfo,
    type RegisterPayload,
} from './register';
import { RegisterRequestError, toRegisterFailure } from './registerClient';
import { overallProgress, type PipelineStage } from './progressModel';
import { baseNameWithoutExtension, slugify } from './slug';
import { deleteR2Prefix } from './steps/cleanup';
import { throwIfAborted, type StepEnv } from './steps/env';
import { probeDuration, probeFps, probeOutputInfo } from './steps/probe';
import { generateStoryboards } from './steps/storyboard';
import { generateThumbnail } from './steps/thumbnail';
import { transcodeToHls } from './steps/transcode';
import { uploadDirectory, type NetworkWaitInfo } from './steps/upload';
import { withRetry } from './upload/plan';

export const ALLOWED_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
export const DISK_RESERVE_BYTES = 1024 ** 3;
export const DISK_SIZE_FACTOR = 1.5;

export type PipelineStep = Extract<
    JobState,
    'transcoding' | 'thumbnail' | 'storyboard' | 'uploading' | 'registering'
>;

export interface PipelineHooks {
    onStage: (stage: PipelineStep) => void;
    /** Whole-number overall percent (0-100), never decreasing. */
    onProgress: (percent: number) => void;
    signal: AbortSignal;
    /** Called as soon as the R2 prefix is known (so an interrupted job can be cleaned later). */
    onPrefix?: (prefix: string) => void;
    /**
     * Awaited after the `registering` transition and BEFORE the first register request. The queue
     * flushes the store here, so a crash can never leave a registered video persisted as
     * `uploading` (a later Retry would otherwise treat its R2 files as stale).
     */
    onBeforeRegister?: () => Promise<void>;
    /**
     * Awaited after the `uploading` transition, once thumbnail and storyboard are done and BEFORE
     * the first PutObject. The queue persists `registerPayload` (identical to what is registered at
     * the end) and `tmpDir` durably here, so an `upload_interrupted` job can be resumed.
     */
    onBeforeUpload?: (info: BeforeUploadInfo) => Promise<void>;
    /** The upload is waiting for the network (throttled to about one call per 5 s). */
    onNetworkWait?: (info: NetworkWaitInfo) => void;
    /** The first upload succeeded after `onNetworkWait` was called. */
    onNetworkRestored?: () => void;
}

export interface BeforeUploadInfo {
    prefix: string;
    publicId: string;
    tmpDir: string;
    registerPayload: RegisterPayload;
}

export type RetryRegisterHooks = Pick<
    PipelineHooks,
    'onStage' | 'onProgress' | 'signal' | 'onBeforeRegister'
>;

export interface PipelineResult {
    kind: 'done';
    registered: RegisteredVideo;
    prefix: string;
    payload: RegisterPayload;
}

export interface RunPipelineOptions {
    job: PipelineJob;
    config: AppConfig;
    deps: PipelineDeps;
    hooks: PipelineHooks;
}

export interface RetryRegisterOptions {
    payload: RegisterPayload;
    deps: PipelineDeps;
    hooks: RetryRegisterHooks;
}

const STAGE_OF_STEP: Record<PipelineStep, PipelineStage> = {
    transcoding: 'transcoding',
    thumbnail: 'thumbnail',
    storyboard: 'storyboard',
    uploading: 'upload',
    registering: 'register',
};

interface RunState {
    jobDir: string | null;
    prefix: string | null;
    client: S3Client | null;
    uploadStarted: boolean;
    payload: RegisterPayload | null;
    step: JobState;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
    const { job, deps, hooks } = options;
    const state: RunState = {
        jobDir: null,
        prefix: null,
        client: null,
        uploadStarted: false,
        payload: null,
        step: 'waiting',
    };

    try {
        const result = await execute(options, state);

        await removeJobDir(state.jobDir, deps.logger);

        return result;
    } catch (error) {
        const failure = classify(error, state, hooks.signal, deps.logger);

        if (failure.kind === 'upload_interrupted') {
            // Keep the R2 objects and the temp dir: resumeUpload needs both.
            failure.registerPayload = state.payload ?? undefined;
            failure.tmpDir = state.jobDir;
            failure.resumable = state.payload !== null && state.jobDir !== null;
        } else {
            // Everything uploaded so far is useless after a failure or cancel: remove it from R2.
            if (
                (failure.kind === 'failed' || failure.kind === 'cancelled') &&
                state.uploadStarted &&
                state.client !== null &&
                state.prefix !== null
            ) {
                await cleanupUploaded(options.config, deps, state.prefix);
            }

            await removeJobDir(state.jobDir, deps.logger);
        }

        failure.prefix = state.prefix;
        failure.stderrTail = scrubPaths(failure.stderrTail, [
            { path: job.sourcePath, label: '<source>' },
            { path: dirname(job.sourcePath), label: '<source-dir>' },
            ...(state.jobDir === null ? [] : [{ path: state.jobDir, label: '<job-dir>' }]),
            { path: deps.tmpRoot, label: '<tmp-root>' },
        ]);

        throw failure;
    } finally {
        destroyClient(state.client, deps.logger);
        state.client = null;
    }
}

/** Deletes the uploaded files with a dedicated client (cleanup calls may use SDK retries). */
export async function cleanupUploaded(
    config: AppConfig,
    deps: PipelineDeps,
    prefix: string,
): Promise<void> {
    let client: S3Client | null = null;

    try {
        client = deps.createS3Client(config.r2, 'cleanup');
        await deleteR2Prefix(client, config.r2.bucket, prefix, deps.logger);
    } catch (error) {
        deps.logger.warn('Cleaning up the R2 prefix failed (best effort).', { error });
    } finally {
        destroyClient(client, deps.logger);
    }
}

export function destroyClient(client: S3Client | null, logger: Logger): void {
    if (client === null) return;

    try {
        client.destroy();
    } catch (error) {
        logger.warn('Could not close the R2 client.', { error });
    }
}

/** Retries the register call of a job whose files are already on R2 (no upload happens). */
export async function retryRegister(options: RetryRegisterOptions): Promise<PipelineResult> {
    const { payload, deps, hooks } = options;
    let overall = 0;

    function report(fraction: number): void {
        const next = overallProgress('register', fraction, overall);
        if (next === overall) return;
        overall = next;
        hooks.onProgress(next);
    }

    const errors = validateRegisterPayload(payload);

    if (errors.length > 0) {
        deps.logger.error('Stored register payload is invalid.', { errors });
        throw new PipelineError({
            kind: 'failed',
            step: 'registering',
            message: 'The stored video data is invalid, so it cannot be registered.',
            prefix: payload.disk_prefix,
        });
    }

    hooks.onStage('registering');
    report(0);
    await hooks.onBeforeRegister?.();

    const registered = await registerWithRetry(payload, deps, hooks.signal);

    report(1);

    return { kind: 'done', registered, prefix: payload.disk_prefix, payload };
}

async function execute(options: RunPipelineOptions, state: RunState): Promise<PipelineResult> {
    const { job, config, deps, hooks } = options;
    let overall = 0;

    function report(step: PipelineStep, fraction: number): void {
        const next = overallProgress(STAGE_OF_STEP[step], fraction, overall);
        if (next === overall) return;
        overall = next;
        hooks.onProgress(next);
    }

    function enter(step: PipelineStep): void {
        state.step = step;
        throwIfAborted({ signal: hooks.signal, step });
        hooks.onStage(step);
        report(step, 0);
    }

    // ---- step 0: checks and temp dir ----
    const sourceSize = await checkSource(job, deps, hooks.signal);
    const jobDir = join(deps.tmpRoot, job.publicId);

    await rm(jobDir, { recursive: true, force: true });
    await mkdir(jobDir, { recursive: true });
    state.jobDir = jobDir;

    // ---- step 1: prefix ----
    const slug = slugify(baseNameWithoutExtension(job.filename));
    const prefix = buildPrefix({ now: deps.now(), slug, publicId: job.publicId });

    if (!isValidPrefix(prefix, job.publicId)) {
        throw new PipelineError({
            kind: 'failed',
            step: 'waiting',
            message: 'Could not build a valid upload location for this file name.',
        });
    }

    // The server columns are varchar(255): fail now, before anything is processed or uploaded.
    const lengthProblems = validatePrefixLength(prefix);

    if (lengthProblems.length > 0) {
        throw new PipelineError({
            kind: 'failed',
            step: 'waiting',
            message: 'The file name is too long to build a valid upload location.',
        });
    }

    state.prefix = prefix;
    hooks.onPrefix?.(prefix);

    const env = (step: JobState): StepEnv => ({
        run: deps.run,
        ffmpeg: deps.binaries.ffmpeg,
        ffprobe: deps.binaries.ffprobe,
        cwd: jobDir,
        signal: hooks.signal,
        logger: deps.logger,
        step,
    });

    // ---- steps 2-3: probe + transcode ----
    enter('transcoding');
    const duration = await probeDuration(env('transcoding'), job.sourcePath);
    // Like the PHP job, the source fps is only probed when the config does not force one.
    const outputFps = config.transcode.fps ?? (await probeFps(env('transcoding'), job.sourcePath));

    await transcodeToHls(env('transcoding'), {
        input: job.sourcePath,
        transcode: config.transcode,
        duration,
        outputFps,
        threads: deps.threads,
        onFraction: (fraction) => report('transcoding', fraction),
    });

    const output = await probeOutputInfo(env('transcoding'), config.transcode.segment_seconds);

    // ---- step 4: thumbnail ----
    enter('thumbnail');
    const hasThumbnail = await generateThumbnail(env('thumbnail'), {
        input: job.sourcePath,
        duration,
        width: output.width,
        height: output.height,
    });

    // ---- step 5: storyboard ----
    enter('storyboard');
    const storyboards = await generateStoryboards(env('storyboard'), {
        input: job.sourcePath,
        duration,
        prefix,
        threads: deps.threads,
    });
    const storyboardGrids = Object.keys(storyboards ?? {}).map((key) => Number(key.split('x')[0]));

    // ---- step 6: upload ----
    // Everything the register call needs is known now; build it before the first byte is sent.
    const payload = buildRegisterPayload({
        publicId: job.publicId,
        prefix,
        originalFilename: job.filename,
        originalSizeBytes: sourceSize,
        duration,
        hasThumbnail,
        storyboardGrids,
        output,
    });
    const problems = validateRegisterPayload(payload);

    if (problems.length > 0) {
        deps.logger.error('Built register payload is invalid.', { problems });
        throw new PipelineError({
            kind: 'failed',
            step: 'registering',
            message: 'Internal error: the video data to register is invalid.',
        });
    }

    state.payload = payload;
    enter('uploading');
    await hooks.onBeforeUpload?.({
        prefix,
        publicId: job.publicId,
        tmpDir: jobDir,
        registerPayload: payload,
    });
    state.client = deps.createS3Client(config.r2);
    await uploadDirectory({
        client: state.client,
        bucket: config.r2.bucket,
        prefix,
        dir: jobDir,
        signal: hooks.signal,
        sleep: deps.sleep,
        logger: deps.logger,
        onProgress: (fraction) => report('uploading', fraction),
        onUploadStarted: () => {
            state.uploadStarted = true;
        },
        onPlaylistUploaded: () => undefined,
        onNetworkWait: hooks.onNetworkWait,
        onNetworkRestored: hooks.onNetworkRestored,
        ...deps.uploadTuning,
    });

    // ---- step 7: register ----
    enter('registering');
    await hooks.onBeforeRegister?.();

    const registered = await registerWithRetry(payload, deps, hooks.signal);

    report('registering', 1);

    return { kind: 'done', registered, prefix, payload };
}

/** Step 0: the source must exist, have an allowed extension and fit on disk. Returns its size. */
async function checkSource(
    job: PipelineJob,
    deps: PipelineDeps,
    signal: AbortSignal,
): Promise<number> {
    const fail = (message: string): PipelineError =>
        new PipelineError({ kind: 'failed', step: 'waiting', message });

    if (!isValidPublicId(job.publicId)) throw fail('The job has an invalid video ID.');

    const extension = /\.([^./\\]+)$/.exec(job.sourcePath)?.[1]?.toLowerCase() ?? '';

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw fail(`Unsupported file type. Supported: ${ALLOWED_EXTENSIONS.join(', ')}.`);
    }

    let size: number;

    try {
        const info = await stat(job.sourcePath);
        if (!info.isFile()) throw new Error('not a file');
        size = info.size;
    } catch {
        throw fail('The source file was not found.');
    }

    if (size < 1) throw fail('The source file is empty.');

    await mkdir(deps.tmpRoot, { recursive: true });

    const needed = Math.ceil(size * DISK_SIZE_FACTOR + DISK_RESERVE_BYTES);
    const free = await deps.freeBytes(deps.tmpRoot);

    if (free < needed) {
        const gb = (needed / 1024 ** 3).toFixed(1);
        throw fail(`Not enough free disk space for temporary files (about ${gb} GB needed).`);
    }

    if (signal.aborted) throw cancelledError('waiting');

    return size;
}

/** Register with the B2 backoff (5 retries: 1, 2, 4, 8, 16 s; 429 may override with Retry-After). */
export async function registerWithRetry(
    payload: RegisterPayload,
    deps: PipelineDeps,
    signal: AbortSignal,
): Promise<RegisteredVideo> {
    // Nothing was sent yet, so a cancel here is a plain cancel.
    if (signal.aborted) throw cancelledError('registering');

    let last: RegisterErrorInfo | null = null;
    let interrupted = false;

    try {
        return await withRetry(
            (attempt) => {
                // The backoff sleep resolves early on abort: never send another request after it.
                if (attempt > 1 && signal.aborted) {
                    throw new RegisterRequestError(
                        { kind: 'network' },
                        'aborted before the next register attempt',
                    );
                }

                return deps.register.register(payload);
            },
            {
                delaysMs: REGISTER_RETRY_DELAYS_MS,
                sleep: (ms) => deps.sleep(last?.retryAfterMs ?? ms, signal),
                shouldRetry: (error) => {
                    last = mapRegisterError(toRegisterFailure(error));
                    if (last.retryable && signal.aborted) interrupted = true;

                    return last.retryable && !signal.aborted;
                },
                onRetry: (_error, attempt, delayMs) =>
                    deps.logger.warn('Register failed; retrying.', { attempt, delayMs }),
            },
        );
    } catch (error) {
        const info = last ?? mapRegisterError(toRegisterFailure(error));

        deps.logger.warn('Register failed.', { error });

        if (info.needsSignIn) {
            throw new PipelineError({
                kind: 'needs_sign_in',
                step: 'registering',
                message: info.userMessage,
                registerPayload: payload,
                prefix: payload.disk_prefix,
                cause: error,
            });
        }

        if (!info.definitive) {
            throw new PipelineError({
                kind: 'register_failed',
                step: 'registering',
                message: interrupted
                    ? 'Registering was interrupted. The video is uploaded; use Retry to finish.'
                    : `${info.userMessage} The video is uploaded; use Retry to finish registering.`,
                registerPayload: payload,
                prefix: payload.disk_prefix,
                cause: error,
            });
        }

        // Only `playlist_not_found` / `public_id_conflict` are definitive: retrying cannot help.
        throw new PipelineError({
            kind: 'failed',
            step: 'registering',
            message: info.userMessage,
            prefix: payload.disk_prefix,
            definitive: true,
            cause: error,
        });
    }
}

/** Maps any thrown value to a PipelineError with a safe message. */
export function classify(
    error: unknown,
    state: Pick<RunState, 'step'>,
    signal: AbortSignal,
    logger: Logger,
): PipelineError {
    if (error instanceof PipelineError) {
        const keepsKind = error.kind === 'register_failed' || error.kind === 'needs_sign_in';

        if (signal.aborted && !keepsKind && error.kind !== 'cancelled') {
            return cancelledError(error.step);
        }

        return error;
    }

    if (signal.aborted) return cancelledError(state.step);

    logger.error('Pipeline step failed unexpectedly.', { step: state.step, error });

    return new PipelineError({
        kind: 'failed',
        step: state.step,
        message: safeMessage(error),
        cause: error,
    });
}

function safeMessage(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;

    switch (code) {
        case 'ENOSPC':
            return 'The disk is full.';
        case 'ENOENT':
            return 'A required file was not found.';
        case 'EACCES':
        case 'EPERM':
            return 'Permission denied while accessing files.';
        default:
            return 'An unexpected error occurred.';
    }
}

export async function removeJobDir(jobDir: string | null, logger: Logger): Promise<void> {
    if (jobDir === null) return;

    try {
        await rm(jobDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
        logger.warn('Could not remove the job temp directory.', { error });
    }
}
