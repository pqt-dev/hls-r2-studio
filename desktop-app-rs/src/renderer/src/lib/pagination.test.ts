import { describe, expect, it } from 'vitest';
import { parseJump } from './pagination';

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
