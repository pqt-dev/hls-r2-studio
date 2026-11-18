/** Parses the current-page input text: digits only; the page is clamped into 1..lastPage. */
export function parseJump(raw: string, lastPage: number): number | null {
    const text = raw.trim();

    if (!/^\d+$/.test(text)) return null;

    const value = Number(text);
    const last = Math.max(1, Math.trunc(lastPage));

    return Math.min(last, Math.max(1, value));
}
