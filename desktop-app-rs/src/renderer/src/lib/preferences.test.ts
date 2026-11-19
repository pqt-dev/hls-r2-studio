import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreference, writePreference } from './preferences';

const SIZES = [10, 20, 50] as const;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('UI preferences', () => {
    it('writes to and reads from localStorage', () => {
        writePreference('test.perPage', 50);

        expect(window.localStorage.getItem('test.perPage')).toBe('50');
        expect(readPreference('test.perPage', SIZES, 20)).toBe(50);
    });

    it('returns the fallback when nothing is stored', () => {
        expect(readPreference('test.missing', SIZES, 20)).toBe(20);
    });

    it('falls back when the stored value is not an allowed option', () => {
        window.localStorage.setItem('test.perPage', '7');
        expect(readPreference('test.perPage', SIZES, 20)).toBe(20);

        window.localStorage.setItem('test.view', 'tiles');
        expect(readPreference('test.view', ['grid', 'list'] as const, 'grid')).toBe('grid');
    });

    it('falls back and does not throw when storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });

        expect(readPreference('test.perPage', SIZES, 20)).toBe(20);
        expect(() => writePreference('test.perPage', 50)).not.toThrow();
    });
});
