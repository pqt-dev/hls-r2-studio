/** Pure planning for the storyboard step (port of StoryboardGenerator). */
import { isFrameRemoved, rankFrame, type ScoredFrame } from './thumbnailPlan';
import { storyboardFileName, tileSequencePattern } from './fileNames';

export const STORYBOARD_GRID_SIZES: readonly number[] = [3, 4, 5];
export const STORYBOARD_TILE_SIZE = 160;
export const CANDIDATES_PER_SLOT = 3;
export const SCORING_CONCURRENCY = 4;

const LARGEST_GRID = Math.max(...STORYBOARD_GRID_SIZES);

/** 3 x 5 x 5 = 75 candidates extracted in one decode pass. */
export const TOTAL_CANDIDATES = CANDIDATES_PER_SLOT * LARGEST_GRID * LARGEST_GRID;

/** Source timestamp of candidate `index`: `index * duration / 75` (the fps filter's spacing). */
export function candidateTimestamp(index: number, duration: number): number {
    return (index * duration) / TOTAL_CANDIDATES;
}

/** Pixel size (width = height) of the finished grid image, e.g. 3 -> 480. */
export function gridPixelSize(gridSize: number): number {
    return gridSize * STORYBOARD_TILE_SIZE;
}

/** Frame names `tile_NxN_0000.jpg`, ... in slot order. */
export function tileFileNames(gridSize: number): string[] {
    return Array.from({ length: gridSize * gridSize }, (_, slot) =>
        tileSequencePattern(gridSize).replace('%04d', String(slot).padStart(4, '0')),
    );
}

/**
 * Picks one candidate per slot of a `gridSize` x `gridSize` grid:
 * - the duration is split into N*N equal slots, a candidate belongs to `floor(ts / slotLength)`
 *   (clamped to the valid range);
 * - a slot takes its best-ranked candidate that passes the filter, else its best-ranked overall;
 * - an empty slot reuses the nearest slot that genuinely had candidates, searching outwards and
 *   checking the earlier slot (index - d) before the later one (index + d).
 * Ties keep the earlier candidate (stable sort, like PHP 8 usort).
 * Throws when no candidate exists at all.
 */
export function assignSlots<T extends ScoredFrame>(
    gridSize: number,
    candidates: readonly T[],
    duration: number,
): T[] {
    const totalTiles = gridSize * gridSize;
    const slotDuration = duration / totalTiles;
    const slots: T[][] = Array.from({ length: totalTiles }, () => []);

    for (const candidate of candidates) {
        const raw = Math.floor(candidate.timestamp / slotDuration);
        const slotIndex = Math.max(0, Math.min(totalTiles - 1, raw));

        slots[slotIndex]?.push(candidate);
    }

    const genuine: (T | null)[] = slots.map((slotCandidates) => {
        if (slotCandidates.length === 0) {
            return null;
        }

        const passing = slotCandidates.filter((c) => !isFrameRemoved(c));
        const pool = passing.length > 0 ? passing : slotCandidates;

        return [...pool].sort((a, b) => rankFrame(b) - rankFrame(a))[0] ?? null;
    });

    return genuine.map((chosen, slotIndex) => {
        if (chosen !== null) {
            return chosen;
        }

        const replacement = nearestChosen(genuine, slotIndex);

        if (replacement === null) {
            throw new Error('No storyboard candidate frames are available for any tile slot.');
        }

        return replacement;
    });
}

function nearestChosen<T>(chosen: readonly (T | null)[], slotIndex: number): T | null {
    for (let distance = 1; distance < chosen.length; distance++) {
        for (const neighbour of [slotIndex - distance, slotIndex + distance]) {
            const candidate = chosen[neighbour];

            if (candidate !== null && candidate !== undefined) {
                return candidate;
            }
        }
    }

    return null;
}

/** The `storyboards` register field: grids that produced a file, or null when none did. */
export function storyboardJson(
    existingGrids: readonly number[],
    prefix: string,
): Record<string, { path: string }> | null {
    const result: Record<string, { path: string }> = {};

    for (const size of STORYBOARD_GRID_SIZES) {
        if (existingGrids.includes(size)) {
            result[`${size}x${size}`] = { path: prefix + storyboardFileName(size) };
        }
    }

    return Object.keys(result).length === 0 ? null : result;
}
