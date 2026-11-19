import { describe, expect, it } from 'vitest';
import {
    bitrateTier,
    formatBytes,
    formatDateCompact,
    formatQuality,
    formatRelativeTime,
    plural,
    qualityTier,
    resolutionTier,
    siteHost,
    STAGE_LABELS,
    stageLabel,
    fpsTier,
    videoOrientation,
} from './format';
import { STATUS_ICON, statusKind } from './jobState';
import type { JobState } from '../../../shared/types';

describe('formatBytes', () => {
    it.each([
        [0, '0 B'],
        [512, '512 B'],
        [1024, '1.0 KB'],
        [1536, '1.5 KB'],
        [10 * 1024, '10 KB'],
        [5 * 1024 ** 2, '5.0 MB'],
        [150 * 1024 ** 2, '150 MB'],
        [2.4 * 1024 ** 3, '2.4 GB'],
        [3 * 1024 ** 4, '3.0 TB'],
    ])('formats %d bytes as %s', (bytes, text) => {
        expect(formatBytes(bytes)).toBe(text);
    });

    it('treats invalid input as zero', () => {
        expect(formatBytes(-1)).toBe('0 B');
        expect(formatBytes(Number.NaN)).toBe('0 B');
    });
});

describe('formatRelativeTime', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();

    it.each([
        [3, 'just now'],
        [30, '30 seconds ago'],
        [60, '1 minute ago'],
        [5 * 60, '5 minutes ago'],
        [2 * 3600, '2 hours ago'],
        [24 * 3600, 'yesterday'],
        [3 * 86400, '3 days ago'],
    ])('%d s ago -> %s', (seconds, text) => {
        expect(formatRelativeTime(ago(seconds), now)).toBe(text);
    });

    it('returns an empty string for an invalid date and never goes negative', () => {
        expect(formatRelativeTime('not a date', now)).toBe('');
        expect(formatRelativeTime(ago(-5), now)).toBe('just now');
    });
});

describe('labels and helpers', () => {
    it('has an English label for every job state', () => {
        const states = Object.keys(STAGE_LABELS) as JobState[];

        expect(states).toHaveLength(13);
        expect(stageLabel('transcoding')).toBe('Transcoding');
        expect(stageLabel('needs_sign_in')).toBe('Sign-in needed');
        expect(stageLabel('upload_interrupted')).toBe('Upload paused');

        for (const state of states) {
            expect(STAGE_LABELS[state]).toMatch(/^[A-Z][A-Za-z -]+$/);
            expect(STATUS_ICON[statusKind(state)]).not.toBe('');
        }
    });

    it('extracts the host and pluralizes', () => {
        expect(siteHost('https://site.example.com/path')).toBe('site.example.com');
        expect(siteHost(undefined)).toBe('');
        expect(siteHost('weird')).toBe('weird');
        expect(plural(1, 'video')).toBe('1 video');
        expect(plural(2, 'video')).toBe('2 videos');
        expect(plural(2, 'video is', 'videos are')).toBe('2 videos are');
    });
});

describe('formatQuality', () => {
    it.each<[number | null, number | null, string]>([
        [1920, 1080, '1080p'],
        [1080, 1920, '1080p'],
        [888, 1920, '720p'],
        [1280, 2770, '1080p'],
        [3840, 2160, '4K'],
        [720, 1280, '720p'],
        [1280, 720, '720p'],
        [854, 480, '480p'],
        [640, 360, '360p'],
        [426, 240, '240p'],
        [2560, 1440, '1440p'],
        [7680, 4320, '8K'],
        [160, 96, '96p'],
        [null, 1080, '1080p'],
        [null, null, ''],
        [0, 0, ''],
    ])('%s x %s is %s', (width, height, expected) => {
        expect(formatQuality(width, height)).toBe(expected);
    });
});

