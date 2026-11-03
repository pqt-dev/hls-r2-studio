/**
 * Pure argument builders for ffmpeg/ffprobe (no binary name in the result). Every builder mirrors
 * the PHP pipeline (TranscodeVideoJob, ThumbnailGenerator, StoryboardGenerator). Output files use
 * simple relative ASCII names because the process runs with `cwd` = the job temp directory.
 */
import {
    CANDIDATE_PATTERN,
    PLAYLIST_FILE,
    SEGMENT_PATTERN,
    THUMBNAIL_FILE,
    storyboardFileName,
    tileSequencePattern,
} from '../pipeline/fileNames';

export const PROBE_TIMEOUT_SECONDS = 60;
export const IMAGE_COMMAND_TIMEOUT_SECONDS = 60;
export const UNKNOWN_DURATION_TIMEOUT_SECONDS = 172800;
export const TRANSCODE_TIMEOUT_MULTIPLIER = 8;
export const TRANSCODE_MIN_TIMEOUT_SECONDS = 600;
export const STORYBOARD_TIMEOUT_MULTIPLIER = 2;
export const STORYBOARD_MIN_TIMEOUT_SECONDS = 60;

export const DEFAULT_MAX_WIDTH = 1280;
const RESOLUTION_WIDTHS: Readonly<Record<string, number>> = {
    '480': 854,
    '720': 1280,
    '1080': 1920,
};

export const STORYBOARD_TILE_SIZE = 160;
export const STORYBOARD_TOTAL_CANDIDATES = 75;

/**
 * Demuxer allow-list (INPUT option) for every command that reads the user's source file. It
 * covers the five accepted containers (.mp4/.mov = `mov,mp4,m4a,3gp,3g2,mj2`, .mkv/.webm =
 * `matroska,webm`, .avi) and blocks network-capable demuxers such as `hls` or `concat`, so a
 * playlist renamed to `.mp4` cannot make ffmpeg fetch other files or URLs.
 */
export const SOURCE_FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi';

const SOURCE_FORMAT_ARGS = ['-format_whitelist', SOURCE_FORMAT_WHITELIST];

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * PHP casts floats to string with `precision=14`; mimic it so timestamps and durations render the
 * same way (12.0 -> "12", 1/3 -> "0.33333333333333").
 */
export function formatNumber(value: number): string {
    return String(Number(value.toPrecision(14)));
}

export function maxWidthForResolution(resolution: string | number): number {
    return RESOLUTION_WIDTHS[String(resolution)] ?? DEFAULT_MAX_WIDTH;
}

/** `max(1, round(outputFps * segmentSeconds))`. */
export function computeGop(outputFps: number, segmentSeconds: number): number {
    return Math.max(1, Math.round(outputFps * segmentSeconds));
}

export function transcodeTimeoutSeconds(duration: number | null): number {
    if (duration === null) {
        return UNKNOWN_DURATION_TIMEOUT_SECONDS;
    }

    return Math.max(
        TRANSCODE_MIN_TIMEOUT_SECONDS,
        Math.ceil(duration * TRANSCODE_TIMEOUT_MULTIPLIER),
    );
}

export function storyboardTimeoutSeconds(duration: number): number {
    return Math.max(
        STORYBOARD_MIN_TIMEOUT_SECONDS,
        Math.ceil(duration * STORYBOARD_TIMEOUT_MULTIPLIER),
    );
}

function assertSafeFileName(name: string): string {
    if (!SAFE_FILE_NAME.test(name)) {
        throw new Error(`Unsafe file name for a lavfi filter: ${JSON.stringify(name)}`);
    }

    return name;
}

// ---- probes -------------------------------------------------------------------------------

export function probeDurationArgs(input: string): string[] {
    return [
        '-v',
        'error',
        ...SOURCE_FORMAT_ARGS,
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
    ];
}

export function probeFpsArgs(input: string): string[] {
    return [
        '-v',
        'error',
        ...SOURCE_FORMAT_ARGS,
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=r_frame_rate',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
    ];
}

/** Probes the first output segment (`segment_000.ts`) for the register payload. */
export function probeOutputInfoArgs(segmentFile: string): string[] {
    return [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate,bit_rate,codec_name',
        '-of',
        'json',
        segmentFile,
    ];
}

// ---- transcode ----------------------------------------------------------------------------

export interface TranscodeArgsInput {
    input: string;
    /** Config resolution ('480' | '720' | '1080'); anything else maps to 1280 px. */
    resolution: string | number;
    segmentSeconds: number;
    /** Config `transcode.fps`; null keeps the source frame rate (no `-r`). */
    fps: number | null;
    /** Frame rate used for the GOP: `fps` when set, otherwise the probed source fps. */
    outputFps: number;
    /** Optional encoder thread limit (PHP `FFMPEG_THREADS`); omitted when null/undefined. */
    threads?: number | null;
}

