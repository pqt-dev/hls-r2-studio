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
