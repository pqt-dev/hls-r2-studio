/**
 * Pure planning/ranking for the thumbnail step (port of ThumbnailGenerator). The caller extracts
 * frames and measures scores; this module only decides what to extract and which frames to use.
 */

export const MIN_SATURATION = 5.0;
export const MIN_DETAIL = 3.0;
export const DETAIL_SCORE_WEIGHT = 5.0;
export const SHORT_VIDEO_SECONDS = 3;
export const INITIAL_SAMPLE_FRACTIONS: readonly number[] = [0.25, 0.5, 0.75];
export const EXTRA_SAMPLE_FRACTIONS: readonly number[] = [0.1, 0.9];
export const REQUIRED_KEPT_FOR_EARLY_STOP = 3;
export const SMART_CROP_WINDOW_COUNT = 3;

export const SINGLE_CANVAS = { width: 1080, height: 1080 } as const;
export const COLUMN_CANVAS = { width: 360, height: 1080 } as const;

/** A scored candidate frame. `saturation`/`detail` are null when the measurement failed. */
export interface ScoredFrame {
    timestamp: number;
    saturation: number | null;
    detail: number | null;
}

/** Duration below 3 s (or unknown, treated as 0) uses the single mid-frame path. */
export function isShortVideo(duration: number | null): boolean {
    return (duration ?? 0) < SHORT_VIDEO_SECONDS;
}

/** Timestamp of the single frame extracted for short videos: `duration / 2`. */
export function shortVideoTimestamp(duration: number | null): number {
    return (duration ?? 0) / 2;
}

function clampedTimestamp(duration: number, fraction: number): number {
    const maxTimestamp = Math.max(0, duration - 0.5);

    return Math.min(Math.max(duration * fraction, 0), maxTimestamp);
}

/**
 * Candidate timestamps for videos of 3 s or more: `initial` (0.25/0.5/0.75) are always tried;
 * `extras` (0.1/0.9) are tried one at a time, only while {@link needsExtraCandidate} says so.
 */
export function candidateTimestamps(duration: number): { initial: number[]; extras: number[] } {
    return {
        initial: INITIAL_SAMPLE_FRACTIONS.map((f) => clampedTimestamp(duration, f)),
        extras: EXTRA_SAMPLE_FRACTIONS.map((f) => clampedTimestamp(duration, f)),
    };
}

export function isRemoved(saturation: number | null, detail: number | null): boolean {
    return (
        saturation === null ||
        saturation < MIN_SATURATION ||
        (detail !== null && detail < MIN_DETAIL)
    );
}

/** `saturation + 5 * detail`, with a missing score counting as 0. */
export function rank(saturation: number | null, detail: number | null): number {
    return (saturation ?? 0) + DETAIL_SCORE_WEIGHT * (detail ?? 0);
}

export function rankFrame(frame: ScoredFrame): number {
    return rank(frame.saturation, frame.detail);
}

export function isFrameRemoved(frame: ScoredFrame): boolean {
    return isRemoved(frame.saturation, frame.detail);
}

/** Stable sort by rank, best first (ties keep their input order, like PHP 8 usort). */
export function sortByRankDesc<T extends ScoredFrame>(frames: readonly T[]): T[] {
    return [...frames].sort((a, b) => rankFrame(b) - rankFrame(a));
}

/** Checked before extracting each extra candidate: fewer than 3 frames passed the filter so far. */
export function needsExtraCandidate(candidates: readonly ScoredFrame[]): boolean {
    return candidates.filter((c) => !isFrameRemoved(c)).length < REQUIRED_KEPT_FOR_EARLY_STOP;
}

export function isLandscape(width: number | null, height: number | null): boolean {
    return width !== null && height !== null && width > height;
}

export type ThumbnailLayout<T extends ScoredFrame> =
    | { kind: 'none' }
    /** `ranked` is the best-first list so the caller can fall through when a frame fails. */
    | { kind: 'single'; frame: T; ranked: T[] }
    /** `frames` are the 3 best, ordered by timestamp; `ranked` allows replacing a failed crop. */
    | { kind: 'triple'; frames: [T, T, T]; ranked: T[] };

export interface ChooseLayoutInput<T extends ScoredFrame> {
    candidates: readonly T[];
    landscape: boolean;
}

export function chooseThumbnailLayout<T extends ScoredFrame>({
    candidates,
    landscape,
}: ChooseLayoutInput<T>): ThumbnailLayout<T> {
    if (candidates.length === 0) {
        return { kind: 'none' };
    }

    let kept = candidates.filter((c) => !isFrameRemoved(c));
    const removed = candidates.filter((c) => isFrameRemoved(c));
    const minNeeded = landscape ? 1 : 3;

    if (kept.length < minNeeded) {
        kept = [...kept, ...sortByRankDesc(removed).slice(0, minNeeded - kept.length)];
    }

    const ranked = sortByRankDesc(kept);
    const [first, second, third] = ranked;

    if (landscape || first === undefined || second === undefined || third === undefined) {
        // Landscape, or not enough frames for a grid: single frame (the PHP fall-back).
        return first === undefined ? { kind: 'none' } : { kind: 'single', frame: first, ranked };
    }

    const frames = [first, second, third].sort((a, b) => a.timestamp - b.timestamp) as [T, T, T];

    return { kind: 'triple', frames, ranked };
}

export interface SmartCropPlan {
    axis: 'x' | 'y' | null;
    /** Excess pixels along the axis (0 when the scaled image already matches the canvas). */
    maxOffset: number;
}

/** Axis and excess after scaling: x first, then y, else none (PHP `smartCropToCanvas`). */
export function smartCropPlan(
    scaledWidth: number,
    scaledHeight: number,
    canvasWidth: number,
    canvasHeight: number,
): SmartCropPlan {
    const excessX = scaledWidth - canvasWidth;
    const excessY = scaledHeight - canvasHeight;

    if (excessX > 0) {
        return { axis: 'x', maxOffset: excessX };
    }

    if (excessY > 0) {
        return { axis: 'y', maxOffset: excessY };
    }

    return { axis: null, maxOffset: 0 };
}

/**
 * The trial crop offsets `round(excess * i / 2)` for i = 0..2, de-duplicated (PHP uses
 * `(int) round()`; the spec text said floor, see the B2 report). `[0]` when there is no excess.
 */
export function smartCropOffsets(excess: number): number[] {
    if (!(excess > 0)) {
        return [0];
    }

    const offsets: number[] = [];

    for (let i = 0; i < SMART_CROP_WINDOW_COUNT; i++) {
        offsets.push(Math.round((excess * i) / (SMART_CROP_WINDOW_COUNT - 1)));
    }

    return [...new Set(offsets)];
}

export interface OffsetScore {
    offset: number;
    /** Detail score of the trial crop; null when the crop or the measurement failed. */
    score: number | null;
}

/**
 * The offset with the highest detail score (first wins on ties, nulls skipped). When no trial
 * produced a score, the centre `round(maxOffset / 2)` is used, like PHP.
 */
export function pickBestOffset(scores: readonly OffsetScore[], maxOffset: number): number {
    let bestOffset: number | null = null;
    let bestScore: number | null = null;

    for (const { offset, score } of scores) {
        if (score !== null && (bestScore === null || score > bestScore)) {
            bestScore = score;
            bestOffset = offset;
        }
    }

    return bestOffset ?? Math.round(maxOffset / 2);
}
