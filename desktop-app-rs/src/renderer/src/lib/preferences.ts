/**
 * UI preferences (view mode, page sizes) kept in `localStorage`. Data and secrets never go here:
 * they stay in Rust. Storage can be unavailable (blocked, private mode): every read falls back to
 * the default and every write is silently skipped, so the choice then only lasts for the session.
 */

export const PREF_KEYS = {
    queuePerPage: 'hls.queue.perPage',
    libraryPerPage: 'hls.library.perPage',
    // Kept from the first release of the view toggle, so saved choices survive the update.
    libraryViewMode: 'hls-r2-studio:library-view',
} as const;

/**
 * The stored value when it is one of `allowed` (compared as text, so numbers work); otherwise
 * `fallback` (missing, invalid or unreadable).
 */
export function readPreference<T extends string | number>(
    key: string,
    allowed: readonly T[],
    fallback: T,
): T {
    try {
        const raw = window.localStorage.getItem(key);

        if (raw === null) return fallback;

        return allowed.find((value) => String(value) === raw) ?? fallback;
    } catch {
        return fallback;
    }
}

export function writePreference(key: string, value: string | number): void {
    try {
        window.localStorage.setItem(key, String(value));
    } catch {
        // Storage can be blocked: the choice then only lasts until the app closes.
    }
}
