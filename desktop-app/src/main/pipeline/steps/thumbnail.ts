/**
 * Thumbnail (spec 4.4 step 4, port of ThumbnailGenerator). Optional: any failure only logs a
 * warning and yields "no thumbnail"; only cancellation is propagated.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    IMAGE_COMMAND_TIMEOUT_SECONDS,
    hstackArgs,
    shortVideoThumbnailArgs,
    smartCropCropArgs,
    smartCropScaleArgs,
    thumbnailFrameArgs,
} from '../../ffmpeg/args';
import { THUMBNAIL_FILE, thumbCandidateFileName } from '../fileNames';
import { isCancelled } from '../errors';
import {
    COLUMN_CANVAS,
    SINGLE_CANVAS,
    candidateTimestamps,
    chooseThumbnailLayout,
    isLandscape,
    isShortVideo,
    needsExtraCandidate,
    pickBestOffset,
    smartCropOffsets,
    smartCropPlan,
    type OffsetScore,
    type ScoredFrame,
} from '../thumbnailPlan';
import { exec, succeeded, type StepEnv } from './env';
import { fileExists, removeFiles } from './fsUtil';
import { jpegSize } from './imageSize';
import { measureDetail, measureSaturation } from './score';

const IMAGE_TIMEOUT_MS = IMAGE_COMMAND_TIMEOUT_SECONDS * 1000;

export interface ThumbnailInput {
    /** Absolute source path. */
    input: string;
    duration: number | null;
    /** Output (transcoded) size, used to pick the landscape or the grid layout. */
    width: number | null;
    height: number | null;
}

interface Frame extends ScoredFrame {
    file: string;
}

interface Work {
    env: StepEnv;
    created: Set<string>;
    nextId: () => number;
}

/** Returns true when `thumbnail.jpg` exists in the job directory afterwards. */
export async function generateThumbnail(env: StepEnv, input: ThumbnailInput): Promise<boolean> {
    const work: Work = { env, created: new Set(), nextId: counter() };

    try {
        await run(work, input);
    } catch (error) {
        if (isCancelled(error)) throw error;
        env.logger.warn('Thumbnail generation failed; continuing without a thumbnail.', { error });
        await removeFiles([join(env.cwd, THUMBNAIL_FILE)]);
    } finally {
        await removeFiles([...work.created].map((name) => join(env.cwd, name)));
    }

    return fileExists(join(env.cwd, THUMBNAIL_FILE));
}

function counter(): () => number {
    let value = 0;

    return () => value++;
}

function track(work: Work, name: string): string {
    work.created.add(name);

    return name;
}

async function runImage(work: Work, args: string[]): Promise<boolean> {
    const result = await exec(work.env, 'ffmpeg', args, IMAGE_TIMEOUT_MS);

    return succeeded(result);
}

async function run(work: Work, input: ThumbnailInput): Promise<void> {
    const { env } = work;

    if (isShortVideo(input.duration)) {
        const ok = await runImage(work, shortVideoThumbnailArgs(input.input, input.duration));
        if (!ok) {
            env.logger.warn('Could not extract a frame from the short video.');
            await removeFiles([join(env.cwd, THUMBNAIL_FILE)]);
        }

        return;
    }

    const duration = input.duration ?? 0;
    const plan = candidateTimestamps(duration);
    const candidates: Frame[] = [];
    let counterValue = 0;

    async function extract(timestamp: number): Promise<void> {
        const file = track(work, thumbCandidateFileName(counterValue++));
        const ok = await runImage(work, thumbnailFrameArgs(input.input, timestamp, file)).catch(
            (error: unknown) => {
                if (isCancelled(error)) throw error;

                return false;
            },
        );

        if (!ok || !(await fileExists(join(env.cwd, file)))) {
            env.logger.warn('Could not extract a thumbnail candidate frame; skipping it.');

            return;
        }

        const saturation = await measureSaturation(env, file);
        const detail = await measureDetail(env, file);
        candidates.push({ timestamp, file, saturation, detail });
    }

    for (const timestamp of plan.initial) await extract(timestamp);

    for (const timestamp of plan.extras) {
        if (!needsExtraCandidate(candidates)) break;
        await extract(timestamp);
    }

    if (candidates.length === 0) {
        env.logger.warn('No thumbnail candidate frames could be extracted.');

        return;
    }

    const layout = chooseThumbnailLayout({
        candidates,
        landscape: isLandscape(input.width, input.height),
    });

    if (layout.kind === 'none') return;

    if (layout.kind === 'triple' && (await tryGrid(work, layout.ranked))) return;

    if (!(await trySingle(work, layout.ranked))) {
        env.logger.warn('No thumbnail could be created from any candidate frame.');
        await removeFiles([join(env.cwd, THUMBNAIL_FILE)]);
    }
}

