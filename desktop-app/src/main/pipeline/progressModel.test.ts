import { describe, expect, it } from 'vitest';
import { STAGE_ORDER, STAGE_WEIGHTS, overallProgress } from './progressModel';

describe('overallProgress', () => {
    it('weights sum to 100', () => {
        expect(STAGE_ORDER.reduce((sum, s) => sum + STAGE_WEIGHTS[s], 0)).toBe(100);
    });

    it.each([
        ['transcoding', 0, 0],
        ['transcoding', 0.5, 35],
        ['transcoding', 1, 70],
        ['thumbnail', 0, 70],
        ['thumbnail', 1, 73],
        ['storyboard', 0, 73],
        ['storyboard', 1, 80],
        ['upload', 0, 80],
        ['upload', 0.5, 89],
        ['upload', 1, 98],
        ['register', 0, 98],
        ['register', 0.5, 99],
        ['register', 1, 100],
    ] as const)('%s at %d = %d', (stage, fraction, expected) => {
        expect(overallProgress(stage, fraction, 0)).toBe(expected);
    });

    it('floors, so 100 is only reached when register is complete', () => {
        expect(overallProgress('register', 0.99, 0)).toBe(99);
        expect(overallProgress('transcoding', 0.999, 0)).toBe(69);
    });

    it('never decreases', () => {
        expect(overallProgress('transcoding', 0.1, 50)).toBe(50);
        expect(overallProgress('upload', 0.2, 60)).toBe(83);
    });

    it('clamps and sanitizes the stage fraction', () => {
        expect(overallProgress('transcoding', 5, 0)).toBe(70);
        expect(overallProgress('transcoding', -1, 0)).toBe(0);
        expect(overallProgress('transcoding', Number.NaN, 10)).toBe(10);
    });

    it('defaults previous to 0', () => {
        expect(overallProgress('thumbnail', 0)).toBe(70);
    });

    it('is monotonic over a simulated run', () => {
        let previous = 0;

        for (const stage of STAGE_ORDER) {
            for (let i = 0; i <= 20; i++) {
                const next = overallProgress(stage, i / 20, previous);

                expect(next).toBeGreaterThanOrEqual(previous);
                previous = next;
            }
        }

        expect(previous).toBe(100);
    });
});
