/** Job queue and state machine over the AppStore (spec 4.3 / 4.4 / 4.5). No Electron imports. */
import type { S3Client } from '@aws-sdk/client-s3';
import { basename, join } from 'node:path';
import type { AppConfig } from '../../shared/appConfig';
import type { ActionResult, AuthState, JobDto, QueueSummary, RejectedFile } from '../../shared/ipc';
import type { JobRecord, JobState } from '../../shared/types';
import type { Logger } from '../logger';
import { redact } from '../logger';
import type { PipelineDeps } from '../pipeline/deps';
import { PipelineError, RESUME_UNAVAILABLE } from '../pipeline/errors';
import { isValidPublicId } from '../pipeline/publicId';
import type { resumeUpload } from '../pipeline/resumeUpload';
import type { PipelineResult, retryRegister, runPipeline } from '../pipeline/runPipeline';
import type { NetworkWaitInfo } from '../pipeline/steps/upload';
import type { AppStore } from '../store';
import { capHistory } from '../store';
import { validateVideoPath, pathKey, type FileStat } from './fileValidation';
import { toJobDto, type JobRuntimeInfo } from './jobDto';
import {
    isAttentionState,
    isFinalState,
    isPausedUpload,
    isRunningState,
    RETRYABLE_STATES,
} from './jobStates';

export type RunPipelineFn = typeof runPipeline;
export type RetryRegisterFn = typeof retryRegister;
export type ResumeUploadFn = typeof resumeUpload;
export type DeletePrefixFn = (
    client: S3Client,
    bucket: string,
    prefix: string,
    logger?: Logger,
) => Promise<unknown>;

export interface QueueFs {
    stat(path: string): Promise<FileStat>;
    /** Recursive, forced removal. */
    rm(path: string): Promise<void>;
}

export interface JobQueueOptions {
    store: AppStore;
    runPipelineFn: RunPipelineFn;
    retryRegisterFn: RetryRegisterFn;
    resumeUploadFn: ResumeUploadFn;
    deletePrefixFn: DeletePrefixFn;
    /** Fresh deps (reads the current tmpRoot); called once per run. */
    getDeps: () => PipelineDeps;
    /** Latest site config (RAM only) or null while signed out / not configured. */
    getConfig: () => AppConfig | null;
    getAuthState: () => AuthState;
    /** True while a token exists. Together with a signed_in state it is required to start jobs. */
    hasSession?: () => boolean;
    /** Called with every auth change; used to resume jobs after sign-in. */
    subscribeAuth?: (listener: (state: AuthState) => void) => () => void;
    /** A non-null text blocks starting jobs (e.g. ffmpeg self-check failed). */
    getStartBlock?: () => string | null;
    fs: QueueFs;
    now: () => Date;
    generateId: () => string;
    generatePublicId: () => string;
    platform: NodeJS.Platform;
    logger: Logger;
    /** Max `jobs:updated` events per job per second is 1000/throttleMs. Default 250 (4/s). */
    throttleMs?: number;
    /** Max wait for running jobs to clean up on shutdown. Default 15000. */
    shutdownTimeoutMs?: number;
}

export interface AddFilesOutcome {
    added: number;
    rejected: RejectedFile[];
}

type JobsListener = (jobs: JobDto[]) => void;
type SummaryListener = (summary: QueueSummary) => void;

interface Runtime {
    controller: AbortController;
    kind: 'pipeline' | 'register' | 'resume';
    /** State to return to when a register retry is cancelled. */
    previousState: JobState;
    progress: number;
    /** Upload retries because the network is down (RAM only, never persisted). */
    waitingForNetwork: boolean;
    /** Epoch ms the current outage started. */
    networkWaitSince: number | null;
    /** Epoch ms of the next automatic attempt. */
    nextRetryAt: number | null;
    lastEmitAt: number;
    trailing: ReturnType<typeof setTimeout> | null;
    done: Promise<void>;
}

const INTERRUPTED_MESSAGE =
    'The app was closed while this job was running. Use Retry to start it again.';
const RECOVERED_UPLOAD_MESSAGE = 'The app was closed during upload. Resume to continue.';
const OK: ActionResult = { ok: true };

/** Shown when a job belongs to another site than the one that is signed in. */
export function otherSiteMessage(origin: string): string {
    let host = origin;

    try {
        host = new URL(origin).host;
    } catch {
        // Keep the raw value.
    }

    return `This video was uploaded for ${host}; sign in to that site to finish it.`;
}

function fail(error: string): ActionResult {
    return { ok: false, error };
}

export class JobQueue {
    private readonly runtimes = new Map<string, Runtime>();
    private readonly jobListeners = new Set<JobsListener>();
    private readonly summaryListeners = new Set<SummaryListener>();
    private readonly throttleMs: number;
    private lastSummaryJson = '';
    private shuttingDown = false;
    private unsubscribeAuth: (() => void) | null = null;

