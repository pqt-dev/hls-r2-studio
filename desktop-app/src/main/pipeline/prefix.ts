import { storyboardFileName } from './fileNames';

/** Maximum length of the slug part of a prefix, always applied (server columns are varchar(255)). */
export const MAX_SLUG_LENGTH = 100;
/** Server `disk_prefix` / `playlist_path` / `thumbnail_path` columns are varchar(255). */
export const MAX_KEY_LENGTH = 255;

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export interface BuildPrefixInput {
    now: Date;
    slug: string;
    publicId: string;
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

function formatPrefix(now: Date, slug: string, publicId: string): string {
    const date = [
        pad(now.getUTCFullYear(), 4),
        pad(now.getUTCMonth() + 1, 2),
        pad(now.getUTCDate(), 2),
    ].join('/');

    return `${date}/${slug}-${publicId}/`;
}

/**
 * Builds `{YYYY}/{MM}/{DD}/{slug}-{publicId}/` from UTC date fields. The slug is ALWAYS capped at
 * 100 characters, so the longest key (`prefix + storyboard_5x5.jpg`) stays within 255 characters.
 */
export function buildPrefix({ now, slug, publicId }: BuildPrefixInput): string {
    if (!SLUG_PATTERN.test(slug)) {
        throw new Error('Slug must be a non-empty string of [a-z0-9-].');
    }

    if (Number.isNaN(now.getTime())) {
        throw new Error('Invalid date for the upload prefix.');
    }

    const longestName = storyboardFileName(5);
    const capped = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '') || 'video';
    let prefix = formatPrefix(now, capped, publicId);

    if (prefix.length + longestName.length > MAX_KEY_LENGTH) {
        // Defensive: only reachable with an abnormally long public id. Cut the slug further.
        const room = MAX_KEY_LENGTH - longestName.length - (prefix.length - capped.length);
        const shorter = capped.slice(0, Math.max(1, room)).replace(/-+$/, '') || 'v';

        prefix = formatPrefix(now, shorter, publicId);
    }

    if (prefix.length + longestName.length > MAX_KEY_LENGTH) {
        throw new Error('The upload prefix is too long.');
    }

    return prefix;
}

/** The exact regex the server applies to `disk_prefix` (spec 3.5), anchored and bound to publicId. */
export function isValidPrefix(prefix: string, publicId: string): boolean {
    if (!/^[a-z0-9]{12}$/.test(publicId)) {
        return false;
    }

    return new RegExp(`^\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+-${publicId}/$`).test(prefix);
}
