/** Local-only overall progress model (spec 4.4): weighted stages that never go backwards. */

export type PipelineStage = 'transcoding' | 'thumbnail' | 'storyboard' | 'upload' | 'register';

export const STAGE_ORDER: readonly PipelineStage[] = [
    'transcoding',
    'thumbnail',
    'storyboard',
    'upload',
    'register',
];

export const STAGE_WEIGHTS: Readonly<Record<PipelineStage, number>> = {
    transcoding: 70,
    thumbnail: 3,
    storyboard: 7,
    upload: 18,
    register: 2,
};

/**
 * Whole-number overall percent (0-100): the weights of the finished stages plus the current
 * stage's share. `stageFraction` is clamped to [0, 1] (NaN counts as 0); the result is floored
 * and never lower than `previous`, so only a fully completed register stage reaches 100.
 */
export function overallProgress(
    stage: PipelineStage,
    stageFraction: number,
    previous: number = 0,
): number {
    const fraction = Number.isFinite(stageFraction) ? Math.min(1, Math.max(0, stageFraction)) : 0;
    let percent = 0;

    for (const name of STAGE_ORDER) {
        if (name === stage) {
            percent += STAGE_WEIGHTS[name] * fraction;
            break;
        }

        percent += STAGE_WEIGHTS[name];
    }

    return Math.max(previous, Math.min(100, Math.floor(percent + 1e-9)));
}
