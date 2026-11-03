import { describe, expect, it } from 'vitest';
import { jpegSize } from './imageSize';

// SOI, APP0 (length 4: two payload bytes), SOF0 for a 1920x1080 frame (height first).
const SAMPLE = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07,
    0x80, 0x03,
]);

describe('jpegSize', () => {
    it('reads width and height from SOF0', () => {
        expect(jpegSize(SAMPLE)).toEqual({ width: 1920, height: 1080 });
    });

    it('skips fill bytes and DHT (0xC4) markers', () => {
        const withDht = Uint8Array.from([
            0xff, 0xd8, 0xff, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x00,
            0x64, 0x00, 0xc8, 0x03,
        ]);

        expect(jpegSize(withDht)).toEqual({ width: 200, height: 100 });
    });

    it('returns null for non-JPEG or truncated data', () => {
        expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
        expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]))).toBeNull();
        expect(jpegSize(new Uint8Array())).toBeNull();
    });
});