describe('qualityTier', () => {
    it.each<[number | null, number | null, number | null]>([
        [7680, 4320, 1],
        [3840, 2160, 1],
        [2160, 3840, 1],
        [2560, 1440, 2],
        [1280, 2770, 3],
        [1920, 1080, 3],
        [1080, 1920, 3],
        [1280, 720, 4],
        [888, 1920, 4],
        [854, 480, 5],
        [160, 96, 5],
        [null, 1080, 3],
        [null, null, null],
        [0, 0, null],
    ])('%s x %s is tier %s', (width, height, expected) => {
        expect(qualityTier(width, height)).toBe(expected);
    });

    it('always matches the formatQuality label', () => {
        const labelTier: Record<string, number> = {
            '8K': 1,
            '4K': 1,
            '1440p': 2,
            '1080p': 3,
            '720p': 4,
        };

        for (const [w, h] of [
            [3840, 2160],
            [2560, 1440],
            [1920, 1080],
            [1280, 720],
            [640, 360],
            [1999, 3000],
            [1300, 2000],
            [999, 1999],
        ] as const) {
            expect(qualityTier(w, h)).toBe(labelTier[formatQuality(w, h)] ?? 5);
        }
    });
});

describe('bitrateTier', () => {
    it.each<[number | null | undefined, number | null]>([
        [20000, 1],
        [8000, 1],
        [7999, 2],
        [4000, 2],
        [3999, 3],
        [2000, 3],
        [1999, 4],
        [1000, 4],
        [999, 5],
        [1, 5],
        [0, null],
        [-5, null],
        [Number.NaN, null],
        [null, null],
        [undefined, null],
    ])('%s kbps is tier %s', (kbps, expected) => {
        expect(bitrateTier(kbps)).toBe(expected);
    });
});

describe('resolutionTier', () => {
    it.each<[number | null, number | null, number | null]>([
        [3840, 2160, 1],
        [2160, 3840, 1],
        [2560, 1440, 2],
        [1280, 2770, 2],
        [1920, 1080, 3],
        [1080, 1920, 3],
        [1920, 1000, 3],
        [1280, 720, 4],
        [720, 1280, 4],
        [1000, 600, 5],
        [854, 480, 5],
        [1920, null, null],
        [null, 1080, null],
        [0, 1080, null],
    ])('%s x %s is tier %s', (width, height, expected) => {
        expect(resolutionTier(width, height)).toBe(expected);
    });
});

describe('formatDateCompact', () => {
    const now = new Date(2026, 10, 18, 15, 0).getTime();
    const at = (y: number, m: number, d: number, h: number, min: number) =>
        new Date(y, m, d, h, min).toISOString();

    it('omits the year within the current year', () => {
        expect(formatDateCompact(at(2026, 10, 18, 11, 59), now).replace(/\s/g, ' ')).toBe(
            'Nov 18, 11:59 AM',
        );
        expect(formatDateCompact(at(2026, 0, 5, 0, 7), now).replace(/\s/g, ' ')).toBe(
            'Jan 5, 12:07 AM',
        );
    });

    it('adds the year for other years', () => {
        expect(formatDateCompact(at(2025, 10, 18, 23, 5), now).replace(/\s/g, ' ')).toBe(
            'Nov 18, 2025, 11:05 PM',
        );
    });

    it('returns an empty string for missing or invalid values', () => {
        expect(formatDateCompact(null, now)).toBe('');
        expect(formatDateCompact(undefined, now)).toBe('');
        expect(formatDateCompact('nope', now)).toBe('');
    });
});

describe('videoOrientation', () => {
    it('detects landscape and portrait', () => {
        expect(videoOrientation(1920, 1080)).toBe('landscape');
        expect(videoOrientation(1280, 2770)).toBe('portrait');
        expect(videoOrientation(1080, 1920)).toBe('portrait');
    });

    it('treats square as landscape', () => {
        expect(videoOrientation(1080, 1080)).toBe('landscape');
        expect(videoOrientation(1080, 1081)).toBe('portrait');
    });

    it('falls back to landscape for missing or invalid sides', () => {
        expect(videoOrientation(null, null)).toBe('landscape');
        expect(videoOrientation(undefined, 1080)).toBe('landscape');
        expect(videoOrientation(1080, null)).toBe('landscape');
        expect(videoOrientation(0, 1080)).toBe('landscape');
        expect(videoOrientation(Number.NaN, 1080)).toBe('landscape');
    });
});

describe('fpsTier', () => {
    it.each<[number | null | undefined, number | null]>([
        [120, 1],
        [60, 1],
        [59.94, 2],
        [48, 2],
        [47, 3],
        [30, 3],
        [29.97, 4],
        [24, 4],
        [23, 5],
        [1, 5],
        [0, null],
        [-1, null],
        [Number.NaN, null],
        [null, null],
        [undefined, null],
    ])('%s fps is tier %s', (fps, expected) => {
        expect(fpsTier(fps)).toBe(expected);
    });
});
