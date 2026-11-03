import { describe, expect, it, vi } from 'vitest';
import {
    UPLOAD_MAX_ATTEMPTS,
    UPLOAD_RETRY_DELAYS_MS,
    contentTypeFor,
    listUploadFiles,
    objectKey,
    progressFromUploaded,
    withRetry,
} from './plan';

describe('listUploadFiles', () => {
    it('selects only the output files and puts the playlist last', () => {
        const names = [
            'playlist.m3u8',
            'segment_010.ts',
            'segment_002.ts',
            'segment_000.ts',
            'thumbnail.jpg',
            'storyboard_5x5.jpg',
            'storyboard_3x3.jpg',
            'storyboard_4x4.jpg',
            'candidate_0001.jpg',
            'tile_3x3_0000.jpg',
            'thumb_candidate_0.jpg',
            'ffmpeg_progress.txt',
            'segment_000.ts.tmp',
            'playlist.m3u8.tmp',
            'notes.json',
            'storyboard_2x2.jpg',
            'segment_1.ts',
            'Playlist.m3u8',
            'sub/segment_001.ts',
        ];

        expect(listUploadFiles(names)).toEqual([
            'segment_000.ts',
            'segment_002.ts',
            'segment_010.ts',
            'storyboard_3x3.jpg',
            'storyboard_4x4.jpg',
            'storyboard_5x5.jpg',
            'thumbnail.jpg',
            'playlist.m3u8',
        ]);
    });

    it('orders segments numerically, including more than 999 segments', () => {
        expect(listUploadFiles(['segment_1000.ts', 'segment_999.ts', 'segment_100.ts'])).toEqual([
            'segment_100.ts',
            'segment_999.ts',
            'segment_1000.ts',
        ]);
    });

    it('handles duplicates and a missing playlist', () => {
        expect(listUploadFiles(['segment_000.ts', 'segment_000.ts'])).toEqual(['segment_000.ts']);
        expect(listUploadFiles([])).toEqual([]);
    });
});

describe('contentTypeFor / objectKey', () => {
    it.each([
        ['playlist.m3u8', 'application/vnd.apple.mpegurl'],
        ['segment_000.ts', 'video/mp2t'],
        ['thumbnail.jpg', 'image/jpeg'],
        ['storyboard_3x3.jpg', 'image/jpeg'],
    ])('%s -> %s', (name, type) => {
        expect(contentTypeFor(name)).toBe(type);
    });

    it('throws for other extensions', () => {
        expect(() => contentTypeFor('a.png')).toThrow();
    });

    it('joins prefix and name, flat only', () => {
        expect(objectKey('2026/01/02/x-ab12cd34ef56/', 'playlist.m3u8')).toBe(
            '2026/01/02/x-ab12cd34ef56/playlist.m3u8',
        );
        expect(() => objectKey('p/', 'a/b.ts')).toThrow();
        expect(() => objectKey('p/', '..\\b.ts')).toThrow();
        expect(() => objectKey('p/', '')).toThrow();
    });
});

describe('progressFromUploaded', () => {
    it.each([
        [0, 10, 0],
        [5, 10, 0.5],
        [10, 10, 1],
        [12, 10, 1],
        [-1, 10, 0],
        [0, 0, 1],
    ])('%i of %i = %d', (done, total, expected) => {
        expect(progressFromUploaded(done, total)).toBe(expected);
    });
});

describe('retry constants', () => {
    it('allows 3 attempts with 1 s and 2 s waits', () => {
        expect(UPLOAD_MAX_ATTEMPTS).toBe(3);
        expect(UPLOAD_RETRY_DELAYS_MS).toEqual([1000, 2000]);
    });
});

describe('withRetry', () => {
    it('returns immediately on success without sleeping', async () => {
        const sleep = vi.fn(async () => {});

        await expect(withRetry(async () => 'ok', { delaysMs: [1000, 2000], sleep })).resolves.toBe(
            'ok',
        );
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries with the given delays and passes the attempt number', async () => {
        const sleep = vi.fn(async () => {});
        const attempts: number[] = [];
        const result = await withRetry(
            async (attempt) => {
                attempts.push(attempt);

                if (attempt < 3) {
                    throw new Error('boom');
                }

                return 'done';
            },
            { delaysMs: [1000, 2000], sleep },
        );

        expect(result).toBe('done');
        expect(attempts).toEqual([1, 2, 3]);
        expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    });

    it('rethrows the last error after the final attempt', async () => {
        const sleep = vi.fn(async () => {});
        let calls = 0;

        await expect(
            withRetry(
                async () => {
                    calls++;
                    throw new Error(`fail ${calls}`);
                },
                { delaysMs: [1, 2], sleep },
            ),
        ).rejects.toThrow('fail 3');
        expect(calls).toBe(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('stops at once when shouldRetry says no', async () => {
        const sleep = vi.fn(async () => {});
        let calls = 0;

        await expect(
            withRetry(
                async () => {
                    calls++;
                    throw new Error('fatal');
                },
                { delaysMs: [1, 2], sleep, shouldRetry: () => false },
            ),
        ).rejects.toThrow('fatal');
        expect(calls).toBe(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('reports each retry through onRetry', async () => {
        const events: [number, number][] = [];

        await withRetry(
            async (attempt) => {
                if (attempt < 2) {
                    throw new Error('x');
                }
            },
            {
                delaysMs: [5],
                sleep: async () => {},
                onRetry: (_e, attempt, delay) => events.push([attempt, delay]),
            },
        );

        expect(events).toEqual([[1, 5]]);
    });

    it('with no delays runs exactly once', async () => {
        let calls = 0;

        await expect(
            withRetry(
                async () => {
                    calls++;
                    throw new Error('x');
                },
                { delaysMs: [], sleep: async () => {} },
            ),
        ).rejects.toThrow('x');
        expect(calls).toBe(1);
    });
});
