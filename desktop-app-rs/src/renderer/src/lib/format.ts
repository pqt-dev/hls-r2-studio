import type { JobState } from '../../../shared/types';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human readable size with binary steps (1 KB = 1024 B): "512 B", "1.5 MB", "12 GB". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';

    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }

    if (unit === 0) return `${Math.round(value)} B`;

    // One decimal below 10, none above, so columns stay narrow.
    const text = value < 10 ? value.toFixed(1) : Math.round(value).toString();

    return `${text} ${UNITS[unit]}`;
}

const RELATIVE_STEPS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'day', seconds: 86_400 },
    { unit: 'hour', seconds: 3_600 },
    { unit: 'minute', seconds: 60 },
];

/** "just now", "5 minutes ago", "2 hours ago", "yesterday". `now` is injected for testing. */
export function formatRelativeTime(iso: string, now: number): string {
    const time = Date.parse(iso);

    if (Number.isNaN(time)) return '';

    const seconds = Math.round((now - time) / 1000);

    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} seconds ago`;

    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

    for (const step of RELATIVE_STEPS) {
        if (seconds >= step.seconds) {
            return formatter.format(-Math.floor(seconds / step.seconds), step.unit);
        }
    }

    return 'just now';
}

/** Absolute local date and time, used for tooltips. */
export function formatDateTime(iso: string): string {
    const time = new Date(iso);

    if (Number.isNaN(time.getTime())) return '';

    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

export const STAGE_LABELS: Record<JobState, string> = {
    waiting: 'Waiting',
    transcoding: 'Transcoding',
    thumbnail: 'Thumbnail',
    storyboard: 'Storyboard',
    uploading: 'Uploading',
    registering: 'Registering',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    register_failed: 'Register failed',
    needs_sign_in: 'Sign-in needed',
    upload_interrupted: 'Upload paused',
};

export function stageLabel(state: JobState): string {
    return STAGE_LABELS[state];
}

/** Host part of a site URL for display; falls back to the raw text. */
export function siteHost(url: string | undefined): string {
    if (url === undefined || url === '') return '';

    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "m:ss" or "h:mm:ss" from seconds; "" when the value is missing or invalid. */
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return '';
    }

    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}`
        : `${minutes}:${secs}`;
}

/** Local calendar date such as "Jan 1, 2026"; "" when missing or invalid. */
export function formatDate(iso: string | null | undefined): string {
    if (iso === null || iso === undefined) return '';

    const time = new Date(iso);

    if (Number.isNaN(time.getTime())) return '';

    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(time);
}

/**
 * Quality label from the SHORTER side of the video, so a portrait video is classed like its
 * landscape twin (1080x1920 is "1080p", not "1920p"). Buckets by short side, with some tolerance
 * for odd encodes (the lower bound of each bucket is inclusive):
 *
 *   >= 4000  8K        >= 1000  1080p     >= 340  360p
 *   >= 2000  4K        >=  700  720p      >= 220  240p
 *   >= 1300  1440p     >=  460  480p      >= 130  144p
 *
 * Anything smaller shows its short side ("96p"). Missing width: the height is taken as the short
 * side. "" when nothing usable is known.
 */
const QUALITY_BUCKETS: ReadonlyArray<readonly [number, string]> = [
    [4000, '8K'],
    [2000, '4K'],
    [1300, '1440p'],
    [1000, '1080p'],
    [700, '720p'],
    [460, '480p'],
    [340, '360p'],
    [220, '240p'],
    [130, '144p'],
];

export function formatQuality(
    width: number | null | undefined,
    height: number | null | undefined,
): string {
    const valid = (value: number | null | undefined): value is number =>
        value !== null && value !== undefined && Number.isFinite(value) && value > 0;
    const sides = [width, height].filter(valid);

    if (sides.length === 0) return '';

    const short = Math.min(...sides);
    const bucket = QUALITY_BUCKETS.find(([min]) => short >= min);

    return bucket === undefined ? `${Math.round(short)}p` : bucket[1];
}

/** "30 fps" (decimals only when needed, e.g. "29.97 fps"); "" when unknown. */
export function formatFps(fps: number | null | undefined): string {
    if (fps === null || fps === undefined || !Number.isFinite(fps) || fps <= 0) return '';

    const text = Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 100) / 100);

    return `${text} fps`;
}

/** "2400 kbps" from a bitrate already in kilobits per second; "" when unknown. */
export function formatBitrate(kbps: number | null | undefined): string {
    if (kbps === null || kbps === undefined || !Number.isFinite(kbps) || kbps <= 0) return '';

    return `${Math.round(kbps)} kbps`;
}

/** "1920x1080"; "" when either side is missing or invalid. */
export function formatResolution(
    width: number | null | undefined,
    height: number | null | undefined,
): string {
    const ok = (value: number | null | undefined): value is number =>
        value !== null && value !== undefined && Number.isFinite(value) && value > 0;

    return ok(width) && ok(height) ? `${Math.round(width)}\u00d7${Math.round(height)}` : '';
}
