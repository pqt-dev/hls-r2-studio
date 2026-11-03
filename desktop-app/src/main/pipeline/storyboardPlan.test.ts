import { describe, expect, it } from 'vitest';
import {
    assignSlots,
    candidateTimestamp,
    gridPixelSize,
    storyboardJson,
    TOTAL_CANDIDATES,
    tileFileNames,
} from './storyboardPlan';
import type { ScoredFrame } from './thumbnailPlan';

interface Candidate extends ScoredFrame {
    id: number;
}

function makeCandidates(
    duration: number,
    scores: (index: number) => [number | null, number | null],
): Candidate[] {
    return Array.from({ length: TOTAL_CANDIDATES }, (_, id) => {
        const [saturation, detail] = scores(id);

        return { id, timestamp: candidateTimestamp(id, duration), saturation, detail };
    });
}

describe('constants and names', () => {
    it('extracts 75 candidates', () => {
        expect(TOTAL_CANDIDATES).toBe(75);
    });

    it('spaces candidates evenly over the duration', () => {
        expect(candidateTimestamp(0, 150)).toBe(0);
        expect(candidateTimestamp(1, 150)).toBe(2);
        expect(candidateTimestamp(74, 150)).toBeCloseTo(148, 10);
    });

    it('computes grid pixel sizes', () => {
        expect([3, 4, 5].map(gridPixelSize)).toEqual([480, 640, 800]);
    });

    it('lists tile names in slot order', () => {
        const names = tileFileNames(3);

        expect(names).toHaveLength(9);
        expect(names[0]).toBe('tile_3x3_0000.jpg');
        expect(names[8]).toBe('tile_3x3_0008.jpg');
        expect(tileFileNames(5)[24]).toBe('tile_5x5_0024.jpg');
    });
});

describe('assignSlots', () => {
    it('gives every slot of a 5x5 grid its own 3 candidates and picks the best of each', () => {
        const duration = 150;
        // Within each group of 3 consecutive candidates the middle one is the best.
        const candidates = makeCandidates(duration, (i) => (i % 3 === 1 ? [30, 10] : [10, 4]));
        const chosen = assignSlots(5, candidates, duration);

        expect(chosen.map((c) => c.id)).toEqual(
            Array.from({ length: 25 }, (_, slot) => slot * 3 + 1),
        );
    });

    it('prefers a passing candidate over a higher-ranked removed one', () => {
        const duration = 150;
        // Slot 0 of a 3x3 grid has candidates 0..7 (75 / 9 = 8.33 per slot).
        const candidates = makeCandidates(duration, (i) => {
            if (i === 2) return [100, 1]; // detail < 3 -> removed, but a huge rank (105)
            if (i === 4) return [10, 4]; // passing, rank 30
            return [null, null];
        });
        const chosen = assignSlots(3, candidates, duration);

        expect(chosen[0]?.id).toBe(4);
    });

    it('uses the best overall candidate when none of the slot passes', () => {
        const duration = 90;
        const candidates = makeCandidates(duration, (i) => (i === 3 ? [4, 10] : [null, null]));
        const chosen = assignSlots(3, candidates, duration);

        expect(chosen[0]?.id).toBe(3);
    });

    it('keeps the earliest candidate on rank ties', () => {
        const duration = 90;
        const candidates = makeCandidates(duration, () => [10, 4]);
        const chosen = assignSlots(3, candidates, duration);

        expect(chosen.map((c) => c.id)).toEqual([0, 9, 17, 25, 34, 42, 50, 59, 67]);
    });

    it('fills an empty slot from the nearest genuine slot, earlier side first on distance ties', () => {
        const duration = 90; // 3x3: slot length 10 s
        const only = (ts: number, id: number): Candidate => ({
            id,
            timestamp: ts,
            saturation: 10,
            detail: 4,
        });
        // Slots 1 (ts 15) and 5 (ts 55) have candidates; everything else is empty.
        const chosen = assignSlots(3, [only(15, 1), only(55, 5)], duration);

        // slot 0 -> nearest is 1; slot 2 -> distance 1 on both sides? 1 (left, d=1) wins over 3 (empty).
        expect(chosen.map((c) => c.id)).toEqual([1, 1, 1, 1, 5, 5, 5, 5, 5]);
    });

    it('prefers the earlier slot when two filled slots are equally near', () => {
        const duration = 90;
        const only = (ts: number, id: number): Candidate => ({
            id,
            timestamp: ts,
            saturation: 10,
            detail: 4,
        });
        // Slots 0 and 2 filled, slot 1 empty (distance 1 on both sides -> earlier slot 0).
        const chosen = assignSlots(3, [only(1, 10), only(25, 20)], duration);

        expect(chosen[1]?.id).toBe(10);
    });

    it('fills from genuine slots only, not from earlier fills', () => {
        const duration = 90;
        const only = (ts: number, id: number): Candidate => ({
            id,
            timestamp: ts,
            saturation: 10,
            detail: 4,
        });
        // Only slot 8 (ts 85) has data: every other slot reuses it.
        const chosen = assignSlots(3, [only(85, 7)], duration);

        expect(chosen.every((c) => c.id === 7)).toBe(true);
        expect(chosen).toHaveLength(9);
    });

    it('clamps candidates with timestamp at or past the duration to the last slot', () => {
        const only: Candidate = { id: 1, timestamp: 90, saturation: 10, detail: 4 };
        const chosen = assignSlots(3, [only], 90);

        expect(chosen).toHaveLength(9);
        expect(chosen[8]).toBe(only);
    });

    it('throws when there are no candidates at all', () => {
        expect(() => assignSlots(3, [], 60)).toThrow(/No storyboard candidate frames/);
    });
});

describe('storyboardJson', () => {
    const prefix = '2026/01/02/clip-ab12cd34ef56/';

    it('lists only the grids that exist, in size order', () => {
        expect(storyboardJson([5, 3], prefix)).toEqual({
            '3x3': { path: `${prefix}storyboard_3x3.jpg` },
            '5x5': { path: `${prefix}storyboard_5x5.jpg` },
        });
        expect(Object.keys(storyboardJson([5, 4, 3], prefix) ?? {})).toEqual(['3x3', '4x4', '5x5']);
    });

    it('returns null when no grid exists (or only unknown sizes)', () => {
        expect(storyboardJson([], prefix)).toBeNull();
        expect(storyboardJson([2, 6], prefix)).toBeNull();
    });
});