    constructor(private readonly opts: JobQueueOptions) {
        this.throttleMs = opts.throttleMs ?? 250;
        this.unsubscribeAuth = opts.subscribeAuth?.((state) => this.onAuthChanged(state)) ?? null;
    }

    // ---- read side ------------------------------------------------------------------------

    list(): JobDto[] {
        const reason = this.waitingReason();

        return this.jobs().map((job) => this.dtoOf(job, reason));
    }

    getJob(id: string): JobRecord | undefined {
        return this.jobs().find((job) => job.id === id);
    }

    hasActiveJobs(): boolean {
        return this.runtimes.size > 0;
    }

    /** True while any job is uploaded but not registered (`register_failed` / `needs_sign_in`). */
    hasAttentionJobs(): boolean {
        return this.jobs().some((job) => isAttentionState(job.state));
    }

    /**
     * True while any upload is paused (or about to resume): its temp files and `siteOrigin` are
     * needed, so the temp folder and the site cannot change.
     */
    hasPausedUploads(): boolean {
        return this.jobs().some(
            (job) =>
                isPausedUpload(job.state) || (job.state === 'waiting' && job.mode === 'resume'),
        );
    }

    summary(): QueueSummary {
        const jobs = this.jobs();
        const count = (pred: (job: JobRecord) => boolean): number => jobs.filter(pred).length;
        const waiting = count((j) => j.state === 'waiting' && !this.runtimes.has(j.id));

        return {
            running: this.runtimes.size,
            waiting,
            attention: count((j) => isAttentionState(j.state) || isPausedUpload(j.state)),
            done: count((j) => j.state === 'done'),
            failed: count((j) => j.state === 'failed' || j.state === 'interrupted'),
            total: jobs.length,
            blockedReason: waiting > 0 ? this.gate() : null,
        };
    }

    subscribe(listener: JobsListener): () => void {
        this.jobListeners.add(listener);

        return () => this.jobListeners.delete(listener);
    }

    subscribeSummary(listener: SummaryListener): () => void {
        this.summaryListeners.add(listener);

        return () => this.summaryListeners.delete(listener);
    }

    // ---- lifecycle ------------------------------------------------------------------------

    /**
     * Startup recovery. A running job whose upload was prepared (payload + temp dir still on
     * disk) becomes a resumable `upload_interrupted`; any other running job becomes
     * `interrupted` and its temp dir is removed. R2 objects are never deleted here.
     */
    async recover(): Promise<void> {
        const orphans: string[] = [];
        const resumable = new Set<string>();
        const nowIso = this.iso();

        for (const job of this.jobs()) {
            if (!isRunningState(job.state) || !job.registerPayload || !job.tmpDir) continue;
            if (!isValidPublicId(job.publicId)) continue;

            try {
                await this.opts.fs.stat(job.tmpDir);
                resumable.add(job.id);
            } catch {
                // The temp files are gone: it cannot be resumed.
            }
        }

        let paused = 0;

        this.opts.store.update((draft) => {
            for (const job of draft.jobs) {
                if (job.state === 'waiting' && job.mode === 'resume') {
                    // The app closed before the resume started: back to the paused state.
                    delete job.mode;
                    job.state = 'upload_interrupted';
                    job.errorMessage = RECOVERED_UPLOAD_MESSAGE;
                    job.errorDetail = { step: 'uploading', exitCode: null, stderrTail: [] };
                    job.updatedAt = nowIso;
                    paused += 1;
                    continue;
                }

                if (!isRunningState(job.state)) continue;

                if (resumable.has(job.id)) {
                    job.errorDetail = { step: 'uploading', exitCode: null, stderrTail: [] };
                    job.state = 'upload_interrupted';
                    job.errorMessage = RECOVERED_UPLOAD_MESSAGE;
                    job.finishedAt = null;
                    job.updatedAt = nowIso;
                    paused += 1;
                    continue;
                }

                job.errorDetail = { step: job.state, exitCode: null, stderrTail: [] };
                job.state = 'interrupted';
                job.errorMessage = INTERRUPTED_MESSAGE;
                job.finishedAt = nowIso;
                job.updatedAt = nowIso;
                delete job.tmpDir;
                if (isValidPublicId(job.publicId)) orphans.push(job.publicId);
            }
        });

        for (const publicId of orphans) await this.removeTmpDir(publicId);

        if (orphans.length > 0)
            this.opts.logger.info('Recovered interrupted jobs', { count: orphans.length });
        if (paused > 0) this.opts.logger.info('Recovered paused uploads', { count: paused });

        this.changed();
        this.pump();
    }

