import type { JobRecord } from '../../shared/types';

export const MAX_DONE_HISTORY = 200;

/**
 * Keeps every job that is not `done` and at most `max` of the most recent `done` jobs
 * (the array is in creation order, oldest first). Order is preserved.
 */
export function capHistory(jobs: readonly JobRecord[], max = MAX_DONE_HISTORY): JobRecord[] {
    let doneSeen = 0;
    const keep = new Array<boolean>(jobs.length).fill(true);
    for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i]?.state === 'done') {
            doneSeen++;
            if (doneSeen > max) keep[i] = false;
        }
    }
    return jobs.filter((_, i) => keep[i]);
}
