/** Probing: source duration/fps (spec 4.4 step 2) and output info of the first segment (step 3). */
import { stat } from 'node:fs/promises';
import {
    PROBE_TIMEOUT_SECONDS,
    probeDurationArgs,
    probeFpsArgs,
    probeOutputInfoArgs,
} from '../../ffmpeg/args';
import {
    EMPTY_OUTPUT_INFO,
    parseDurationOutput,
    parseFrameRateOutput,
    parseOutputInfo,
    type OutputInfo,
} from '../../ffmpeg/probeParse';
import { exec, failed, succeeded, type StepEnv } from './env';

const PROBE_TIMEOUT_MS = PROBE_TIMEOUT_SECONDS * 1000;
export const FIRST_SEGMENT_FILE = 'segment_000.ts';

/**
 * Duration in seconds. ffprobe failing (exit != 0 or timeout) fails the job; an unusable value
 * (not numeric or <= 0) only logs a warning and yields null.
 */
export async function probeDuration(env: StepEnv, input: string): Promise<number | null> {
    const result = await exec(env, 'ffprobe', probeDurationArgs(input), PROBE_TIMEOUT_MS, {
        collectStdout: true,
    });

    if (!succeeded(result)) {
        throw failed(env, 'ffprobe could not read the video file.', result);
    }

    const duration = parseDurationOutput(result.stdoutText ?? '');

    if (duration === null) {
        env.logger.warn('ffprobe returned an unusable duration; continuing without a duration.');
    }

    return duration;
}

/** Source frame rate (`num/den`); ffprobe failing fails the job, an unusable value yields 0. */
export async function probeFps(env: StepEnv, input: string): Promise<number> {
    const result = await exec(env, 'ffprobe', probeFpsArgs(input), PROBE_TIMEOUT_MS, {
        collectStdout: true,
    });

    if (!succeeded(result)) {
        throw failed(env, 'ffprobe could not read the video frame rate.', result);
    }

    return parseFrameRateOutput(result.stdoutText ?? '');
}

/**
 * width/height/fps/bitrate/codec of the first output segment. Any problem (no segment, ffprobe
 * failure) yields EMPTY_OUTPUT_INFO and never fails the job.
 */
export async function probeOutputInfo(env: StepEnv, segmentSeconds: number): Promise<OutputInfo> {
    let segmentBytes: number;

    try {
        segmentBytes = (await stat(`${env.cwd}/${FIRST_SEGMENT_FILE}`)).size;
    } catch {
        env.logger.warn('No HLS segment found to probe; output info is left empty.');

        return EMPTY_OUTPUT_INFO;
    }

    const result = await exec(
        env,
        'ffprobe',
        probeOutputInfoArgs(FIRST_SEGMENT_FILE),
        PROBE_TIMEOUT_MS,
        { collectStdout: true },
    );

    if (!succeeded(result)) {
        env.logger.warn('ffprobe could not read the output segment; output info is left empty.');

        return EMPTY_OUTPUT_INFO;
    }

    return parseOutputInfo(result.stdoutText ?? '', { segmentBytes, segmentSeconds });
}
