import type { JobDto } from '../../../shared/ipc';
import type { JobState } from '../../../shared/types';

/** Visual/semantic group of a job state. Mirrors the groups of the main process. */
export type StatusKind = 'waiting' | 'running' | 'done' | 'failed' | 'attention' | 'cancelled';

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

/** States that offer the "View details" dialog. */
export function hasDetailsView(state: JobState): boolean {
    return state === 'failed' || state === 'register_failed' || state === 'interrupted';
}

/** Glyphs shown next to the status text so the state is never conveyed by color alone. */
export const STATUS_ICON: Record<StatusKind, string> = {
    waiting: '○',
    running: '▶',
    done: '✓',
    failed: '✕',
    attention: '!',
    cancelled: '–',
};
