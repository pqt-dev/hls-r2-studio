//! Custom thumbnail upload helpers: magic-byte sniffing, a safe local file reader and a
//! hand-built `multipart/form-data` body.
//!
//! The multipart body is built here (no reqwest `multipart` feature) so no extra crate is
//! pulled in and the file name / content type are always ours: they come from the SNIFFED
//! image type, never from the user's file name or extension.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

/// The site accepts at most 5 MB (5120 KB).
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

pub const NOT_AN_IMAGE: &str = "Choose a JPG, PNG or WebP image.";
pub const IMAGE_TOO_LARGE: &str = "The image is larger than 5 MB.";
pub const IMAGE_EMPTY: &str = "The image file is empty.";
pub const IMAGE_NOT_REGULAR: &str = "Choose a regular image file.";
pub const IMAGE_UNREADABLE: &str = "Could not read the image file.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Jpeg,
    Png,
    Webp,
}

impl ImageKind {
    /// Fixed upload file name (the user's own file name is never sent).
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Jpeg => "thumbnail.jpg",
            Self::Png => "thumbnail.png",
            Self::Webp => "thumbnail.webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }
}

/// Type from the leading bytes: JPEG `FF D8 FF`, PNG signature, WebP `RIFF....WEBP`.
pub fn sniff_image(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

/// Opens `path` without following a symlink, as a regular file only.
fn open_regular(path: &Path) -> Result<File, &'static str> {
    // Checked first so a FIFO / device / directory is never opened.
    let meta = std::fs::symlink_metadata(path).map_err(|_| IMAGE_UNREADABLE)?;

    if meta.file_type().is_symlink() || !meta.is_file() || is_reparse_point(&meta) {
        return Err(IMAGE_NOT_REGULAR);
    }

    let mut options = OpenOptions::new();

    options.read(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        // No symlink at the last component even if the path is swapped after the check; no
        // blocking open if it was swapped for a FIFO.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }

    let file = options.open(path).map_err(|_| IMAGE_UNREADABLE)?;

    // The handle itself must still be a regular file.
    if !file.metadata().map_err(|_| IMAGE_UNREADABLE)?.is_file() {
        return Err(IMAGE_NOT_REGULAR);
    }

    Ok(file)
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Reads an image chosen in the native dialog: regular file, 1..=5 MB (checked before reading
/// and again on the bytes read, with a hard read cap), type from the magic bytes. Blocking.
pub fn read_image_file(path: &Path) -> Result<(ImageKind, Vec<u8>), &'static str> {
    let file = open_regular(path)?;
    let size = file.metadata().map_err(|_| IMAGE_UNREADABLE)?.len();

    if size == 0 {
        return Err(IMAGE_EMPTY);
    }

    if size > MAX_IMAGE_BYTES {
        return Err(IMAGE_TOO_LARGE);
    }

    let mut bytes = Vec::with_capacity(size as usize);

    // `take(limit + 1)`: a file that grows while being read can never exceed the cap + 1 byte.
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IMAGE_UNREADABLE)?;

    if bytes.is_empty() {
        return Err(IMAGE_EMPTY);
    }

    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(IMAGE_TOO_LARGE);
    }

    let kind = sniff_image(&bytes).ok_or(NOT_AN_IMAGE)?;

    Ok((kind, bytes))
}

/// A random boundary that does not occur in `payload`.
fn boundary_for(payload: &[u8]) -> Option<String> {
    use ring::rand::{SecureRandom, SystemRandom};

    let rng = SystemRandom::new();

    for _ in 0..8 {
        let mut raw = [0u8; 16];

        rng.fill(&mut raw).ok()?;

        let mut boundary = String::from("----hls-r2-studio-");

        for byte in raw {
            boundary.push_str(&format!("{byte:02x}"));
        }

        let needle = boundary.as_bytes();

        if !payload.windows(needle.len()).any(|w| w == needle) {
            return Some(boundary);
        }
    }

    None
}

