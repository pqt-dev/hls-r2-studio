import { describe, expect, it } from 'vitest';
import {
    formatBytes,
    formatRelativeTime,
    plural,
    siteHost,
    STAGE_LABELS,
    stageLabel,
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
