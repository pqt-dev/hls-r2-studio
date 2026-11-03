/** Startup self check of the ffmpeg build (spec 4.2): required encoders, muxers and filters. */
import type { ProcessRunner } from './runner';

export const REQUIRED_ENCODERS: readonly string[] = ['libx264', 'aac'];
export const REQUIRED_MUXERS: readonly string[] = ['hls'];
export const REQUIRED_FILTERS: readonly string[] = [
    'scale',
    'thumbnail',
    'signalstats',
    'edgedetect',
    'hstack',
    'tile',
    'crop',
    'fps',
    'movie',
];

export interface FfmpegCheckResult {
    ok: boolean;
    version: string | null;
    /** Entries like `encoder:libx264`, `muxer:hls`, `filter:movie`, or `ffmpeg:version`. */
    missing: string[];
}

/** Runs ffmpeg with the given args; resolves to the stdout text, or null when it failed. */
export type FfmpegTextRunner = (args: readonly string[]) => Promise<string | null>;

export function createFfmpegTextRunner(
    run: ProcessRunner,
    ffmpegPath: string,
    timeoutMs = 30000,
): FfmpegTextRunner {
    return async (args) => {
        try {
            const result = await run({
                command: ffmpegPath,
                args,
                timeoutMs,
                collectStdout: true,
            });

            return result.exitCode === 0 ? (result.stdoutText ?? '') : null;
        } catch {
            return null;
        }
    };
}

/** `ffmpeg version 9.0.1 Copyright ...` -> `9.0.1`. */
export function parseVersion(output: string): string | null {
    return /^ffmpeg version (\S+)/m.exec(output)?.[1] ?? null;
}

/** Lines such as ` V....D libx264   libx264 H.264 ...` (flags: type + 5 capability chars). */
export function parseEncoderNames(output: string): Set<string> {
    return collect(output, /^\s*[VAS][A-Z.]{5}\s+(\S+)/);
}

/** Lines such as ` T.C scale   V->V   Scale the input video ...` (3 flag chars, then `in->out`). */
export function parseFilterNames(output: string): Set<string> {
    return collect(output, /^\s*[A-Z.]{2,3}\s+(\S+)\s+\S+->\S+/);
}

/** Lines such as `  E hls    Apple HTTP Live Streaming muxer` (` E`, `D `, `DE`). */
export function parseMuxerNames(output: string): Set<string> {
    return collect(output, /^\s*(?:D?E)\s+(\S+)/, true);
}

function collect(output: string, pattern: RegExp, splitCommas = false): Set<string> {
    const names = new Set<string>();

    for (const line of output.split(/\r?\n/)) {
        const name = pattern.exec(line)?.[1];
        if (name === undefined) continue;
        for (const part of splitCommas ? name.split(',') : [name]) names.add(part);
    }

    return names;
}

function missingFrom(
    kind: string,
    required: readonly string[],
    available: Set<string> | null,
): string[] {
    return required
        .filter((name) => available === null || !available.has(name))
        .map((n) => `${kind}:${n}`);
}

export async function checkFfmpeg(runner: FfmpegTextRunner): Promise<FfmpegCheckResult> {
    const [versionText, encoders, filters, muxers] = await Promise.all([
        runner(['-hide_banner', '-version']),
        runner(['-hide_banner', '-encoders']),
        runner(['-hide_banner', '-filters']),
        runner(['-hide_banner', '-muxers']),
    ]);

    const version = versionText === null ? null : parseVersion(versionText);
    const missing = [
        ...(version === null ? ['ffmpeg:version'] : []),
        ...missingFrom(
            'encoder',
            REQUIRED_ENCODERS,
            encoders === null ? null : parseEncoderNames(encoders),
        ),
        ...missingFrom('muxer', REQUIRED_MUXERS, muxers === null ? null : parseMuxerNames(muxers)),
        ...missingFrom(
            'filter',
            REQUIRED_FILTERS,
            filters === null ? null : parseFilterNames(filters),
        ),
    ];

    return { ok: missing.length === 0, version, missing };
}