/// `(body, content_type)` of a `multipart/form-data` request with the single field `image`.
/// Only fixed ASCII values (field name, file name, MIME type) and a hex boundary are written
/// into the headers, so nothing user-controlled can inject CR/LF.
pub fn build_multipart(kind: ImageKind, bytes: &[u8]) -> Option<(Vec<u8>, String)> {
    let boundary = boundary_for(bytes)?;
    let mut body = Vec::with_capacity(bytes.len() + 256);

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"image\"; filename=\"{}\"\r\n",
            kind.file_name()
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", kind.mime()).as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    Some((body, format!("multipart/form-data; boundary={boundary}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    fn jpeg(len: usize) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0];

        bytes.resize(len, 7);
        bytes
    }

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);

        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn sniffs_the_three_types_from_magic_bytes_only() {
        let mut webp = b"RIFF".to_vec();

        webp.extend_from_slice(&[1, 2, 3, 4]);
        webp.extend_from_slice(b"WEBPVP8 ");

        assert_eq!(sniff_image(&jpeg(10)), Some(ImageKind::Jpeg));
        assert_eq!(sniff_image(&PNG), Some(ImageKind::Png));
        assert_eq!(sniff_image(&webp), Some(ImageKind::Webp));
        assert_eq!(sniff_image(b"GIF89a......"), None);
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEB"), None);
        assert_eq!(sniff_image(b""), None);
        assert_eq!(sniff_image(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn reads_by_content_not_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let mut png = PNG.to_vec();

        png.extend_from_slice(&[0; 20]);

        // PNG content named .jpg is a PNG; JPEG content named .png is a JPEG.
        let (kind, bytes) = read_image_file(&write(&dir, "a.jpg", &png)).unwrap();
        assert_eq!((kind, bytes.len()), (ImageKind::Png, png.len()));

        let (kind, _) = read_image_file(&write(&dir, "b.png", &jpeg(30))).unwrap();
        assert_eq!(kind, ImageKind::Jpeg);

        // A .jpg that is not an image at all.
        assert_eq!(
            read_image_file(&write(&dir, "c.jpg", b"hello world, not an image")),
            Err(NOT_AN_IMAGE)
        );
        assert_eq!(
            read_image_file(&write(&dir, "d.jpg", b"")),
            Err(IMAGE_EMPTY)
        );
    }

    #[test]
    fn enforces_the_five_megabyte_limit() {
        let dir = tempfile::tempdir().unwrap();
        let exact = write(&dir, "exact.jpg", &jpeg(MAX_IMAGE_BYTES as usize));
        let over = write(&dir, "over.jpg", &jpeg(MAX_IMAGE_BYTES as usize + 1));

        assert_eq!(
            read_image_file(&exact).unwrap().1.len() as u64,
            MAX_IMAGE_BYTES
        );
        assert_eq!(read_image_file(&over), Err(IMAGE_TOO_LARGE));
    }

    #[test]
    fn rejects_directories_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(read_image_file(dir.path()), Err(IMAGE_NOT_REGULAR));
        assert_eq!(
            read_image_file(&dir.path().join("missing.jpg")),
            Err(IMAGE_UNREADABLE)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_even_to_a_valid_image() {
        let dir = tempfile::tempdir().unwrap();
        let target = write(&dir, "real.jpg", &jpeg(30));
        let link = dir.path().join("link.jpg");

        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(read_image_file(&link), Err(IMAGE_NOT_REGULAR));
        assert!(read_image_file(&target).is_ok());
    }

    #[test]
    fn multipart_is_well_formed_and_uses_only_fixed_names() {
        let data = jpeg(50);
        let (body, content_type) = build_multipart(ImageKind::Jpeg, &data).unwrap();
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();

        assert!(boundary
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));

        let head = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"thumbnail.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
        );
        let tail = format!("\r\n--{boundary}--\r\n");

        assert!(body.starts_with(head.as_bytes()));
        assert!(body.ends_with(tail.as_bytes()));
        assert_eq!(&body[head.len()..body.len() - tail.len()], &data[..]);

        let (other, other_type) = build_multipart(ImageKind::Jpeg, &data).unwrap();

        assert_ne!(content_type, other_type);
        assert_ne!(body, other);
    }
}
