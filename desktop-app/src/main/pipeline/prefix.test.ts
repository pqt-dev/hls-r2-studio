import { describe, expect, it } from 'vitest';
import { buildPrefix, isValidPrefix, MAX_KEY_LENGTH, MAX_SLUG_LENGTH } from './prefix';
import { slugify } from './slug';

const ID = 'ab12cd34ef56';

describe('buildPrefix', () => {
    it('uses UTC date fields and a flat slug-id folder', () => {
        const now = new Date('2026-03-05T23:59:59Z');

        expect(buildPrefix({ now, slug: 'my-video', publicId: ID })).toBe(
            '2026/03/05/my-video-ab12cd34ef56/',
        );
    });

    it('is UTC even when the local date differs (late evening UTC-5 is already next day UTC)', () => {
        expect(
            buildPrefix({ now: new Date('2026-12-31T23:30:00-05:00'), slug: 'x', publicId: ID }),
        ).toBe('2027/01/01/x-ab12cd34ef56/');
    });

    it('pads month, day and year', () => {
        expect(
            buildPrefix({ now: new Date('0987-01-02T00:00:00Z'), slug: 'x', publicId: ID }),
        ).toBe('0987/01/02/x-ab12cd34ef56/');
    });

    it('keeps a slug of exactly 100 characters', () => {
        const slug = 'a'.repeat(MAX_SLUG_LENGTH);
        const prefix = buildPrefix({ now: new Date('2026-01-01T00:00:00Z'), slug, publicId: ID });

        expect(prefix).toBe(`2026/01/01/${slug}-${ID}/`);
    });

    it('always caps the slug at 100 characters, even for short-enough keys', () => {
        const slug = 'a'.repeat(101);
        const prefix = buildPrefix({ now: new Date('2026-01-01T00:00:00Z'), slug, publicId: ID });

        expect(prefix).toBe(`2026/01/01/${'a'.repeat(100)}-${ID}/`);
    });

    it.each([
        ['a 240-character name', 'x'.repeat(240)],
        ['200 "@" characters', slugify('@'.repeat(200) + 'abc')],
        ['a long unicode name', slugify('Ünïcödé-Vidéo '.repeat(40))],
        ['a very long name', 'b'.repeat(5000)],
        ['100 chars ending in dash after cut', `${'a'.repeat(99)}-${'b'.repeat(50)}`],
    ])('keeps every key within 255 characters for %s', (_label, slug) => {
        const prefix = buildPrefix({ now: new Date('2026-01-01T00:00:00Z'), slug, publicId: ID });

        expect(prefix.length + 'storyboard_5x5.jpg'.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
        expect(isValidPrefix(prefix, ID)).toBe(true);
    });

    it('re-trims a dash exposed by the truncation', () => {
        const slug = `${'a'.repeat(99)}-${'b'.repeat(800)}`;
        const prefix = buildPrefix({ now: new Date('2026-01-01T00:00:00Z'), slug, publicId: ID });

        expect(prefix).toBe(`2026/01/01/${'a'.repeat(99)}-${ID}/`);
        expect(isValidPrefix(prefix, ID)).toBe(true);
    });

    it('rejects an invalid slug or date', () => {
        const now = new Date('2026-01-01T00:00:00Z');

        expect(() => buildPrefix({ now, slug: '', publicId: ID })).toThrow();
        expect(() => buildPrefix({ now, slug: 'Bad Slug', publicId: ID })).toThrow();
        expect(() => buildPrefix({ now: new Date('nope'), slug: 'x', publicId: ID })).toThrow();
    });
});

describe('isValidPrefix', () => {
    it('accepts a prefix produced by buildPrefix', () => {
        const prefix = buildPrefix({
            now: new Date('2026-03-05T00:00:00Z'),
            slug: 'video',
            publicId: ID,
        });

        expect(isValidPrefix(prefix, ID)).toBe(true);
    });

    it.each([
        ['2026/03/05/video-ab12cd34ef56', 'missing trailing slash'],
        ['2026/03/05/video-zzzzzzzzzzzz/', 'different public id'],
        ['2026/3/05/video-ab12cd34ef56/', 'short month'],
        ['2026/03/05/Video-ab12cd34ef56/', 'uppercase slug'],
        ['2026/03/05/-ab12cd34ef56/', 'empty slug'],
        ['2026/03/05/a/b-ab12cd34ef56/', 'extra path segment'],
        ['x/2026/03/05/video-ab12cd34ef56/', 'leading garbage'],
        ['2026/03/05/video-ab12cd34ef56/\n', 'trailing newline'],
    ])('rejects %s (%s)', (prefix) => {
        expect(isValidPrefix(prefix, ID)).toBe(false);
    });

    it('rejects an invalid public id', () => {
        expect(isValidPrefix('2026/03/05/video-abc/', 'abc')).toBe(false);
    });
});