export function transcodeArgs(options: TranscodeArgsInput): string[] {
    const maxWidth = maxWidthForResolution(options.resolution);
    const gop = String(computeGop(options.outputFps, options.segmentSeconds));

    return [
        '-y',
        ...SOURCE_FORMAT_ARGS,
        '-i',
        options.input,
        '-vf',
        `scale='min(${maxWidth},iw)':-2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-g',
        gop,
        '-keyint_min',
        gop,
        '-sc_threshold',
        '0',
        ...threadArgs(options.threads),
        ...(options.fps === null ? [] : ['-r', formatNumber(options.fps)]),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-hls_time',
        String(options.segmentSeconds),
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        SEGMENT_PATTERN,
        '-progress',
        'pipe:1',
        '-nostats',
        PLAYLIST_FILE,
    ];
}

function threadArgs(threads: number | null | undefined): string[] {
    return threads === null || threads === undefined || threads <= 0
        ? []
        : ['-threads', String(threads)];
}

// ---- thumbnail ----------------------------------------------------------------------------

/** Extracts one candidate frame (`-ss` before `-i`, `thumbnail=24` filter). */
export function thumbnailFrameArgs(input: string, timestamp: number, output: string): string[] {
    return [
        '-y',
        '-ss',
        formatNumber(timestamp),
        ...SOURCE_FORMAT_ARGS,
        '-i',
        input,
        '-vf',
        'thumbnail=24',
        '-frames:v',
        '1',
        output,
    ];
}

/** Single-frame fallback for videos shorter than 3 s (or unknown duration): frame at duration/2. */
export function shortVideoThumbnailArgs(input: string, duration: number | null): string[] {
    return thumbnailFrameArgs(input, (duration ?? 0) / 2, THUMBNAIL_FILE);
}

export function saturationProbeArgs(imageFile: string): string[] {
    return [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `movie=${assertSafeFileName(imageFile)},signalstats`,
        '-show_entries',
        'frame_tags=lavfi.signalstats.SATAVG',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
    ];
}

export function detailProbeArgs(imageFile: string): string[] {
    return [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `movie=${assertSafeFileName(imageFile)},edgedetect,signalstats`,
        '-show_entries',
        'frame_tags=lavfi.signalstats.YAVG',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
    ];
}

/** Smart-crop step 1: scale so the image covers the canvas (aspect ratio kept). */
export function smartCropScaleArgs(
    input: string,
    output: string,
    canvasWidth: number,
    canvasHeight: number,
): string[] {
    return [
        '-y',
        '-i',
        input,
        '-vf',
        `scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase`,
        '-frames:v',
        '1',
        output,
    ];
}

/** Smart-crop steps 2 (trial crops) and 3 (final crop). */
export function smartCropCropArgs(
    input: string,
    output: string,
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
): string[] {
    return [
        '-y',
        '-i',
        input,
        '-vf',
        `crop=${canvasWidth}:${canvasHeight}:${x}:${y}`,
        '-frames:v',
        '1',
        output,
    ];
}

/** Joins three 360x1080 columns into the 1080x1080 grid thumbnail. */
export function hstackArgs(columns: readonly [string, string, string], output: string): string[] {
    return [
        '-y',
        '-i',
        columns[0],
        '-i',
        columns[1],
        '-i',
        columns[2],
        '-filter_complex',
        '[0:v][1:v][2:v]hstack=inputs=3[v]',
        '-map',
        '[v]',
        '-frames:v',
        '1',
        output,
    ];
}

// ---- storyboard ---------------------------------------------------------------------------

export interface StoryboardCandidateArgsInput {
    input: string;
    duration: number;
    totalCandidates?: number;
    tileSize?: number;
    threads?: number | null;
}

/** Single decode pass extracting the evenly spaced, square-cropped candidate frames. */
export function storyboardCandidateArgs(options: StoryboardCandidateArgsInput): string[] {
    const total = options.totalCandidates ?? STORYBOARD_TOTAL_CANDIDATES;
    const tile = options.tileSize ?? STORYBOARD_TILE_SIZE;

    return [
        '-y',
        ...SOURCE_FORMAT_ARGS,
        '-i',
        options.input,
        '-vf',
        `fps=${total}/${formatNumber(options.duration)},crop='min(iw\\,ih)':'min(iw\\,ih)',scale=${tile}:${tile}`,
        '-frames:v',
        String(total),
        ...threadArgs(options.threads),
        '-start_number',
        '0',
        CANDIDATE_PATTERN,
    ];
}

export function storyboardTileArgs(gridSize: number): string[] {
    return [
        '-y',
        '-start_number',
        '0',
        '-i',
        tileSequencePattern(gridSize),
        '-vf',
        `tile=${gridSize}x${gridSize}`,
        '-frames:v',
        '1',
        storyboardFileName(gridSize),
    ];
}
