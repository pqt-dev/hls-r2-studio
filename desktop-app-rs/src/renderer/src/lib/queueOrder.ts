import type { JobDto } from '../../../shared/ipc';
import type { JobState } from '../../../shared/types';

/**
 * Queue display order (the renderer only sorts; storage order is untouched):
 *   1. actively running: transcoding, thumbnail, storyboard, uploading, registering
 *   2. needs attention (always open, the user can act): upload_interrupted, register_failed,
 *      needs_sign_in
 *   3. waiting
 *   4. finished, last: done, cancelled, failed, interrupted
 * Inside a group the newest job comes first (`createdAt` descending, then `id` descending).
 * Jobs that tie on all of that keep their incoming order, so the result is always stable.
 */
const GROUP: Record<JobState, number> = {
    transcoding: 1,
    thumbnail: 1,
    storyboard: 1,
    uploading: 1,
    registering: 1,
    failed: 4,
    interrupted: 4,
    upload_interrupted: 2,
    register_failed: 2,
    needs_sign_in: 2,
    waiting: 3,
    done: 4,
    cancelled: 4,
};

export const QUEUE_GROUP_RUNNING = 1;
export const QUEUE_GROUP_ATTENTION = 2;
export const QUEUE_GROUP_WAITING = 3;
export const QUEUE_GROUP_FINISHED = 4;

/** The finished group is collapsed by default when it holds more jobs than this. */
export const FINISHED_COLLAPSE_THRESHOLD = 20;

export function queueGroup(state: JobState): number {
    return GROUP[state];
}

function time(iso: string): number {
    const value = Date.parse(iso);

    return Number.isNaN(value) ? 0 : value;
}

/** Returns a new array; the input is not modified. */
export function sortJobsForQueue(jobs: readonly JobDto[]): JobDto[] {
    return jobs
        .map((job, index) => ({ job, index }))
        .sort((a, b) => {
            const group = GROUP[a.job.state] - GROUP[b.job.state];

            if (group !== 0) return group;

            const created = time(b.job.createdAt) - time(a.job.createdAt);

            if (created !== 0) return created;

            if (a.job.id !== b.job.id) return a.job.id < b.job.id ? 1 : -1;

            return a.index - b.index;
        })
        .map((entry) => entry.job);
}

/** Jobs the Home "needs attention" card counts: the attention group plus failed/interrupted ones. */
export function needsAttention(state: JobState): boolean {
    return GROUP[state] === QUEUE_GROUP_ATTENTION || state === 'failed' || state === 'interrupted';
}
