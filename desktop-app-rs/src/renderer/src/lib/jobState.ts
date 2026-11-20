import type { JobDto } from '../../../shared/ipc';
import type { JobState } from '../../../shared/types';
import type { FluentName } from '../components/fluentIcons';

/** Visual/semantic group of a job state. Mirrors the groups of the main process. */
export type StatusKind =
    'waiting' | 'running' | 'done' | 'failed' | 'attention' | 'paused' | 'cancelled';

const KIND: Record<JobState, StatusKind> = {
    waiting: 'waiting',
    transcoding: 'running',
    thumbnail: 'running',
    storyboard: 'running',
    uploading: 'running',
    registering: 'running',
    done: 'done',
    failed: 'failed',
    interrupted: 'failed',
    cancelled: 'cancelled',
    register_failed: 'attention',
    needs_sign_in: 'attention',
    upload_interrupted: 'paused',
};

export function statusKind(state: JobState): StatusKind {
    return KIND[state];
}

export function isRunning(job: Pick<JobDto, 'state'>): boolean {
    return KIND[job.state] === 'running';
}

/** States that "Clear finished" removes (same set as the main process). */
export function isFinished(state: JobState): boolean {
    return (
        state === 'done' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
    );
}

/**
 * Solid (filled) Fluent icon shown next to the status text so the state is never color only. All
 * but `attention` belong to the same circle family: clock, sync, check, dismiss, pause, subtract.
 */
export const STATUS_ICON: Record<StatusKind, FluentName> = {
    waiting: 'clock',
    running: 'statProcessing',
    done: 'success',
    failed: 'failure',
    attention: 'warning',
    paused: 'pauseCircle',
    cancelled: 'cancelled',
};
