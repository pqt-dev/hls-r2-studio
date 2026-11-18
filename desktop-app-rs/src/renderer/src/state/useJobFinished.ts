import { useEffect, useRef } from 'react';
import type { JobState } from '../../../shared/types';
import { useApp } from './AppProvider';

/**
 * Calls `onFinished` when a job newly becomes `done` (it just added a video to the site). The
 * first snapshot after mount is only the baseline, so jobs that were already done do not count.
 * The latest callback is always used; the subscription is made once per API object.
 */
export function useJobFinished(onFinished: () => void): void {
    const { api } = useApp();
    const latest = useRef(onFinished);

    latest.current = onFinished;

    useEffect(() => {
        let previous: Map<string, JobState> | null = null;

        return api.jobs.onUpdated((jobs) => {
            const finished =
                previous !== null &&
                jobs.some((job) => job.state === 'done' && previous?.get(job.id) !== 'done');

            previous = new Map(jobs.map((job) => [job.id, job.state]));

            if (finished) latest.current();
        });
    }, [api]);
}
