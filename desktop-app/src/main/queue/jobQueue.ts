/** Job queue and state machine over the AppStore (spec 4.3 / 4.4 / 4.5). No Electron imports. */
import type { S3Client } from '@aws-sdk/client-s3';
import { basename, join } from 'node:path';
import type { AppConfig } from '../../shared/appConfig';
import type { ActionResult, AuthState, JobDto, QueueSummary, RejectedFile } from '../../shared/ipc';
import type { JobRecord, JobState } from '../../shared/types';
import type { Logger } from '../logger';
import { redact } from '../logger';
import type { PipelineDeps } from '../pipeline/deps';
import { PipelineError, type PipelineErrorKind } from '../pipeline/errors';
import { isValidPublicId } from '../pipeline/publicId';
import type { PipelineResult, retryRegister, runPipeline } from '../pipeline/runPipeline';
import type { AppStore } from '../store';
import { capHistory } from '../store';
import { validateVideoPath, pathKey, type FileStat } from './fileValidation';
import { toJobDto, type JobRuntimeInfo } from './jobDto';
import { isAttentionState, isFinalState, isRunningState, RETRYABLE_STATES } from './jobStates';

export type RunPipelineFn = typeof runPipeline;
export type RetryRegisterFn = typeof retryRegister;
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
    kind: 'pipeline' | 'register';
    /** State to return to when a register retry is cancelled. */
    previousState: JobState;
    progress: number;
    lastEmitAt: number;
    trailing: ReturnType<typeof setTimeout> | null;
    done: Promise<void>;
}

const INTERRUPTED_MESSAGE =
    'The app was closed while this job was running. Use Retry to start it again.';
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

    summary(): QueueSummary {
        const jobs = this.jobs();
        const count = (pred: (job: JobRecord) => boolean): number => jobs.filter(pred).length;
        const waiting = count((j) => j.state === 'waiting' && !this.runtimes.has(j.id));

        return {
            running: this.runtimes.size,
            waiting,
            attention: count((j) => isAttentionState(j.state)),
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

    /** Startup recovery: running jobs become `interrupted` and their temp dirs are removed. */
    async recover(): Promise<void> {
        const orphans: string[] = [];
        const nowIso = this.iso();

        this.opts.store.update((draft) => {
            for (const job of draft.jobs) {
                if (!isRunningState(job.state)) continue;

                job.errorDetail = { step: job.state, exitCode: null, stderrTail: [] };
                job.state = 'interrupted';
                job.errorMessage = INTERRUPTED_MESSAGE;
                job.finishedAt = nowIso;
                job.updatedAt = nowIso;
                if (isValidPublicId(job.publicId)) orphans.push(job.publicId);
            }
        });

        for (const publicId of orphans) await this.removeTmpDir(publicId);

        if (orphans.length > 0)
            this.opts.logger.info('Recovered interrupted jobs', { count: orphans.length });

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
            this.patch(id, (j) => {
                j.state = 'cancelled';
                j.errorMessage = 'The job was cancelled.';
                j.errorDetail = null;
                j.finishedAt = this.iso();
            });
            this.changed();

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

    /** Re-runs a failed/cancelled/interrupted job from scratch with a NEW public id. */
    async retry(id: string): Promise<ActionResult> {
        const job = this.getJob(id);

        if (!job || this.runtimes.has(id)) return fail('The job no longer exists.');
        if (!RETRYABLE_STATES.includes(job.state)) return fail('This job cannot be retried.');

        // Only partial uploads of failed/cancelled jobs are certainly unregistered (the pipeline
        // already tried to delete them). An `interrupted` job was cut off at an unknown point: the
        // persisted step may lag behind a register request that did reach the site, so its files
        // are NEVER deleted automatically.
        const stalePrefix =
            job.prefix !== null &&
            job.state !== 'interrupted' &&
            job.errorDetail?.step === 'uploading'
                ? job.prefix
                : null;
        const staleOrigin = job.siteOrigin;
        const staleId = job.publicId;

        if (job.state === 'interrupted' && job.prefix !== null) {
            this.opts.logger.warn(
                'Retrying an interrupted job; its R2 files were kept and may be orphaned.',
                { prefix: job.prefix, siteOrigin: job.siteOrigin ?? null },
            );
        }

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
        });
        this.changed();

        if (stalePrefix !== null) await this.cleanupPrefix(stalePrefix, staleOrigin);
        if (staleId !== null) await this.removeTmpDir(staleId);

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
                    onBeforeRegister: () => this.opts.store.flush(),
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

    /** Removes a finished job (done, failed, cancelled, interrupted) from the list. */
    remove(id: string): ActionResult {
        const job = this.getJob(id);

        if (!job) return fail('The job no longer exists.');
        if (this.runtimes.has(id) || !isFinalState(job.state)) {
            return fail('Only finished jobs can be removed.');
        }

        this.opts.store.update((draft) => {
            draft.jobs = draft.jobs.filter((j) => j.id !== id);
        });
        this.changed();

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

    /** Register retries are light and do not use a processing slot. */
    private pipelineRuns(): number {
        return [...this.runtimes.values()].filter((r) => r.kind === 'pipeline').length;
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
                    onBeforeRegister: () => this.opts.store.flush(),
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
        this.patch(id, (j) => void (j.state = stage));
        this.changed(id);
    }

    private onProgress(id: string, percent: number): void {
        const runtime = this.runtimes.get(id);

        if (!runtime) return;

        runtime.progress = Math.max(runtime.progress, percent);

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

        const kind: PipelineErrorKind = failure.kind;
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

            if (failure.prefix !== null) j.prefix = failure.prefix;

            j.finishedAt = this.iso();
        });
        this.opts.logger.info('Job ended', { id, kind });
        this.changed();

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

    private async removeTmpDir(publicId: string): Promise<void> {
        if (!isValidPublicId(publicId)) return;

        try {
            await this.opts.fs.rm(join(this.opts.getDeps().tmpRoot, publicId));
        } catch (error) {
            this.opts.logger.warn('Could not remove a temp directory', { error });
        }
    }
}
