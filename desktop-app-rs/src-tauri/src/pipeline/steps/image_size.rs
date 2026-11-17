//! Reads the pixel size of a JPEG from its SOF marker (replaces PHP `getimagesize`).
//! Port of steps/imageSize.ts.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

/// Returns `None` when the buffer is not a JPEG or no frame header is found.
pub fn jpeg_size(data: &[u8]) -> Option<ImageSize> {
    if data.len() < 4 || data[0] != 0xff || data[1] != 0xd8 {
        return None;
    }

    let at = |i: usize| u32::from(data.get(i).copied().unwrap_or(0));
    let mut offset = 2usize;

    while offset + 4 <= data.len() {
        if data[offset] != 0xff {
            offset += 1;
            continue;
        }

        let marker = data[offset + 1];

        if marker == 0xff {
            offset += 1;
            continue;
        }

        // Markers without a length: TEM, RSTn, SOI, EOI.
        if marker == 0x01 || (0xd0..=0xd9).contains(&marker) {
            offset += 2;
            continue;
        }

        let length = ((at(offset + 2)) << 8) | at(offset + 3);
        let is_frame_header =
            (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker);

        if is_frame_header {
            if offset + 9 > data.len() {
                return None;
            }

            let height = (at(offset + 5) << 8) | at(offset + 6);
            let width = (at(offset + 7) << 8) | at(offset + 8);

            return (width > 0 && height > 0).then_some(ImageSize { width, height });
        }

        if length < 2 {
            return None;
        }

        offset += 2 + length as usize;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // SOI, APP0 (length 4: two payload bytes), SOF0 for a 1920x1080 frame (height first).
    const SAMPLE: [u8; 18] = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38,
        0x07, 0x80, 0x03,
    ];

    #[test]
    fn reads_width_and_height_from_sof0() {
        assert_eq!(
            jpeg_size(&SAMPLE),
            Some(ImageSize {
                width: 1920,
                height: 1080
            })
        );
    }

    #[test]
    fn skips_fill_bytes_and_dht_markers() {
        let with_dht = [
            0xff, 0xd8, 0xff, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x00,
            0x64, 0x00, 0xc8, 0x03,
        ];

        assert_eq!(
            jpeg_size(&with_dht),
            Some(ImageSize {
                width: 200,
                height: 100
            })
        );
    }

    #[test]
    fn returns_none_for_non_jpeg_or_truncated_data() {
        assert_eq!(jpeg_size(&[0x89, 0x50, 0x4e, 0x47]), None);
        assert_eq!(jpeg_size(&[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), None);
        assert_eq!(jpeg_size(&[]), None);
    }
}
