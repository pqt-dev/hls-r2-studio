import { randomInt as nodeRandomInt } from 'node:crypto';

export const PUBLIC_ID_LENGTH = 12;
export const PUBLIC_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const PUBLIC_ID_PATTERN = /^[a-z0-9]{12}$/;

/** Returns a uniformly random integer in `[0, maxExclusive)`. Injectable for tests. */
export type RandomInt = (maxExclusive: number) => number;

/** Generates a 12 character `[a-z0-9]` public id (the server enforces the same format). */
export function generatePublicId(randomInt: RandomInt = (max) => nodeRandomInt(max)): string {
    let id = '';

    for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
        const index = randomInt(PUBLIC_ID_ALPHABET.length);
        const char = PUBLIC_ID_ALPHABET[index];

        if (char === undefined) {
            throw new RangeError(`randomInt returned an out-of-range index: ${index}`);
        }

        id += char;
    }

    return id;
}

export function isValidPublicId(value: unknown): value is string {
    return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}
