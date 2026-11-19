import { describe, expect, it } from 'vitest';
import { splitUrlForMiddleEllipsis } from './middleEllipsis';

describe('splitUrlForMiddleEllipsis', () => {
    it('keeps a short URL whole in the head', () => {
        expect(splitUrlForMiddleEllipsis('https://a.io/x.jpg', 22)).toEqual({
            head: 'https://a.io/x.jpg',
            tail: '',
        });
        expect(splitUrlForMiddleEllipsis('a'.repeat(22), 22)).toEqual({
            head: 'a'.repeat(22),
            tail: '',
        });
    });

    it('splits a long URL into head and the last N characters', () => {
        const url = 'https://cdn.example.com/videos/abcdefghijkl/thumb.jpg';
        const { head, tail } = splitUrlForMiddleEllipsis(url, 22);

        expect(tail).toHaveLength(22);
        expect(tail).toBe(url.slice(-22));
        expect(head + tail).toBe(url);
        expect(head.length).toBeGreaterThan(0);
    });

    it('handles an empty URL and a non-positive tail length', () => {
        expect(splitUrlForMiddleEllipsis('')).toEqual({ head: '', tail: '' });
        expect(splitUrlForMiddleEllipsis('https://a.io/x', 0)).toEqual({
            head: 'https://a.io/x',
            tail: '',
        });
    });

    it('uses about 22 characters by default', () => {
        expect(splitUrlForMiddleEllipsis('x'.repeat(60)).tail).toHaveLength(22);
    });
});
