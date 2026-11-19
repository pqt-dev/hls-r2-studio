/** Default number of trailing characters kept visible by the middle ellipsis. */
export const URL_TAIL_LENGTH = 22;

/**
 * Splits a URL into a head (which CSS may ellipsise) and a tail (always shown) so both the start
 * and the end of a long URL stay visible. A URL no longer than `tailLength` is returned whole in
 * `head` with an empty `tail`, so the tail is never longer than the URL.
 */
export function splitUrlForMiddleEllipsis(
    url: string,
    tailLength: number = URL_TAIL_LENGTH,
): { head: string; tail: string } {
    const tailLen = Math.max(0, Math.floor(tailLength));

    if (tailLen === 0 || url.length <= tailLen) return { head: url, tail: '' };

    return { head: url.slice(0, url.length - tailLen), tail: url.slice(url.length - tailLen) };
}
