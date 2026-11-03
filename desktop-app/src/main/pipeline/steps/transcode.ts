/** HLS transcode (spec 4.4 step 3): ffmpeg with `-progress pipe:1`, fractions reported live. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfigTranscode } from '../../../shared/appConfig';
import { transcodeArgs, transcodeTimeoutSeconds } from '../../ffmpeg/args';
import { createProgressParser, toFraction } from '../../ffmpeg/progress';
import { PLAYLIST_FILE } from '../fileNames';
import { exec, failed, succeeded, type StepEnv } from './env';
import { FIRST_SEGMENT_FILE } from './probe';

export interface TranscodeInput {
    /** Absolute source path (the only absolute path handed to ffmpeg). */
    input: string;
    transcode: AppConfigTranscode;
    duration: number | null;
    /** `transcode.fps` when set, otherwise the probed source fps. */
    outputFps: number;
    threads?: number | null;
    /** Called with a fraction in [0, 1], never decreasing; only when the duration is known. */
    onFraction: (fraction: number) => void;
}

export async function transcodeToHls(env: StepEnv, options: TranscodeInput): Promise<void> {
    const args = transcodeArgs({
        input: options.input,
        resolution: options.transcode.resolution,
        segmentSeconds: options.transcode.segment_seconds,
        fps: options.transcode.fps,
        outputFps: options.outputFps,
        threads: options.threads,
    });
    const parser = createProgressParser();
    let fraction = 0;

    function handle(update: ReturnType<typeof parser.feed>): void {
        if (update.outTimeSeconds === null) return;
        const next = toFraction(update.outTimeSeconds, options.duration, fraction);
        if (next === null || next === fraction) return;
        fraction = next;
        options.onFraction(fraction);
    }

    const result = await exec(
        env,
        'ffmpeg',
        args,
        transcodeTimeoutSeconds(options.duration) * 1000,
        { onStdout: (chunk) => handle(parser.feed(chunk)) },
    );

    handle(parser.flush());

    if (result.timedOut) {
        throw failed(env, 'Converting the video took too long and was stopped.', result);
    }

    if (!succeeded(result)) {
        throw failed(
            env,
            `ffmpeg failed to convert the video (exit code ${result.exitCode ?? 'unknown'}).`,
            result,
        );
    }

    for (const name of [PLAYLIST_FILE, FIRST_SEGMENT_FILE]) {
        const ok = await stat(join(env.cwd, name)).then(
            (s) => s.isFile(),
            () => false,
        );

        if (!ok) throw failed(env, 'ffmpeg finished without producing the HLS output.', result);
    }

    options.onFraction(1);
}