    /** Re-evaluates what can start (after settings, config or ffmpeg check changed). */
    kick(): void {
        this.changed();
        this.pump();
    }

    /** Aborts every running job and waits (bounded) for their cleanup. No new job starts. */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.unsubscribeAuth?.();
        this.unsubscribeAuth = null;

        const pending = [...this.runtimes.values()].map((runtime) => {
            runtime.controller.abort();

            return runtime.done;
        });

        if (pending.length === 0) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.opts.shutdownTimeoutMs ?? 15000);
        });

        await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
        clearTimeout(timer);
    }

    // ---- actions --------------------------------------------------------------------------

    /** Validates and enqueues files. A batch runs smallest first; batches are FIFO. */
    async addFiles(paths: readonly string[]): Promise<AddFilesOutcome> {
        const rejected: RejectedFile[] = [];
        const valid: { path: string; size: number }[] = [];

        for (const path of paths) {
            const result = await validateVideoPath(path, (p) => this.opts.fs.stat(p));

            if (result.ok) valid.push(result.file);
            else rejected.push(result.rejected);
        }

        // Dedupe in one synchronous block so two concurrent adds cannot both pass.
        const taken = new Set(
            this.jobs()
                .filter((job) => !isFinalState(job.state))
                .map((job) => pathKey(job.sourcePath, this.opts.platform)),
        );
        const fresh: { path: string; size: number }[] = [];

        for (const file of valid) {
            const key = pathKey(file.path, this.opts.platform);

            if (taken.has(key)) {
                rejected.push({ name: basename(file.path), reason: 'Already in the queue.' });
                continue;
            }

            taken.add(key);
            fresh.push(file);
        }

        fresh.sort((a, b) => a.size - b.size);

        if (fresh.length > 0) {
            const nowIso = this.iso();
            const records = fresh.map((file): JobRecord => ({
                id: this.opts.generateId(),
                sourcePath: file.path,
                sizeBytes: file.size,
                state: 'waiting',
                publicId: null,
                prefix: null,
                errorMessage: null,
                errorDetail: null,
                createdAt: nowIso,
                updatedAt: nowIso,
                startedAt: null,
                finishedAt: null,
                registerPayload: null,
                registered: null,
            }));

            this.opts.store.update((draft) => {
                draft.jobs.push(...records);
            });
            this.changed();
            this.pump();
        }

        return { added: fresh.length, rejected };
    }

    async cancel(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job) return fail('The job no longer exists.');

        const runtime = this.runtimes.get(id);

        if (runtime) {
            if (!runtime.controller.signal.aborted) {
                runtime.controller.abort();
                this.changed();
            }

            return OK;
        }

        if (job.state === 'waiting') {
            const resuming = job.mode === 'resume';
            const snapshot = { ...job };

            this.patch(id, (j) => {
                j.state = 'cancelled';
                j.errorMessage = 'The job was cancelled.';
                j.errorDetail = null;
                j.finishedAt = this.iso();

                if (resuming) {
                    j.registerPayload = null;
                    delete j.mode;
                    delete j.tmpDir;
                }
            });
            this.changed();

            // A queued resume owns kept files; cancelling discards them like a running cancel.
            if (resuming) await this.discardPausedFiles(snapshot);

            return OK;
        }

        if (isAttentionState(job.state)) {
            // Files stay on R2: the site may already have registered the video (lost response).
            this.patch(id, (j) => {
                j.state = 'cancelled';
                j.errorMessage =
                    'The job was cancelled. Files already uploaded to R2 were not removed.';
                j.errorDetail = { step: 'registering', exitCode: null, stderrTail: [] };
                j.registerPayload = null;
                j.finishedAt = this.iso();
            });
            this.changed();

            return OK;
        }

        return fail('This job cannot be cancelled.');
    }

    /**
     * Re-runs a failed/cancelled/interrupted job from scratch with a NEW public id. For a paused
     * upload (`upload_interrupted`) this is "Start over".
     */
    async retry(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job || this.runtimes.has(id)) return fail('The job no longer exists.');
        if (!RETRYABLE_STATES.includes(job.state) && !isPausedUpload(job.state)) {
            return fail('This job cannot be retried.');
        }

        await this.restartFresh(job, this.stalePrefixOf(job));

        return OK;
    }

    /**
     * The R2 prefix a restart may delete, or null. Only partial uploads of failed/cancelled jobs
     * are certainly unregistered (the pipeline already tried to delete them). An `interrupted`
     * job was cut off at an unknown point and a paused upload whose register call started may be
     * registered: those files are NEVER deleted automatically.
     */
    private stalePrefixOf(job: JobRecord): string | null {
        if (isPausedUpload(job.state)) {
            const prefix = job.prefix ?? job.registerPayload?.disk_prefix ?? null;

            if (job.registerStarted === true && prefix !== null) {
                this.opts.logger.warn(
                    'Restarting a paused upload whose register call may have reached the site; its R2 files were kept and may be orphaned.',
                    { prefix, siteOrigin: job.siteOrigin ?? null },
                );

                return null;
            }

            return prefix;
        }

        if (job.state === 'interrupted' && job.prefix !== null) {
            this.opts.logger.warn(
                'Retrying an interrupted job; its R2 files were kept and may be orphaned.',
                { prefix: job.prefix, siteOrigin: job.siteOrigin ?? null },
            );
        }

        return job.prefix !== null &&
            job.state !== 'interrupted' &&
            job.errorDetail?.step === 'uploading'
            ? job.prefix
            : null;
    }

    /** Resets the job to `waiting` (new public id on start) and removes the old artifacts. */
    private async restartFresh(job: JobRecord, stalePrefix: string | null): Promise<void> {
        const id = job.id;
        const staleOrigin = job.siteOrigin;
        const staleId = job.publicId;

        this.patch(id, (j) => {
            j.state = 'waiting';
            j.publicId = null;
            j.prefix = null;
            j.errorMessage = null;
            j.errorDetail = null;
            j.registerPayload = null;
            j.registered = null;
            j.startedAt = null;
            j.finishedAt = null;
            delete j.tmpDir;
            delete j.registerStarted;
            delete j.mode;
        });
        this.changed();

        if (stalePrefix !== null) await this.cleanupPrefix(stalePrefix, staleOrigin);
        if (staleId !== null) await this.removeTmpDir(staleId);

        this.pump();
    }

    /**
     * Continues a paused upload without transcoding again. The job goes through the normal run
     * loop (it respects maxConcurrent and the start gate).
     */
    async resume(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job || this.runtimes.has(id)) return fail('The job no longer exists.');
        if (!isPausedUpload(job.state) || !job.registerPayload || job.publicId === null) {
            return fail('This upload cannot be resumed.');
        }
        if (this.shuttingDown) return fail('The app is closing.');
        if (this.opts.getAuthState().status !== 'signed_in') {
            return fail('Sign in to resume this upload.');
        }

        const foreign = this.foreignOrigin(job);

        if (foreign !== null) return fail(otherSiteMessage(foreign));

        this.patch(id, (j) => {
            j.state = 'waiting';
            j.mode = 'resume';
            j.errorMessage = null;
            j.errorDetail = null;
            j.finishedAt = null;
        });
        this.changed();
        this.pump();

        return OK;
    }

    /** Finishes registering a job whose files are already on R2 (no re-upload). */
    async retryRegister(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job || this.runtimes.has(id)) return fail('The job no longer exists.');
        if (!isAttentionState(job.state) || !job.registerPayload) {
            return fail('This job cannot be registered again.');
        }
        if (this.shuttingDown) return fail('The app is closing.');
        if (this.opts.getAuthState().status !== 'signed_in') {
            return fail('Sign in to finish registering this video.');
        }

        const foreign = this.foreignOrigin(job);

        if (foreign !== null) return fail(otherSiteMessage(foreign));

        const payload = job.registerPayload;
        const controller = new AbortController();
        const runtime = this.newRuntime(controller, 'register', job.state);

        this.runtimes.set(id, runtime);
        this.patch(id, (j) => {
            j.state = 'registering';
            j.errorMessage = null;
        });
        this.changed();

        runtime.done = this.opts
            .retryRegisterFn({
                payload,
                deps: this.opts.getDeps(),
                hooks: {
                    signal: controller.signal,
                    onStage: (stage) => this.onStage(id, stage),
                    onProgress: (percent) => this.onProgress(id, percent),
                    onBeforeRegister: () => this.markRegisterStarted(id),
                },
            })
            .then(
                (result) => this.onDone(id, result),
                (error: unknown) => this.onFailure(id, error, runtime),
            )
            .finally(() => this.pump())
            .catch((error: unknown) =>
                this.opts.logger.error('Job bookkeeping failed', { id, error }),
            );

        return OK;
    }

    /**
     * Removes a finished job (done, failed, cancelled, interrupted) or a paused upload from the
     * list. A paused upload also loses its temp dir and (unless the site may already have
     * registered it) its R2 objects.
     */
    async remove(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job) return fail('The job no longer exists.');
        if (this.runtimes.has(id) || !(isFinalState(job.state) || isPausedUpload(job.state))) {
            return fail('Only finished or paused jobs can be removed.');
        }

        this.opts.store.update((draft) => {
            draft.jobs = draft.jobs.filter((j) => j.id !== id);
        });
        this.changed();

        if (isPausedUpload(job.state)) await this.discardPausedFiles(job);

        return OK;
    }

    clearFinished(): ActionResult {
        this.opts.store.update((draft) => {
            draft.jobs = draft.jobs.filter(
                (j) => this.runtimes.has(j.id) || !isFinalState(j.state),
            );
        });
        this.changed();

        return OK;
    }

    // ---- scheduling -----------------------------------------------------------------------

    /** Why nothing can start right now, or null. */
    private gate(): string | null {
        const block = this.opts.getStartBlock?.() ?? null;

        if (block !== null) return block;

        const auth = this.opts.getAuthState();

        switch (auth.status) {
            case 'signed_out':
                return 'Sign in to start processing.';
            case 'signing_in':
                return 'Signing in...';
            case 'offline':
                return 'Cannot reach the site. Reload the configuration to continue.';
            case 'signed_in':
                break;
        }

        // A signed_in state alone is not enough: the token and the config must both exist.
        if (this.opts.hasSession && !this.opts.hasSession()) return 'Sign in to start processing.';

        if (this.opts.getConfig() === null) return 'R2 storage is not configured on the site yet.';

        return null;
    }

    private waitingReason(): string | null {
        return (
            this.gate() ??
            (this.pipelineRuns() >= this.maxConcurrent()
                ? 'Waiting for other jobs to finish.'
                : null)
        );
    }

    /** Register retries are light and do not use a processing slot; pipeline and resume runs do. */
    private pipelineRuns(): number {
        return [...this.runtimes.values()].filter((r) => r.kind !== 'register').length;
    }

    private maxConcurrent(): number {
        const value = this.opts.store.get().settings.maxConcurrent;

        return Number.isInteger(value) ? Math.min(2, Math.max(1, value)) : 1;
    }

    private pump(): void {
        if (this.shuttingDown || this.gate() !== null) return;

        while (this.pipelineRuns() < this.maxConcurrent()) {
            const next = this.jobs().find((j) => j.state === 'waiting' && !this.runtimes.has(j.id));

            if (!next) break;

            this.start(next);
        }
    }

    private start(job: JobRecord): void {
        const config = this.opts.getConfig();

        if (config === null) return;

        if (job.mode === 'resume') {
            if (this.startResume(job, config)) return;
        }

        const id = job.id;
        const origin = this.currentOrigin();
        const publicId = this.opts.generatePublicId();
        const controller = new AbortController();
        const runtime = this.newRuntime(controller, 'pipeline', 'waiting');

        this.runtimes.set(id, runtime);
        this.patch(id, (j) => {
            j.state = 'transcoding';
            j.publicId = publicId;
            j.prefix = null;
            j.errorMessage = null;
            j.errorDetail = null;
            j.registerPayload = null;
            j.startedAt = this.iso();
            j.finishedAt = null;
            delete j.mode;
            delete j.tmpDir;
            delete j.registerStarted;

            if (origin === undefined) delete j.siteOrigin;
            else j.siteOrigin = origin;
        });
        this.opts.logger.info('Job started', { id });
        this.changed();

        runtime.done = this.opts
            .runPipelineFn({
                job: {
                    id,
                    sourcePath: job.sourcePath,
                    filename: basename(job.sourcePath),
                    publicId,
                },
                config,
                deps: this.opts.getDeps(),
                hooks: {
                    signal: controller.signal,
                    onStage: (stage) => this.onStage(id, stage),
                    onProgress: (percent) => this.onProgress(id, percent),
                    onPrefix: (prefix) => this.patch(id, (j) => void (j.prefix = prefix)),
                    // Durable before the first PutObject: a crash or a network stall can then
                    // be resumed from the persisted payload and temp dir.
                    onBeforeUpload: async (info) => {
                        this.patch(id, (j) => {
                            j.prefix = info.prefix;
                            j.tmpDir = info.tmpDir;
                            j.registerPayload = info.registerPayload;
                        });
                        await this.opts.store.flush();
                    },
                    onNetworkWait: (info) => this.onNetworkWait(id, info),
                    onNetworkRestored: () => this.onNetworkRestored(id),
                    onBeforeRegister: () => this.markRegisterStarted(id),
                },
            })
            .then(
                (result) => this.onDone(id, result),
                (error: unknown) => this.onFailure(id, error, runtime),
            )
            .finally(() => this.pump())
            .catch((error: unknown) =>
                this.opts.logger.error('Job bookkeeping failed', { id, error }),
            );
    }

    /**
     * Starts the resume of a `waiting` job with `mode: 'resume'`. Returns false when the job has
     * no stored upload data (it then runs as a fresh job).
     */
    private startResume(job: JobRecord, config: AppConfig): boolean {
        const payload = job.registerPayload;
        const publicId = job.publicId;

        if (!payload || publicId === null || !isValidPublicId(publicId)) {
            this.patch(job.id, (j) => void delete j.mode);

            return false;
        }

        const foreign = this.foreignOrigin(job);

        if (foreign !== null) {
            // The signed-in site changed while the resume was queued: never touch another site.
            this.patch(job.id, (j) => {
                j.state = 'upload_interrupted';
                j.errorMessage = otherSiteMessage(foreign);
                delete j.mode;
            });
            this.changed();

            return true;
        }

        const id = job.id;
        const deps = this.opts.getDeps();
        const controller = new AbortController();
        const runtime = this.newRuntime(controller, 'resume', 'upload_interrupted');

        this.runtimes.set(id, runtime);
        this.patch(id, (j) => {
            j.state = 'uploading';
            j.errorMessage = null;
            j.errorDetail = null;
            j.finishedAt = null;
            delete j.mode;
        });
        this.opts.logger.info('Upload resumed', { id });
        this.changed();

        runtime.done = this.opts
            .resumeUploadFn({
                job: { id, publicId },
                payload,
                tmpDir: join(deps.tmpRoot, publicId),
                config,
                deps,
                hooks: {
                    signal: controller.signal,
                    onStage: (stage) => this.onStage(id, stage),
                    onProgress: (percent) => this.onProgress(id, percent),
                    onNetworkWait: (info) => this.onNetworkWait(id, info),
                    onNetworkRestored: () => this.onNetworkRestored(id),
                    onBeforeRegister: () => this.markRegisterStarted(id),
                },
            })
            .then(
                (result) => this.onDone(id, result),
                (error: unknown) => this.onFailure(id, error, runtime),
            )
            .finally(() => this.pump())
            .catch((error: unknown) =>
                this.opts.logger.error('Job bookkeeping failed', { id, error }),
            );

        return true;
    }

    private onAuthChanged(state: AuthState): void {
        if (state.status === 'signed_in' && !this.shuttingDown) {
            for (const job of this.jobs()) {
                if (job.state === 'needs_sign_in' && !this.runtimes.has(job.id)) {
                    const foreign = this.foreignOrigin(job);

                    if (foreign === null) {
                        void this.retryRegister(job.id);
                    } else {
                        // Never register (or clean up) against a different site than the upload's.
                        this.noteForeignSite(job, foreign);
                    }
                }
            }
        }

        this.changed();
        this.pump();
    }

    // ---- pipeline callbacks ---------------------------------------------------------------

    private onStage(id: string, stage: JobState): void {
        const runtime = this.runtimes.get(id);

        // The network wait only exists while uploading.
        if (runtime && stage !== 'uploading') this.clearNetworkWait(runtime);

        this.patch(id, (j) => void (j.state = stage));
        this.changed(id);
    }

    private onProgress(id: string, percent: number): void {
        const runtime = this.runtimes.get(id);

        if (!runtime) return;

        runtime.progress = Math.max(runtime.progress, percent);
        this.emitThrottled(runtime);
    }

    /** At most `1000 / throttleMs` job events per second for one job. */
    private emitThrottled(runtime: Runtime): void {
        const now = this.opts.now().getTime();
        const wait = this.throttleMs - (now - runtime.lastEmitAt);

        if (wait <= 0) {
            runtime.lastEmitAt = now;
            this.emitJobs();
        } else if (runtime.trailing === null) {
            runtime.trailing = setTimeout(() => {
                runtime.trailing = null;
                runtime.lastEmitAt = this.opts.now().getTime();
                this.emitJobs();
            }, wait);
        }
    }

    private onNetworkWait(id: string, info: NetworkWaitInfo): void {
        const runtime = this.runtimes.get(id);

        if (!runtime) return;

        const started = !runtime.waitingForNetwork;

        runtime.waitingForNetwork = true;
        runtime.networkWaitSince = info.since;
        runtime.nextRetryAt = this.opts.now().getTime() + info.nextRetryInMs;

        // Entering the wait is a visible state change; later notifications are only refreshes.
        if (started) this.changed(id);
        else this.emitThrottled(runtime);
    }

    private onNetworkRestored(id: string): void {
        const runtime = this.runtimes.get(id);

        if (!runtime || !runtime.waitingForNetwork) return;

        this.clearNetworkWait(runtime);
        this.changed(id);
    }

    private clearNetworkWait(runtime: Runtime): void {
        runtime.waitingForNetwork = false;
        runtime.networkWaitSince = null;
        runtime.nextRetryAt = null;
    }

    /** Persists (durably) that the site may register this video from now on. */
    private async markRegisterStarted(id: string): Promise<void> {
        this.patch(id, (j) => void (j.registerStarted = true));
        await this.opts.store.flush();
    }

    private onDone(id: string, result: PipelineResult): void {
        this.releaseRuntime(id);
        this.opts.store.update((draft) => {
            const job = draft.jobs.find((j) => j.id === id);

            if (job) {
                job.state = 'done';
                job.registered = result.registered;
                job.prefix = result.prefix;
                job.publicId = result.registered.public_id;
                job.registerPayload = null;
                delete job.tmpDir;
                delete job.registerStarted;
                delete job.mode;
                job.errorMessage = null;
                job.errorDetail = null;
                job.finishedAt = this.iso();
                job.updatedAt = this.iso();
            }

            draft.jobs = capHistory(draft.jobs);
        });
        this.opts.logger.info('Job done', { id });
        this.changed();
    }

    private async onFailure(id: string, error: unknown, runtime: Runtime): Promise<void> {
        const job = this.getJob(id);
        const failure =
            error instanceof PipelineError
                ? error
                : new PipelineError({
                      kind: 'failed',
                      step: job?.state ?? 'waiting',
                      message: 'An unexpected error occurred.',
                      cause: error,
                  });

        if (!(error instanceof PipelineError)) {
            this.opts.logger.error('Job failed unexpectedly', { id, error });
        }

        this.releaseRuntime(id);

        if (failure.kind === 'cancelled' && runtime.kind === 'register') {
            // Cancelling a register retry only stops that attempt; the uploaded files stay.
            this.patch(id, (j) => {
                j.state = runtime.previousState;
                j.errorMessage = 'Registering was cancelled. Use Retry to finish.';
            });
            this.changed();

            return;
        }

        if (failure.kind === 'upload_interrupted') {
            const payload = failure.registerPayload;

            if (failure.resumable && payload !== undefined && failure.tmpDir !== null) {
                // Keep everything (R2 objects, temp dir, payload): the user can resume later.
                const tmpDir = failure.tmpDir;
                const message = redact(failure.message);

                this.patch(id, (j) => {
                    j.state = 'upload_interrupted';
                    j.errorMessage = message;
                    j.errorDetail = { step: 'uploading', exitCode: null, stderrTail: [] };
                    j.registerPayload = payload;
                    j.tmpDir = tmpDir;
                    j.finishedAt = null;
                    delete j.mode;

                    if (failure.prefix !== null) j.prefix = failure.prefix;
                });
                this.opts.logger.info('Upload paused', { id });
                this.changed();

                return;
            }

            this.opts.logger.error('Upload stopped but cannot be resumed.', { id });
        }

        if (runtime.kind === 'resume' && failure.code === RESUME_UNAVAILABLE && job) {
            // The kept temp files are gone (or the temp folder changed): process the video again.
            const prefix = job.prefix ?? failure.prefix ?? null;

            this.opts.logger.warn('Cannot resume the upload; starting over with a new video ID.', {
                id,
            });
            await this.restartFresh(job, job.registerStarted === true ? null : prefix);

            return;
        }

        const kind = failure.kind === 'upload_interrupted' ? 'failed' : failure.kind;
        const stderrTail = failure.stderrTail.map((line) => redact(line));
        const message = redact(failure.message);

        this.patch(id, (j) => {
            j.state = kind;
            j.errorMessage = message;
            j.errorDetail = { step: failure.step, exitCode: failure.exitCode, stderrTail };
            j.registerPayload =
                kind === 'register_failed' || kind === 'needs_sign_in'
                    ? (failure.registerPayload ?? j.registerPayload ?? null)
                    : null;
            // The pipeline removed its temp dir on every outcome except a paused upload.
            delete j.tmpDir;
            delete j.mode;

            if (failure.prefix !== null) j.prefix = failure.prefix;

            j.finishedAt = this.iso();
        });
        this.opts.logger.info('Job ended', { id, kind });
        this.changed();

        // Resume runs and unresumable pauses can leave a temp dir the pipeline did not remove.
        if (
            (kind === 'failed' || kind === 'cancelled') &&
            (runtime.kind === 'resume' || failure.kind === 'upload_interrupted') &&
            job?.publicId
        ) {
            await this.removeTmpDir(job.publicId);
        }

        // A definitive register rejection (known server code) during a register retry: the files
        // are useless. Any other failure keeps them.
        if (
            kind === 'failed' &&
            failure.definitive &&
            runtime.kind === 'register' &&
            failure.prefix !== null
        ) {
            await this.cleanupPrefix(failure.prefix, job?.siteOrigin);
        }
    }

    // ---- helpers --------------------------------------------------------------------------

    private jobs(): JobRecord[] {
        return this.opts.store.get().jobs;
    }

    private iso(): string {
        return this.opts.now().toISOString();
    }

    private newRuntime(
        controller: AbortController,
        kind: Runtime['kind'],
        previousState: JobState,
    ): Runtime {
        return {
            controller,
            kind,
            previousState,
            progress: 0,
            waitingForNetwork: false,
            networkWaitSince: null,
            nextRetryAt: null,
            lastEmitAt: this.opts.now().getTime(),
            trailing: null,
            done: Promise.resolve(),
        };
    }

    private releaseRuntime(id: string): void {
        const runtime = this.runtimes.get(id);

        if (runtime?.trailing) clearTimeout(runtime.trailing);

        this.runtimes.delete(id);
    }

    /** Persisted state change (a transition, never a progress tick). */
    private patch(id: string, mutate: (job: JobRecord) => void): void {
        this.opts.store.update((draft) => {
            const job = draft.jobs.find((j) => j.id === id);

            if (!job) return;

            mutate(job);
            job.updatedAt = this.iso();
        });
    }

    private dtoOf(job: JobRecord, reason: string | null): JobDto {
        const runtime = this.runtimes.get(job.id);
        const info: JobRuntimeInfo = {
            running: runtime !== undefined,
            cancelRequested: runtime?.controller.signal.aborted ?? false,
            progress: runtime?.progress ?? null,
            waitingReason: reason,
            waitingForNetwork: runtime?.waitingForNetwork ?? false,
            networkWaitSince: runtime?.networkWaitSince ?? null,
        };

        return toJobDto(job, info);
    }

    /** Immediate emit (state changes). Resets the progress throttle of `id`. */
    private changed(id?: string): void {
        const runtime = id === undefined ? undefined : this.runtimes.get(id);

        if (runtime) {
            if (runtime.trailing) clearTimeout(runtime.trailing);

            runtime.trailing = null;
            runtime.lastEmitAt = this.opts.now().getTime();
        }

        this.emitJobs();
        this.emitSummary();
    }

    private emitJobs(): void {
        if (this.jobListeners.size === 0) return;

        const snapshot = this.list();

        for (const listener of [...this.jobListeners]) this.safe(() => listener(snapshot));
    }

    private emitSummary(): void {
        if (this.summaryListeners.size === 0) return;

        const summary = this.summary();
        const json = JSON.stringify(summary);

        if (json === this.lastSummaryJson) return;

        this.lastSummaryJson = json;

        for (const listener of [...this.summaryListeners]) this.safe(() => listener(summary));
    }

    private safe(fn: () => void): void {
        try {
            fn();
        } catch (error) {
            this.opts.logger.error('Queue listener failed', { error });
        }
    }

    /** Origin of the signed-in site (RAM state), or undefined when unknown. */
    private currentOrigin(): string | undefined {
        return this.opts.getAuthState().siteUrl;
    }

    /**
     * The origin the job was uploaded for when it differs from the signed-in site, else null.
     * Records without an origin (older versions) are not bound to a site.
     */
    private foreignOrigin(job: JobRecord): string | null {
        const origin = job.siteOrigin;

        if (origin === undefined) return null;

        return origin === this.currentOrigin() ? null : origin;
    }

    private noteForeignSite(job: JobRecord, origin: string): void {
        const message = otherSiteMessage(origin);

        if (job.errorMessage === message) return;

        this.patch(job.id, (j) => void (j.errorMessage = message));
        this.changed(job.id);
    }

    private async cleanupPrefix(prefix: string, jobOrigin?: string): Promise<void> {
        if (jobOrigin !== undefined && jobOrigin !== this.currentOrigin()) {
            this.opts.logger.warn('Skipped R2 cleanup: the files belong to a different site.');

            return;
        }

        const config = this.opts.getConfig();

        if (config === null) {
            this.opts.logger.warn('Cannot clean up R2 files: no site config is loaded.');

            return;
        }

        const client = this.opts.getDeps().createS3Client(config.r2, 'cleanup');

        try {
            await this.opts.deletePrefixFn(client, config.r2.bucket, prefix, this.opts.logger);
        } catch (error) {
            this.opts.logger.warn('R2 cleanup failed', { error });
        } finally {
            client.destroy();
        }
    }

    /** Deletes the temp dir and, when the site cannot have registered it, the R2 objects. */
    private async discardPausedFiles(job: JobRecord): Promise<void> {
        const prefix = job.prefix ?? job.registerPayload?.disk_prefix ?? null;

        if (prefix !== null) {
            if (job.registerStarted === true) {
                this.opts.logger.warn(
                    'Kept the R2 files of a paused upload: the site may have registered it.',
                    { prefix },
                );
            } else {
                await this.cleanupPrefix(prefix, job.siteOrigin);
            }
        }

        if (job.publicId !== null) await this.removeTmpDir(job.publicId);
    }

    private async removeTmpDir(publicId: string): Promise<void> {
        if (!isValidPublicId(publicId)) return;

        try {
            await this.opts.fs.rm(join(this.opts.getDeps().tmpRoot, publicId));
        } catch (error) {
            this.opts.logger.warn('Could not remove a temp directory', { error });
        }
    }
}
