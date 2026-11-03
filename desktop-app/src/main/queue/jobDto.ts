/** Maps a stored job to the renderer-visible DTO (no paths, payloads or secrets). */
import { basename } from 'node:path';
import type { JobDto } from '../../shared/ipc';
import type { JobRecord } from '../../shared/types';
import { isAttentionState, isFinalState, RETRYABLE_STATES, STAGE_KEYS } from './jobStates';

export interface JobRuntimeInfo {
    /** A pipeline or register call is in flight for this job. */
    running: boolean;
    cancelRequested: boolean;
    /** Latest overall progress (RAM only), or null when unknown. */
    progress: number | null;
    waitingReason: string | null;
}

export const NO_RUNTIME: JobRuntimeInfo = {
    running: false,
    cancelRequested: false,
    progress: null,
    waitingReason: null,
};

/** Progress shown for jobs that have no live value (e.g. after a restart). */
function fallbackProgress(job: JobRecord): number {
    if (job.state === 'done') return 100;
    if (isAttentionState(job.state)) return 98;

    return 0;
}

export function toJobDto(job: JobRecord, runtime: JobRuntimeInfo = NO_RUNTIME): JobDto {
    const running = runtime.running;
    const progress = job.state === 'done' ? 100 : (runtime.progress ?? fallbackProgress(job));

    return {
        id: job.id,
        fileName: basename(job.sourcePath),
        sizeBytes: job.sizeBytes,
        state: job.state,
        stageKey: STAGE_KEYS[job.state],
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        waitingReason: job.state === 'waiting' && !running ? runtime.waitingReason : null,
        errorMessage: job.errorMessage,
        errorDetail: job.errorDetail,
        publicId: job.state === 'done' ? (job.registered?.public_id ?? job.publicId) : job.publicId,
        embedUrl: job.registered?.embed_url ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        canCancel:
            !runtime.cancelRequested &&
            (running || job.state === 'waiting' || isAttentionState(job.state)),
        canRetry: !running && RETRYABLE_STATES.includes(job.state),
        canRetryRegister: !running && isAttentionState(job.state) && Boolean(job.registerPayload),
        canRemove: !running && isFinalState(job.state),
    };
}
