import { describe, expect, it } from 'vitest';
import {
    candidateTimestamps,
    chooseThumbnailLayout,
    isLandscape,
    isRemoved,
    isShortVideo,
    needsExtraCandidate,
    pickBestOffset,
    rank,
    shortVideoTimestamp,
    smartCropOffsets,
    smartCropPlan,
    type ScoredFrame,
} from './thumbnailPlan';

function frame(timestamp: number, saturation: number | null, detail: number | null): ScoredFrame {
    return { timestamp, saturation, detail };
}

describe('short videos', () => {
    it.each([
        [null, true],
        [0, true],
        [2.99, true],
        [3, false],
        [120, false],
    ])('isShortVideo(%j) = %j', (duration, expected) => {
        expect(isShortVideo(duration)).toBe(expected);
    });

    it('uses duration / 2 (0 when unknown)', () => {
        expect(shortVideoTimestamp(2)).toBe(1);
        expect(shortVideoTimestamp(null)).toBe(0);
    });
});

describe('candidateTimestamps', () => {
    it('samples 25/50/75 percent and the 10/90 percent extras', () => {
        const { initial, extras } = candidateTimestamps(100);

        expect(initial).toEqual([25, 50, 75]);
        expect(extras).toEqual([10, 90]);
    });

    it('clamps to duration - 0.5', () => {
        const { initial, extras } = candidateTimestamps(3);

        expect(initial).toEqual([0.75, 1.5, 2.25]);
        expect(extras[1]).toBe(2.5);
    });

    it('never goes negative', () => {
        const { extras } = candidateTimestamps(3);

        expect(extras.every((t) => t >= 0)).toBe(true);
    });
});

describe('isRemoved / rank', () => {
    it.each([
        [null, 10, true],
        [4.99, 10, true],
        [5, 3, false],
        [5, 2.99, true],
        [5, null, false],
        [50, null, false],
        [0, null, true],
    ])('isRemoved(%j, %j) = %j', (saturation, detail, expected) => {
        expect(isRemoved(saturation, detail)).toBe(expected);
    });

    it('ranks saturation + 5 x detail with missing scores as 0', () => {
        expect(rank(10, 4)).toBe(30);
        expect(rank(null, 2)).toBe(10);
        expect(rank(7, null)).toBe(7);
        expect(rank(null, null)).toBe(0);
    });
});

describe('needsExtraCandidate', () => {
    it('is true until 3 frames pass the filter', () => {
        const good = frame(1, 20, 10);
        const bad = frame(2, 1, 1);

        expect(needsExtraCandidate([])).toBe(true);
        expect(needsExtraCandidate([good, good, bad])).toBe(true);
        expect(needsExtraCandidate([good, good, good])).toBe(false);
        expect(needsExtraCandidate([good, good, good, bad])).toBe(false);
    });
});

describe('isLandscape', () => {
    it.each([
        [1920, 1080, true],
        [1080, 1920, false],
        [1000, 1000, false],
        [1, 1, false],
        [null, 10, false],
        [10, null, false],
    ])('isLandscape(%j, %j) = %j', (w, h, expected) => {
        expect(isLandscape(w, h)).toBe(expected);
    });
});

