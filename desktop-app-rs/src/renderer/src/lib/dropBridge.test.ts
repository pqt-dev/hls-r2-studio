import { describe, expect, it } from 'vitest';
import { dropPositionToCss } from './dropBridge';

describe('dropPositionToCss', () => {
    it('keeps macOS coordinates as they are (already CSS pixels)', () => {
        expect(dropPositionToCss({ x: 300, y: 200 }, 2, true)).toEqual({ x: 300, y: 200 });
    });

    it('divides physical pixels by the device pixel ratio elsewhere', () => {
        expect(dropPositionToCss({ x: 300, y: 150 }, 1.5, false)).toEqual({ x: 200, y: 100 });
        expect(dropPositionToCss({ x: 300, y: 200 }, 2, false)).toEqual({ x: 150, y: 100 });
    });

    it('falls back to a ratio of 1 when it is missing or invalid', () => {
        expect(dropPositionToCss({ x: 10, y: 20 }, 0, false)).toEqual({ x: 10, y: 20 });
        expect(dropPositionToCss({ x: 10, y: 20 }, undefined, false)).toEqual({ x: 10, y: 20 });
        expect(dropPositionToCss({ x: 10, y: 20 }, Number.NaN, false)).toEqual({ x: 10, y: 20 });
    });
});
