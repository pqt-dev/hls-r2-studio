/** Frame quality measurements through ffprobe `movie=<file>,signalstats` (spec 4.4 step 4). */
import { detailProbeArgs, saturationProbeArgs } from '../../ffmpeg/args';
import { exec, succeeded, type StepEnv } from './env';

export const MEASURE_TIMEOUT_MS = 60_000;

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** PHP `readMeasurementProcessOutput`: null unless the output is a single numeric value. */
export function parseScore(raw: string): number | null {
    const text = raw.trim();

    return NUMERIC.test(text) ? Number(text) : null;
}

async function measure(env: StepEnv, args: string[], what: string): Promise<number | null> {
    try {
        const result = await exec(env, 'ffprobe', args, MEASURE_TIMEOUT_MS, {
            collectStdout: true,
        });

        if (!succeeded(result)) {
            env.logger.warn(`Could not measure ${what}; treating it as unscored.`);

            return null;
        }

        return parseScore(result.stdoutText ?? '');
    } catch (error) {
        if (env.signal.aborted) throw error;
        env.logger.warn(`Could not measure ${what}; treating it as unscored.`, { error });

        return null;
    }
}

/** Average saturation (SATAVG) of an image inside `env.cwd`; null when it cannot be measured. */
export function measureSaturation(env: StepEnv, imageFile: string): Promise<number | null> {
    return measure(env, saturationProbeArgs(imageFile), 'saturation');
}

/** Detail (edge-detect YAVG) of an image inside `env.cwd`; null when it cannot be measured. */
export function measureDetail(env: StepEnv, imageFile: string): Promise<number | null> {
    return measure(env, detailProbeArgs(imageFile), 'detail');
}
