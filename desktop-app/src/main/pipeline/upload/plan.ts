/** Pure planning helpers for the R2 upload step (no I/O; sleeping is injected). */
import { PLAYLIST_FILE } from '../fileNames';

export const UPLOAD_CONCURRENCY = 5;
export const UPLOAD_MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const UPLOAD_RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

const SEGMENT_NAME = /^segment_\d{3,}\.ts$/;
const STORYBOARD_NAME = /^storyboard_(?:3x3|4x4|5x5)\.jpg$/;

function isUploadName(name: string): boolean {
    return (
        name === PLAYLIST_FILE ||
        name === 'thumbnail.jpg' ||
        SEGMENT_NAME.test(name) ||
        STORYBOARD_NAME.test(name)
    );
}

/**
 * Selects the output files from the (top-level) names of a job directory: `segment_NNN.ts`,
 * `thumbnail.jpg`, `storyboard_NxN.jpg` and `playlist.m3u8`. Anything else (candidate_*, tile_*,
 * thumb_candidate_*, ffmpeg temp files, sub-directories) is ignored. Order: segments (natural
 * order), thumbnail, storyboards, and `playlist.m3u8` always LAST.
 */
export function listUploadFiles(names: readonly string[]): string[] {
    const unique = [...new Set(names)].filter(isUploadName);
    const rest = unique.filter((n) => n !== PLAYLIST_FILE).sort(compareNames);

    return unique.includes(PLAYLIST_FILE) ? [...rest, PLAYLIST_FILE] : rest;
}

function compareNames(a: string, b: string): number {
    return a.localeCompare(b, 'en', { numeric: true });
}

export function contentTypeFor(name: string): string {
    if (name.endsWith('.m3u8')) {
        return 'application/vnd.apple.mpegurl';
    }

    if (name.endsWith('.ts')) {
        return 'video/mp2t';
    }

    if (name.endsWith('.jpg')) {
        return 'image/jpeg';
    }

    throw new Error(`No content type for file: ${name}`);
}

/** `prefix + name`; the layout is flat, so a name must not contain a path separator. */
export function objectKey(prefix: string, name: string): string {
    if (name === '' || /[/\\]/.test(name)) {
        throw new Error(`Invalid object name: ${JSON.stringify(name)}`);
    }

    return prefix + name;
}

/** Upload stage fraction: files done / total files (1 when there is nothing to upload). */
export function progressFromUploaded(done: number, total: number): number {
    if (total <= 0) {
        return 1;
    }

    return Math.min(1, Math.max(0, done / total));
}

export interface RetryOptions {
    /** Waits before each retry; total attempts = `delaysMs.length + 1`. */
    delaysMs: readonly number[];
    sleep: (ms: number) => Promise<void>;
    /** Return false to stop retrying and rethrow immediately. Default: always retry. */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Called before each wait, e.g. for logging. */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Runs `fn(attempt)` (attempt is 1-based), retrying on errors with the given delays. */
export async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions,
): Promise<T> {
    const maxAttempts = options.delaysMs.length + 1;

    for (let attempt = 1; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            const delay = options.delaysMs[attempt - 1];

            if (attempt >= maxAttempts || delay === undefined) {
                throw error;
            }

            if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
                throw error;
            }

            options.onRetry?.(error, attempt, delay);
            await options.sleep(delay);
        }
    }
}
