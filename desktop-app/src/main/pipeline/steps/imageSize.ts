/** Reads the pixel size of a JPEG from its SOF marker (replaces PHP `getimagesize`). */

export interface ImageSize {
    width: number;
    height: number;
}

/** Returns null when the buffer is not a JPEG or no frame header is found. */
export function jpegSize(data: Uint8Array): ImageSize | null {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;

    let offset = 2;

    while (offset + 4 <= data.length) {
        if (data[offset] !== 0xff) {
            offset++;
            continue;
        }

        const marker = data[offset + 1] ?? 0;

        if (marker === 0xff) {
            offset++;
            continue;
        }

        // Markers without a length: TEM, RSTn, SOI, EOI.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
            offset += 2;
            continue;
        }

        const length = ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
        const isFrameHeader =
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc;

        if (isFrameHeader) {
            if (offset + 9 > data.length) return null;
            const height = ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0);
            const width = ((data[offset + 7] ?? 0) << 8) | (data[offset + 8] ?? 0);

            return width > 0 && height > 0 ? { width, height } : null;
        }

        if (length < 2) return null;
        offset += 2 + length;
    }

    return null;
}
