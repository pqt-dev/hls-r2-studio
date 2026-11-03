import { describe, expect, it } from 'vitest';
import { generatePublicId, isValidPublicId, PUBLIC_ID_ALPHABET } from './publicId';

describe('generatePublicId', () => {
    it('maps injected random values onto the alphabet', () => {
        const values = [0, 1, 25, 26, 35, 0, 1, 2, 3, 4, 5, 6];
        let call = 0;
        const id = generatePublicId((max) => {
            expect(max).toBe(36);
            return values[call++] ?? 0;
        });

        expect(id).toBe('abz09abcdefg');
        expect(call).toBe(12);
    });

    it('always produces a valid id with the default generator', () => {
        for (let i = 0; i < 50; i++) {
            expect(isValidPublicId(generatePublicId())).toBe(true);
        }
    });

    it('rejects an out-of-range random value', () => {
        expect(() => generatePublicId(() => PUBLIC_ID_ALPHABET.length)).toThrow(RangeError);
    });
});

describe('isValidPublicId', () => {
    it.each(['abcdefghijkl', '0123456789ab', 'ab12cd34ef56'])('accepts %s', (v) => {
        expect(isValidPublicId(v)).toBe(true);
    });

    it.each([
        'short',
        'abcdefghijklm',
        'ABCDEFGHIJKL',
        'abcdefghijk-',
        'abcdefghijkl\n',
        '',
        null,
        undefined,
        123456789012,
    ])('rejects %s', (v) => {
        expect(isValidPublicId(v)).toBe(false);
    });
});
