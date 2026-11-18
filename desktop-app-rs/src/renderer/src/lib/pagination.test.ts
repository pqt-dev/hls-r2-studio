import { describe, expect, it } from 'vitest';
import { pageWindow, parseJump } from './pagination';

describe('pageWindow', () => {
    it('shows a single page', () => {
        expect(pageWindow(1, 1)).toEqual([1]);
    });

    it('shows two pages without gaps', () => {
        expect(pageWindow(1, 2)).toEqual([1, 2]);
        expect(pageWindow(2, 2)).toEqual([1, 2]);
    });

    it('collapses the far end of 7 pages when the current page is the first', () => {
        expect(pageWindow(1, 7)).toEqual([1, 2, 3, 'gap-end', 7]);
    });

    it('collapses the far end for 1000 pages at the start', () => {
        expect(pageWindow(1, 1000)).toEqual([1, 2, 3, 'gap-end', 1000]);
    });

    it('collapses both sides for the current page in the middle', () => {
        expect(pageWindow(6, 1000)).toEqual([1, 'gap-start', 4, 5, 6, 7, 8, 'gap-end', 1000]);
        expect(pageWindow(500, 1000)).toEqual([
            1,
            'gap-start',
            498,
            499,
            500,
            501,
            502,
            'gap-end',
            1000,
        ]);
    });

    it('collapses the near end for the current page at the end', () => {
        expect(pageWindow(1000, 1000)).toEqual([1, 'gap-start', 998, 999, 1000]);
    });

    it('shows the page instead of a gap that would hide exactly one page', () => {
        expect(pageWindow(5, 1000)).toEqual([1, 2, 3, 4, 5, 6, 7, 'gap-end', 1000]);
        expect(pageWindow(996, 1000)).toEqual([1, 'gap-start', 994, 995, 996, 997, 998, 999, 1000]);
    });

    it('lists every page of a short range once, in order', () => {
        expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('clamps out-of-range input', () => {
        expect(pageWindow(0, 10)).toEqual(pageWindow(1, 10));
        expect(pageWindow(99, 10)).toEqual(pageWindow(10, 10));
        expect(pageWindow(3, 0)).toEqual([1]);
    });

    it('always contains first, last and current, with no duplicates', () => {
        for (const last of [1, 2, 3, 7, 8, 9, 50, 1000]) {
            for (let current = 1; current <= last; current += Math.max(1, Math.floor(last / 13))) {
                const numbers = pageWindow(current, last).filter(
                    (item) => typeof item === 'number',
                );

                expect(numbers).toContain(1);
                expect(numbers).toContain(last);
                expect(numbers).toContain(current);
                expect(new Set(numbers).size).toBe(numbers.length);
                expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
            }
        }
    });
});

describe('parseJump', () => {
    it('accepts digits and clamps into 1..last', () => {
        expect(parseJump('5', 10)).toBe(5);
        expect(parseJump(' 7 ', 10)).toBe(7);
        expect(parseJump('0', 10)).toBe(1);
        expect(parseJump('99', 10)).toBe(10);
        expect(parseJump('9'.repeat(400), 10)).toBe(10);
    });

    it('rejects anything that is not a whole number', () => {
        for (const raw of ['', '  ', 'abc', '-3', '1.5', '2e3', '3x', '+4']) {
            expect(parseJump(raw, 10)).toBeNull();
        }
    });
});
