import { describe, expect, it } from 'vitest';
import type { JobRecord, JobState } from '../../shared/types';
import { capHistory } from './history';

function job(id: string, state: JobState): JobRecord {
    return {
        id,
        sourcePath: `/v/${id}.mp4`,
        sizeBytes: 1,
        state,
        publicId: null,
        prefix: null,
        errorMessage: null,
        errorDetail: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        registered: null,
    };
}

describe('capHistory', () => {
    it('keeps everything under the cap', () => {
        const jobs = [job('a', 'done'), job('b', 'failed')];
        expect(capHistory(jobs, 5)).toEqual(jobs);
    });

    it('drops the oldest done jobs beyond the cap and keeps order', () => {
        const jobs = [job('1', 'done'), job('2', 'done'), job('3', 'done'), job('4', 'done')];
        expect(capHistory(jobs, 2).map((j) => j.id)).toEqual(['3', '4']);
    });

    it('never drops non-done jobs', () => {
        const jobs = [
            job('1', 'done'),
            job('2', 'failed'),
            job('3', 'waiting'),
            job('4', 'done'),
            job('5', 'transcoding'),
        ];
        expect(capHistory(jobs, 1).map((j) => j.id)).toEqual(['2', '3', '4', '5']);
    });

    it('defaults to 200 done entries', () => {
        const jobs = Array.from({ length: 250 }, (_, i) => job(String(i), 'done'));
        const capped = capHistory(jobs);
        expect(capped).toHaveLength(200);
        expect(capped[0]?.id).toBe('50');
    });

    it('does not mutate the input', () => {
        const jobs = [job('1', 'done'), job('2', 'done')];
        capHistory(jobs, 1);
        expect(jobs).toHaveLength(2);
    });
});
