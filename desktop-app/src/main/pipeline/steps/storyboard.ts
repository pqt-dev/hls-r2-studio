/**
 * Storyboards (spec 4.4 step 5, port of StoryboardGenerator): one decode pass of 75 candidate
 * frames, scoring, slot assignment and `tile=NxN` composition for the 3x3, 4x4 and 5x5 grids.
 * Never fails the video: any problem only logs a warning; only cancellation is propagated.
 */
import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    IMAGE_COMMAND_TIMEOUT_SECONDS,
    storyboardCandidateArgs,
    storyboardTileArgs,
    storyboardTimeoutSeconds,
} from '../../ffmpeg/args';
import { isCancelled } from '../errors';
import { storyboardFileName } from '../fileNames';
import { runPool } from '../pool';
import {
    SCORING_CONCURRENCY,
    STORYBOARD_GRID_SIZES,
    assignSlots,
    candidateTimestamp,
    storyboardJson,
    tileFileNames,
} from '../storyboardPlan';
import type { ScoredFrame } from '../thumbnailPlan';
import { exec, succeeded, type StepEnv } from './env';
import { fileExists, removeFiles } from './fsUtil';
import { measureDetail, measureSaturation } from './score';

const TILE_TIMEOUT_MS = IMAGE_COMMAND_TIMEOUT_SECONDS * 1000;
const CANDIDATE_FILE = /^candidate_\d+\.jpg$/;

export interface StoryboardInput {
    input: string;
    duration: number | null;
    /** Object key prefix, used for the returned `storyboards` map. */
    prefix: string;
    threads?: number | null;
}

interface Candidate extends ScoredFrame {
    file: string;
}

/** The `storyboards` register map for the grids that were produced, or null. */
export async function generateStoryboards(
    env: StepEnv,
    input: StoryboardInput,
): Promise<Record<string, { path: string }> | null> {
    const duration = input.duration;

    if (duration === null || !(duration > 0)) {
        env.logger.warn('Skipping the storyboard: the video duration is unknown.');

        return null;
    }

    const created = new Set<string>();

    try {
        const candidates = await extractAndScore(
            env,
            input.input,
            duration,
            input.threads,
            created,
        );
        const grids: number[] = [];

        for (const size of STORYBOARD_GRID_SIZES) {
            try {
                await composeGrid(env, candidates, duration, size, created);
                grids.push(size);
            } catch (error) {
                if (isCancelled(error)) throw error;
                env.logger.warn(`Storyboard ${size}x${size} failed; skipping that grid.`, {
                    error,
                });
            }
        }

        return storyboardJson(grids, input.prefix);
    } catch (error) {
        if (isCancelled(error)) throw error;
        env.logger.warn('Storyboard generation failed; continuing without storyboards.', { error });

        return null;
    } finally {
        await removeFiles([...created].map((name) => join(env.cwd, name)));
    }
}

async function extractAndScore(
    env: StepEnv,
    input: string,
    duration: number,
    threads: number | null | undefined,
    created: Set<string>,
): Promise<Candidate[]> {
    const result = await exec(
        env,
        'ffmpeg',
        storyboardCandidateArgs({ input, duration, threads }),
        storyboardTimeoutSeconds(duration) * 1000,
    );
    const names = (await readdir(env.cwd)).filter((n) => CANDIDATE_FILE.test(n)).sort();

    for (const name of names) created.add(name);

    if (!succeeded(result) || names.length === 0) {
        throw new Error('storyboard candidate extraction failed');
    }

    const candidates: Candidate[] = names.map((file, index) => ({
        file,
        timestamp: candidateTimestamp(index, duration),
        saturation: null,
        detail: null,
    }));

    await runPool(candidates, SCORING_CONCURRENCY, async (candidate) => {
        const [saturation, detail] = await Promise.all([
            measureSaturation(env, candidate.file),
            measureDetail(env, candidate.file),
        ]);
        candidate.saturation = saturation;
        candidate.detail = detail;
    });

    return candidates;
}

async function composeGrid(
    env: StepEnv,
    candidates: readonly Candidate[],
    duration: number,
    size: number,
    created: Set<string>,
): Promise<void> {
    const chosen = assignSlots(size, candidates, duration);
    const tiles = tileFileNames(size);

    for (const [slot, frame] of chosen.entries()) {
        const tile = tiles[slot];
        if (tile === undefined) throw new Error('tile slot out of range');
        created.add(tile);
        await copyFile(join(env.cwd, frame.file), join(env.cwd, tile));
    }

    const output = storyboardFileName(size);
    const result = await exec(env, 'ffmpeg', storyboardTileArgs(size), TILE_TIMEOUT_MS);

    // The tile filter silently writes nothing when it gets too few frames: check the file too.
    if (!succeeded(result) || !(await fileExists(join(env.cwd, output)))) {
        await removeFiles([join(env.cwd, output)]);
        throw new Error(`ffmpeg ${size}x${size} composition failed`);
    }
}
