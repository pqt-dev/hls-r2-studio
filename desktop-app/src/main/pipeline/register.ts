/** Register payload (spec 3.5), client-side validation and API error mapping (spec 4.4 step 7). */
import type { RegisterPayloadRecord } from '../../shared/types';
import type { OutputInfo } from '../ffmpeg/probeParse';
import { PLAYLIST_FILE, THUMBNAIL_FILE, storyboardFileName } from './fileNames';
import { isValidPrefix, MAX_KEY_LENGTH } from './prefix';
import { isValidPublicId } from './publicId';
import { baseNameWithoutExtension } from './slug';
import { storyboardJson } from './storyboardPlan';

/** Same shape as the persisted copy in shared/types.ts, so a stored payload can be retried. */
export type RegisterPayload = RegisterPayloadRecord;

export interface BuildRegisterPayloadInput {
    publicId: string;
    prefix: string;
    originalFilename: string;
    originalSizeBytes: number;
    duration: number | null;
    hasThumbnail: boolean;
    /** Grid sizes (3, 4, 5) whose storyboard image exists. */
    storyboardGrids: readonly number[];
    /** Null when the output probe failed (all output fields become null). */
    output: OutputInfo | null;
}

function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildRegisterPayload(input: BuildRegisterPayloadInput): RegisterPayload {
    const base = baseNameWithoutExtension(input.originalFilename).trim();
    const output = input.output;

    return {
        public_id: input.publicId,
        // A name like ".hidden" has an empty base; the server requires a title, so keep the name.
        title: base === '' ? input.originalFilename.trim() : base,
        original_filename: input.originalFilename,
        original_size_bytes: input.originalSizeBytes,
        disk_prefix: input.prefix,
        playlist_path: input.prefix + PLAYLIST_FILE,
        thumbnail_path: input.hasThumbnail ? input.prefix + THUMBNAIL_FILE : null,
        storyboards: storyboardJson(input.storyboardGrids, input.prefix),
        duration: input.duration,
        output_width: output?.width ?? null,
        output_height: output?.height ?? null,
        output_fps: output?.fps == null ? null : round2(output.fps),
        output_bitrate_kbps: output?.bitrateKbps == null ? null : Math.round(output.bitrateKbps),
        output_codec: output?.codec ?? null,
    };
}

const STORYBOARD_KEYS = ['3x3', '4x4', '5x5'];

function charLength(value: string): number {
    return [...value].length;
}

function isIntInRange(value: unknown, min: number, max: number): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const PATH_TOO_LONG = `Paths must be at most ${MAX_KEY_LENGTH} characters.`;

/**
 * Checks that every path derived from `prefix` (the longest is the 5x5 storyboard) fits the
 * server's varchar(255) columns. Run before any upload starts. Empty array = fits.
 */
export function validatePrefixLength(prefix: string): string[] {
    const longest = Math.max(
        prefix.length,
        (prefix + PLAYLIST_FILE).length,
        (prefix + THUMBNAIL_FILE).length,
        ...[3, 4, 5].map((grid) => (prefix + storyboardFileName(grid)).length),
    );

    return longest > MAX_KEY_LENGTH ? [`The upload location is too long. ${PATH_TOO_LONG}`] : [];
}

/** Mirrors the server rules of `Api\App\VideoController::rules()`. Empty array = valid. */
export function validateRegisterPayload(payload: RegisterPayload): string[] {
    const errors: string[] = [];

    if (!isValidPublicId(payload.public_id)) {
        errors.push('public_id must be 12 characters of a-z and 0-9.');
    }

    const title = payload.title;

    if (typeof title !== 'string' || title.trim() === '' || charLength(title) > 255) {
        errors.push('title is required and must be at most 255 characters.');
    }

    const filename = payload.original_filename;

    if (typeof filename !== 'string' || filename.trim() === '' || charLength(filename) > 255) {
        errors.push('original_filename is required and must be at most 255 characters.');
    }

    if (!isIntInRange(payload.original_size_bytes, 1, Number.MAX_SAFE_INTEGER)) {
        errors.push('original_size_bytes must be an integer of at least 1.');
    }

    const prefixOk =
        isValidPublicId(payload.public_id) && isValidPrefix(payload.disk_prefix, payload.public_id);

    if (!prefixOk) {
        errors.push('disk_prefix must look like YYYY/MM/DD/<slug>-<public_id>/.');
    }

    const prefix = prefixOk ? payload.disk_prefix : null;

    const lengths = [
        payload.disk_prefix,
        payload.playlist_path,
        payload.thumbnail_path,
        ...Object.values(payload.storyboards ?? {}).map((entry) => entry?.path),
    ];

    if (lengths.some((value) => typeof value === 'string' && value.length > MAX_KEY_LENGTH)) {
        errors.push(
            `disk_prefix, playlist_path, thumbnail_path and storyboard paths must each be at most ${MAX_KEY_LENGTH} characters.`,
        );
    }

    if (prefix === null || payload.playlist_path !== prefix + PLAYLIST_FILE) {
        errors.push('playlist_path must be disk_prefix + "playlist.m3u8".');
    }

    if (
        payload.thumbnail_path !== null &&
        (prefix === null || payload.thumbnail_path !== prefix + THUMBNAIL_FILE)
    ) {
        errors.push('thumbnail_path must be null or disk_prefix + "thumbnail.jpg".');
    }

    if (payload.storyboards !== null) {
        const valid =
            typeof payload.storyboards === 'object' &&
            Object.entries(payload.storyboards).every(
                ([key, entry]) =>
                    prefix !== null &&
                    STORYBOARD_KEYS.includes(key) &&
                    Object.keys(entry).length === 1 &&
                    entry.path === `${prefix}storyboard_${key}.jpg`,
            );

        if (!valid) {
            errors.push(
                'storyboards must be null or contain only 3x3/4x4/5x5 entries with valid paths.',
            );
        }
    }

    if (
        payload.duration !== null &&
        !(
            typeof payload.duration === 'number' &&
            Number.isFinite(payload.duration) &&
            payload.duration >= 0
        )
    ) {
        errors.push('duration must be null or a number of at least 0.');
    }

    if (payload.output_width !== null && !isIntInRange(payload.output_width, 1, 65535)) {
        errors.push('output_width must be null or an integer from 1 to 65535.');
    }

    if (payload.output_height !== null && !isIntInRange(payload.output_height, 1, 65535)) {
        errors.push('output_height must be null or an integer from 1 to 65535.');
    }

    if (
        payload.output_fps !== null &&
        !(
            typeof payload.output_fps === 'number' &&
            payload.output_fps >= 0 &&
            payload.output_fps <= 999.99
        )
    ) {
        errors.push('output_fps must be null or a number from 0 to 999.99.');
    }

    if (
        payload.output_bitrate_kbps !== null &&
        !isIntInRange(payload.output_bitrate_kbps, 0, 4294967295)
    ) {
        errors.push('output_bitrate_kbps must be null or an integer from 0 to 4294967295.');
    }

    if (
        payload.output_codec !== null &&
        !(typeof payload.output_codec === 'string' && charLength(payload.output_codec) <= 20)
    ) {
        errors.push('output_codec must be null or at most 20 characters.');
    }

    return errors;
}