async function trySingle(work: Work, ranked: readonly Frame[]): Promise<boolean> {
    for (const frame of ranked) {
        try {
            await smartCropToCanvas(work, frame.file, THUMBNAIL_FILE, SINGLE_CANVAS);

            return true;
        } catch (error) {
            if (isCancelled(error)) throw error;
            work.env.logger.warn('Single-frame thumbnail failed; trying the next candidate.', {
                error,
            });
        }
    }

    return false;
}

async function tryGrid(work: Work, ranked: readonly Frame[]): Promise<boolean> {
    const { env } = work;
    const id = work.nextId();
    const columns: { timestamp: number; file: string }[] = [];

    for (const frame of ranked) {
        if (columns.length >= 3) break;
        const file = track(work, `grid${id}_col_${columns.length}.jpg`);

        try {
            await smartCropToCanvas(work, frame.file, file, COLUMN_CANVAS);
            columns.push({ timestamp: frame.timestamp, file });
        } catch (error) {
            if (isCancelled(error)) throw error;
            env.logger.warn('Cropping a grid column failed; trying the next candidate.', { error });
        }
    }

    const [first, second, third] = [...columns].sort((a, b) => a.timestamp - b.timestamp);

    if (first === undefined || second === undefined || third === undefined) return false;

    try {
        const ok = await runImage(
            work,
            hstackArgs([first.file, second.file, third.file], THUMBNAIL_FILE),
        );

        if (ok && (await fileExists(join(env.cwd, THUMBNAIL_FILE)))) return true;
    } catch (error) {
        if (isCancelled(error)) throw error;
        env.logger.warn('Composing the grid thumbnail failed; using a single frame.', { error });
    }

    await removeFiles([join(env.cwd, THUMBNAIL_FILE)]);

    return false;
}

/** Port of PHP `smartCropToCanvas`: scale to cover, pick the sharpest of 3 crops, final crop. */
async function smartCropToCanvas(
    work: Work,
    framePath: string,
    outputPath: string,
    canvas: { width: number; height: number },
): Promise<void> {
    const { env } = work;
    const id = work.nextId();
    const scaled = track(work, `sc${id}_scaled.jpg`);

    if (
        !(await runImage(work, smartCropScaleArgs(framePath, scaled, canvas.width, canvas.height)))
    ) {
        throw new Error('smart-crop scale failed');
    }

    const size = jpegSize(await readFile(join(env.cwd, scaled)));

    if (size === null) throw new Error('could not read the scaled image size');

    const plan = smartCropPlan(size.width, size.height, canvas.width, canvas.height);
    const offsets = smartCropOffsets(plan.maxOffset);
    const scores: OffsetScore[] = [];

    for (const [index, offset] of offsets.entries()) {
        const trial = track(work, `sc${id}_trial_${index}.jpg`);
        const ok = await runImage(
            work,
            smartCropCropArgs(
                scaled,
                trial,
                canvas.width,
                canvas.height,
                ...cropOrigin(plan.axis, offset),
            ),
        ).catch((error: unknown) => {
            if (isCancelled(error)) throw error;

            return false;
        });

        if (!ok) continue;
        scores.push({ offset, score: await measureDetail(env, trial) });
    }

    const best = pickBestOffset(scores, plan.maxOffset);
    const finalOk = await runImage(
        work,
        smartCropCropArgs(
            scaled,
            outputPath,
            canvas.width,
            canvas.height,
            ...cropOrigin(plan.axis, best),
        ),
    );

    if (!finalOk) throw new Error('smart-crop final crop failed');
}

function cropOrigin(axis: 'x' | 'y' | null, offset: number): [number, number] {
    return [axis === 'x' ? offset : 0, axis === 'y' ? offset : 0];
}
