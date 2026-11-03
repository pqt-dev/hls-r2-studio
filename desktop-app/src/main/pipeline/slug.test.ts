import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baseNameWithoutExtension, laravelSlug, slugify } from './slug';

interface GoldenSample {
    input: string;
    expected: string;
}

const golden = JSON.parse(
    readFileSync(
        fileURLToPath(new URL('../../../test/fixtures/slug-golden.json', import.meta.url)),
        'utf8',
    ),
) as GoldenSample[];

describe('slug golden data from Laravel Str::slug', () => {
    it('has enough samples', () => {
        expect(golden.length).toBeGreaterThanOrEqual(40);
    });

    it.each(golden.map((s, i) => [i, s] as const))('sample #%i matches PHP', (_i, sample) => {
        expect(laravelSlug(sample.input)).toBe(sample.expected);
        expect(slugify(sample.input)).toBe(sample.expected === '' ? 'video' : sample.expected);
    });
});

describe('slugify fallback and non-Latin scripts', () => {
    it.each(['', '!!!', '🔥🔥🔥', '---', '   '])('falls back to video for %j', (input) => {
        expect(slugify(input)).toBe('video');
    });

    it.each([
        '日本語のファイル名',
        '中文视频 2024',
        'Видео с Кириллицей',
        'فيديو عربي',
        'ไทย วิดีโอ',
        'ελληνικό αρχείο',
        '日本語 abc 한국어',
    ])('keeps the output safe for %j', (input) => {
        const slug = slugify(input);

        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    });

    it('drops untransliterated scripts and keeps the Latin parts', () => {
        expect(slugify('日本語 abc 한국어')).toBe('abc');
        expect(slugify('日本語')).toBe('video');
    });
});

describe('baseNameWithoutExtension (PHP pathinfo semantics)', () => {
    it.each([
        ['video.mp4', 'video'],
        ['a.b.mp4', 'a.b'],
        ['.hidden', ''],
        ['.hidden.mp4', '.hidden'],
        ['noext', 'noext'],
        ['trailing.', 'trailing'],
        ['..', '.'],
        ['archive.tar.gz', 'archive.tar'],
        ['dir/sub/clip.mov', 'clip'],
        ['dir/sub/', 'sub'],
        ['Phim Việt.MP4', 'Phim Việt'],
        ['', ''],
    ])('%j -> %j', (input, expected) => {
        expect(baseNameWithoutExtension(input)).toBe(expected);
    });
});