describe('chooseThumbnailLayout', () => {
    it('returns none without candidates', () => {
        expect(chooseThumbnailLayout({ candidates: [], landscape: true })).toEqual({
            kind: 'none',
        });
        expect(chooseThumbnailLayout({ candidates: [], landscape: false })).toEqual({
            kind: 'none',
        });
    });

    it('landscape: the best-ranked kept frame', () => {
        const a = frame(10, 10, 4); // 30
        const b = frame(20, 30, 4); // 50
        const c = frame(30, 20, 4); // 40
        const layout = chooseThumbnailLayout({ candidates: [a, b, c], landscape: true });

        expect(layout.kind).toBe('single');

        if (layout.kind === 'single') {
            expect(layout.frame).toBe(b);
            expect(layout.ranked).toEqual([b, c, a]);
        }
    });

    it('landscape with only removed candidates uses the best removed one', () => {
        const a = frame(10, 1, 1);
        const b = frame(20, 4, 2);
        const layout = chooseThumbnailLayout({ candidates: [a, b], landscape: true });

        expect(layout).toEqual({ kind: 'single', frame: b, ranked: [b] });
    });

    it('portrait: the 3 best frames sorted by timestamp', () => {
        const f1 = frame(10, 10, 4); // 30
        const f2 = frame(20, 40, 4); // 60
        const f3 = frame(30, 20, 4); // 40
        const f4 = frame(40, 15, 4); // 35
        const layout = chooseThumbnailLayout({ candidates: [f1, f2, f3, f4], landscape: false });

        expect(layout.kind).toBe('triple');

        if (layout.kind === 'triple') {
            expect(layout.frames).toEqual([f2, f3, f4]);
            expect(layout.ranked).toEqual([f2, f3, f4, f1]);
        }
    });

    it('portrait tops up from the best removed frames', () => {
        const good1 = frame(50, 20, 4);
        const good2 = frame(10, 10, 4);
        const removedLow = frame(20, 2, 1);
        const removedHigh = frame(30, 4, 2.5); // rank 16.5
        const layout = chooseThumbnailLayout({
            candidates: [good1, good2, removedLow, removedHigh],
            landscape: false,
        });

        expect(layout.kind).toBe('triple');

        if (layout.kind === 'triple') {
            expect(layout.frames).toEqual([good2, removedHigh, good1]);
        }
    });

    it('portrait with fewer than 3 candidates falls back to a single frame', () => {
        const a = frame(10, 20, 4);
        const b = frame(20, 30, 4);
        const layout = chooseThumbnailLayout({ candidates: [a, b], landscape: false });

        expect(layout).toEqual({ kind: 'single', frame: b, ranked: [b, a] });
    });

    it('square videos (1x1) are not landscape and use the grid when possible', () => {
        const frames = [frame(1, 10, 4), frame(2, 10, 4), frame(3, 10, 4)];
        const layout = chooseThumbnailLayout({
            candidates: frames,
            landscape: isLandscape(1, 1),
        });

        expect(layout.kind).toBe('triple');
    });

    it('keeps input order on rank ties (stable)', () => {
        const a = frame(30, 10, 4);
        const b = frame(10, 10, 4);
        const c = frame(20, 10, 4);
        const layout = chooseThumbnailLayout({ candidates: [a, b, c], landscape: true });

        expect(layout.kind === 'single' && layout.ranked).toEqual([a, b, c]);
        expect(layout.kind === 'single' && layout.frame).toBe(a);
    });

    it('keeps kept frames ahead of topped-up ones on equal rank', () => {
        const kept = frame(10, 20, 4); // 40
        const removed = frame(20, 40, 0); // 40, removed (detail < 3)
        const layout = chooseThumbnailLayout({ candidates: [removed, kept], landscape: true });

        expect(layout.kind === 'single' && layout.frame).toBe(kept);
    });
});

describe('smart crop', () => {
    it.each([
        [0, [0]],
        [-4, [0]],
        [1, [0, 1]], // round(0.5) = 1, round(1) = 1 -> unique [0, 1]
        [2, [0, 1, 2]],
        [3, [0, 2, 3]], // round(1.5) = 2
        [5, [0, 3, 5]], // round(2.5) = 3
        [720, [0, 360, 720]],
    ])('offsets for excess %i = %j', (excess, expected) => {
        expect(smartCropOffsets(excess)).toEqual(expected);
    });

    it('chooses the axis with excess, x first', () => {
        expect(smartCropPlan(1920, 1080, 1080, 1080)).toEqual({ axis: 'x', maxOffset: 840 });
        expect(smartCropPlan(1080, 1920, 1080, 1080)).toEqual({ axis: 'y', maxOffset: 840 });
        expect(smartCropPlan(1080, 1080, 1080, 1080)).toEqual({ axis: null, maxOffset: 0 });
        expect(smartCropPlan(1500, 1200, 1080, 1080)).toEqual({ axis: 'x', maxOffset: 420 });
    });

    it('picks the highest detail offset, first on ties', () => {
        expect(
            pickBestOffset(
                [
                    { offset: 0, score: 4 },
                    { offset: 5, score: 9 },
                    { offset: 10, score: 9 },
                ],
                10,
            ),
        ).toBe(5);
    });

    it('skips unscored offsets and falls back to the centre when none scored', () => {
        expect(
            pickBestOffset(
                [
                    { offset: 0, score: null },
                    { offset: 5, score: 1 },
                ],
                10,
            ),
        ).toBe(5);
        expect(pickBestOffset([{ offset: 0, score: null }], 11)).toBe(6);
        expect(pickBestOffset([], 0)).toBe(0);
    });
});
