import { describe, expect, it } from 'vitest';
import type { JobState } from '../../../shared/types';
import { makeJob } from '../testing/fakeApi';
import { queueGroup, sortJobsForQueue } from './queueOrder';

const job = (id: string, state: JobState, createdAt = '2026-01-01T10:00:00.000Z') =>
    makeJob({ id, state, createdAt });

const ids = (jobs: ReturnType<typeof sortJobsForQueue>) => jobs.map((item) => item.id);

describe('queueGroup', () => {
    it.each<[JobState, number]>([
        ['transcoding', 1],
        ['thumbnail', 1],
        ['storyboard', 1],
        ['uploading', 1],
        ['registering', 1],
        ['failed', 4],
        ['interrupted', 4],
        ['upload_interrupted', 2],
        ['register_failed', 2],
        ['needs_sign_in', 2],
        ['waiting', 3],
        ['done', 4],
        ['cancelled', 4],
    ])('puts %s in group %i', (state, group) => {
        expect(queueGroup(state)).toBe(group);
    });
});

describe('sortJobsForQueue', () => {
    it('orders running, needs attention, waiting, finished', () => {
        const sorted = sortJobsForQueue([
            job('done', 'done'),
            job('wait', 'waiting'),
            job('fail', 'failed'),
            job('run', 'uploading'),
            job('cancel', 'cancelled'),
        ]);

        // `done` and `cancel` share a group and a time: the larger id comes first.
        expect(ids(sorted)).toEqual(['run', 'wait', 'fail', 'done', 'cancel']);
    });

    it('keeps every state of a group together, newest first', () => {
        const sorted = sortJobsForQueue([
            job('a', 'registering', '2026-01-01T10:00:01.000Z'),
            job('b', 'transcoding', '2026-01-01T10:00:05.000Z'),
            job('c', 'storyboard', '2026-01-01T10:00:03.000Z'),
            job('d', 'needs_sign_in', '2026-01-01T10:00:02.000Z'),
            job('e', 'upload_interrupted', '2026-01-01T10:00:04.000Z'),
            job('f', 'interrupted', '2026-01-01T10:00:01.000Z'),
            job('g', 'register_failed', '2026-01-01T10:00:06.000Z'),
        ]);

        // f (interrupted) is finished, so it comes last.
        expect(ids(sorted)).toEqual(['b', 'c', 'a', 'g', 'e', 'd', 'f']);
    });

    it('never lets a finished job jump above live work in a 1000-job list', () => {
        const finished = Array.from({ length: 1000 }, (_, i) =>
            job(
                `f${i}`,
                i % 3 === 0 ? 'failed' : 'done',
                `2026-02-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
            ),
        );
        const live = [
            job('r', 'uploading', '2026-01-01T00:00:00.000Z'),
            job('w', 'waiting', '2026-01-01T00:00:00.000Z'),
        ];
        const sorted = sortJobsForQueue([...finished, ...live]);

        expect(ids(sorted).slice(0, 2)).toEqual(['r', 'w']);
        expect(sorted).toHaveLength(1002);
    });

    it('puts a newer job before an older one in the same group', () => {
        const sorted = sortJobsForQueue([
            job('old', 'waiting', '2026-01-01T10:00:00.000Z'),
            job('new', 'waiting', '2026-01-02T10:00:00.000Z'),
        ]);

        expect(ids(sorted)).toEqual(['new', 'old']);
    });

    it('breaks a createdAt tie by id, descending', () => {
        const sorted = sortJobsForQueue([
            job('job-1', 'done'),
            job('job-3', 'done'),
            job('job-2', 'done'),
        ]);

        expect(ids(sorted)).toEqual(['job-3', 'job-2', 'job-1']);
    });

    it('is stable for fully equal keys', () => {
        const first = job('same', 'waiting');
        const second = { ...job('same', 'waiting'), fileName: 'second.mp4' };
        const sorted = sortJobsForQueue([first, second]);

        expect(sorted[0]).toBe(first);
        expect(sorted[1]).toBe(second);
    });

    it('is deterministic whatever the input order', () => {
        const list = [
            job('a', 'done', '2026-01-03T00:00:00.000Z'),
            job('b', 'waiting', '2026-01-02T00:00:00.000Z'),
            job('c', 'transcoding', '2026-01-01T00:00:00.000Z'),
            job('d', 'failed', '2026-01-04T00:00:00.000Z'),
        ];

        expect(ids(sortJobsForQueue([...list].reverse()))).toEqual(ids(sortJobsForQueue(list)));
    });

    it('does not modify its input and handles an empty list', () => {
        const list = [job('a', 'done'), job('b', 'transcoding')];
        const copy = [...list];

        sortJobsForQueue(list);
        expect(list).toEqual(copy);
        expect(sortJobsForQueue([])).toEqual([]);
    });
});
