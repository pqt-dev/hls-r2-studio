/** Locates the ffmpeg/ffprobe executables (spec 4.2): bundled when packaged, PATH/env in dev. */
import { posix, win32 } from 'node:path';

export interface Binaries {
    ffmpeg: string;
    ffprobe: string;
}

export interface ResolveBinariesInput {
    platform: NodeJS.Platform;
    /** `process.resourcesPath` of the packaged app. */
    resourcesPath: string;
    env: Readonly<Record<string, string | undefined>>;
    isPackaged: boolean;
}

function nonEmpty(value: string | undefined): string | null {
    return value !== undefined && value.trim() !== '' ? value : null;
}

/**
 * Packaged: absolute `<resourcesPath>/bin/ffmpeg(.exe)` and `ffprobe(.exe)`; PATH is never used.
 * Development: `FFMPEG_PATH` / `FFPROBE_PATH`, otherwise the bare names (resolved through PATH).
 */
export function resolveBinaries(input: ResolveBinariesInput): Binaries {
    const windows = input.platform === 'win32';
    const suffix = windows ? '.exe' : '';

    if (input.isPackaged) {
        const path = windows ? win32 : posix;

        return {
            ffmpeg: path.join(input.resourcesPath, 'bin', `ffmpeg${suffix}`),
            ffprobe: path.join(input.resourcesPath, 'bin', `ffprobe${suffix}`),
        };
    }

    return {
        ffmpeg: nonEmpty(input.env['FFMPEG_PATH']) ?? `ffmpeg${suffix}`,
        ffprobe: nonEmpty(input.env['FFPROBE_PATH']) ?? `ffprobe${suffix}`,
    };
}