// ---- API error mapping --------------------------------------------------------------------

/** Waits before each retry; 1 first attempt + 5 retries (see the B2 report for the open question). */
export const REGISTER_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

/** What went wrong calling `POST /api/app/videos`: no HTTP response, or a status (+ error code). */
export type RegisterFailure =
    | { kind: 'network' }
    | {
          kind: 'http';
          status: number;
          errorCode?: string | null;
          /** Numeric `Retry-After` header value in seconds (only used for HTTP 429). */
          retryAfterSeconds?: number | null;
      };

/** Upper bound for a server supplied `Retry-After`, so a bad header cannot stall a job. */
export const MAX_RETRY_AFTER_MS = 60000;

export interface RegisterErrorInfo {
    /** True: retry with backoff (network, 5xx, 429). */
    retryable: boolean;
    /** Wait to use instead of the normal backoff step (429 with a valid Retry-After), else null. */
    retryAfterMs: number | null;
    /**
     * True only for the server error codes `playlist_not_found` (422) and `public_id_conflict`
     * (409): the site definitively rejected this video, so the job fails and the R2 objects are
     * deleted. Other non-retryable answers keep the upload for a later retry.
     */
    definitive: boolean;
    /** True: keep the job at "Waiting for sign-in" and call register again after sign-in. */
    needsSignIn: boolean;
    userMessage: string;
}

export function mapRegisterError(failure: RegisterFailure): RegisterErrorInfo {
    if (failure.kind === 'network') {
        return {
            retryable: true,
            retryAfterMs: null,
            definitive: false,
            needsSignIn: false,
            userMessage: 'Could not reach the site. Check your internet connection.',
        };
    }

    const { status, errorCode } = failure;

    if (status === 429) {
        const seconds = failure.retryAfterSeconds;
        const valid = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;

        return {
            retryable: true,
            retryAfterMs: valid ? Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000)) : null,
            definitive: false,
            needsSignIn: false,
            userMessage: 'The site is busy (too many requests). Retrying shortly.',
        };
    }

    if (status >= 500) {
        return {
            retryable: true,
            retryAfterMs: null,
            definitive: false,
            needsSignIn: false,
            userMessage:
                errorCode === 'storage_unavailable'
                    ? 'The site could not reach R2 storage right now.'
                    : 'The site had a temporary problem. Please try again.',
        };
    }

    if (status === 401) {
        return {
            retryable: false,
            retryAfterMs: null,
            definitive: false,
            needsSignIn: true,
            userMessage: 'Your session has expired. Sign in again to finish registering the video.',
        };
    }

    const fatal = (userMessage: string, definitive = true): RegisterErrorInfo => ({
        retryable: false,
        retryAfterMs: null,
        definitive,
        needsSignIn: false,
        userMessage,
    });

    // Only these two server codes prove the video can never be registered as it is.
    if (status === 409 && errorCode === 'public_id_conflict') {
        return fatal('This video ID is already used by a different video. Start the upload again.');
    }

    if (status === 422 && errorCode === 'playlist_not_found') {
        return fatal('The playlist was not found on R2, so the video was not registered.');
    }

    // A generic 409/422 (no known code) may be a validation or proxy problem: keep the upload.
    if (status === 409 || status === 422) {
        return fatal(
            status === 409
                ? 'The site could not register the video because of a conflict.'
                : 'The site rejected the video data as invalid.',
            false,
        );
    }

    // Any other 4xx (400, 403, 404, 405, 413, ...) may come from a wrong site URL or a proxy:
    // keep the upload so the user can retry after fixing the configuration.
    return fatal(
        `The site rejected the request (HTTP ${status}). Check the site settings, then retry.`,
        false,
    );
}
