/** An entry of the pager: a page number, or a non-interactive gap (kept apart for React keys). */
export type PageItem = number | 'gap-start' | 'gap-end';

/**
 * The page numbers to show, e.g. `1 … 4 5 [6] 7 8 … 1000`: always the first and the last page and
 * the current one +/- `radius`; every other run of pages collapses into a gap. A gap that would hide
 * exactly one page shows that page instead (an ellipsis is no shorter than the number it replaces).
 * `current` is clamped into 1..lastPage and `lastPage` is at least 1.
 */
export function pageWindow(current: number, lastPage: number, radius = 2): PageItem[] {
    const last = Math.max(1, Math.trunc(lastPage));
    const page = Math.min(last, Math.max(1, Math.trunc(current)));
    const from = Math.max(1, page - radius);
    const to = Math.min(last, page + radius);
    const items: PageItem[] = [];

    if (from > 1) {
        items.push(1);

        if (from === 3) items.push(2);
        else if (from > 3) items.push('gap-start');
    }

    for (let n = from; n <= to; n += 1) items.push(n);

    if (to < last) {
        if (to === last - 2) items.push(last - 1);
        else if (to < last - 2) items.push('gap-end');

        items.push(last);
    }

    return items;
}

/** Parses the "Go to page" text: digits only; the page is clamped into 1..lastPage. */
export function parseJump(raw: string, lastPage: number): number | null {
    const text = raw.trim();

    if (!/^\d+$/.test(text)) return null;

    const value = Number(text);
    const last = Math.max(1, Math.trunc(lastPage));

    return Math.min(last, Math.max(1, value));
}
