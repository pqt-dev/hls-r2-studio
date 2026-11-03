import { ASCII_TABLE } from './asciiTable.generated';

/**
 * Slug generation equivalent to Laravel's `Str::slug(pathinfo($filename, PATHINFO_FILENAME)) ?: 'video'`.
 *
 * Approach: no dependency. Laravel's `Str::slug` first calls `Str::ascii()` (voku/portable-ascii,
 * language 'en'), so `asciiTable.generated.ts` is a table extracted from that very function by
 * `scripts/gen-ascii-table.php` (Latin-1/Extended-A/B, Latin Extended Additional incl. all
 * Vietnamese, Greek, Cyrillic, punctuation, currency, ligatures). A generated table gives exact
 * parity with the PHP implementation for those blocks (verified by the golden test), is
 * deterministic and adds no runtime dependency or supply-chain risk.
 *
 * Known limitation: scripts that PHP transliterates with its huge tables but are NOT in the
 * generated table (CJK, Arabic, Hebrew, Thai, Devanagari, ...) are dropped here, so such names may
 * produce a shorter slug (or the 'video' fallback) than PHP would. The result is still always
 * `[a-z0-9-]+`, never starts/ends with '-', and is accepted by the server regex.
 */

export const SLUG_FALLBACK = 'video';

/** PHP `pathinfo($name, PATHINFO_FILENAME)`: basename without the part after the last dot. */
export function baseNameWithoutExtension(filename: string): string {
    // PHP basename(): ignores trailing '/' and keeps only the last path component.
    const trimmed = filename.replace(/\/+$/, '');
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');

    // No dot: whole name. ".hidden" has its only dot at index 0 -> PHP returns '' as the filename.
    return dot === -1 ? base : base.slice(0, dot);
}

/** Equivalent of `Str::ascii($value, 'en')` for the supported blocks. */
function toAscii(input: string): string {
    let out = '';

    for (const char of input) {
        const cp = char.codePointAt(0) ?? 0;

        if (cp < 0x80) {
            // portable-ascii keeps printable ASCII plus tab/CR/LF and drops other control chars.
            if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x09 || cp === 0x0a || cp === 0x0d) {
                out += char;
            }
        } else {
            out += ASCII_TABLE[cp] ?? '';
        }
    }

    return out;
}

/** Equivalent of `Str::slug($title)`; may return an empty string (see {@link slugify}). */
export function laravelSlug(title: string): string {
    return toAscii(title)
        .replace(/_+/g, '-')
        .replaceAll('@', '-at-')
        .toLowerCase()
        .replace(/[^-a-z0-9\s]+/g, '')
        .replace(/[-\s]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Slug for a file name WITHOUT extension; falls back to 'video' when nothing is left. */
export function slugify(filenameWithoutExtension: string): string {
    return laravelSlug(filenameWithoutExtension) || SLUG_FALLBACK;
}
