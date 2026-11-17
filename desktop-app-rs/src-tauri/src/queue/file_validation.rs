//! Validation of source files offered to the queue (port of
//! desktop-app/src/main/queue/fileValidation.ts). Paths follow the rules of a `PathStyle` so the
//! tests behave the same on every OS; the app uses `PathStyle::native()`.

use std::future::Future;
use std::io;

use crate::dto::RejectedFile;
use crate::pipeline::run::ALLOWED_EXTENSIONS;
use crate::settings::{is_absolute_native, normalize_posix, normalize_win32};

/// Accepted video extensions (lower case, without the dot).
pub const VIDEO_EXTENSIONS: [&str; 5] = ALLOWED_EXTENSIONS;

pub const REASON_INVALID_PATH: &str = "The file path is not valid.";
pub const REASON_NOT_FOUND: &str = "The file was not found.";
pub const REASON_NOT_A_FILE: &str = "This is not a regular file.";
pub const REASON_EMPTY: &str = "The file is empty.";
pub const REASON_DUPLICATE: &str = "Already in the queue.";

pub fn unsupported_type_reason() -> String {
    format!(
        "Unsupported file type. Supported: {}.",
        VIDEO_EXTENSIONS.join(", ")
    )
}

/// Which `node:path` flavour the queue uses (`platform` of the TS queue).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathStyle {
    Posix,
    Windows,
}

impl PathStyle {
    pub fn native() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Posix
        }
    }

    fn is_separator(self, c: char) -> bool {
        c == '/' || (self == Self::Windows && c == '\\')
    }

    /// `path.isAbsolute`. Windows uses Rust's stricter native rule (drive letter AND root, or a
    /// UNC path) when it is the native style.
    pub fn is_absolute(self, path: &str) -> bool {
        match self {
            Self::Posix => path.starts_with('/'),
            Self::Windows if cfg!(windows) => is_absolute_native(path),
            Self::Windows => {
                let bytes = path.as_bytes();

                (bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && (bytes[2] == b'\\' || bytes[2] == b'/'))
                    || path.starts_with("\\\\")
            }
        }
    }

    /// `path.basename` (file name only, never a directory part).
    pub fn base_name(self, path: &str) -> String {
        let mut rest = path;

        if self == Self::Windows {
            let bytes = rest.as_bytes();

            if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                rest = &rest[2..];
            }
        }

        let trimmed = rest.trim_end_matches(|c| self.is_separator(c));

        trimmed
            .rsplit(|c| self.is_separator(c))
            .next()
            .unwrap_or("")
            .to_string()
    }

    /// Key used to detect the same file twice (`resolve` + case-insensitive on Windows).
    pub fn path_key(self, path: &str) -> String {
        match self {
            Self::Posix => {
                let normalized = normalize_posix(path);

                if normalized.len() > 1 {
                    normalized.trim_end_matches('/').to_string()
                } else {
                    normalized
                }
            }
            Self::Windows => normalize_win32(path).trim_end_matches('\\').to_lowercase(),
        }
    }
}

/// Lower-case extension of a file name without the dot (`extname(...).slice(1)`); a leading
/// dot (`.mp4`) is not an extension.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 => name[index + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn has_video_extension(name: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&extension_of(name).as_str())
}

/// What `stat` reports (links are followed, like `fs.stat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub is_file: bool,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedFile {
    pub path: String,
    pub size: u64,
}

/// Checks one path. Returns the file (with its size) or the reason it was rejected. The
/// rejection only ever carries the file NAME, never the path.
pub async fn validate_video_path<F, Fut>(
    path: &str,
    style: PathStyle,
    stat: F,
) -> Result<ValidatedFile, RejectedFile>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = io::Result<FileStat>>,
{
    let name = style.base_name(path);
    let reject = |reason: String| RejectedFile {
        name: name.clone(),
        reason,
    };

    if !style.is_absolute(path) {
        return Err(reject(REASON_INVALID_PATH.into()));
    }

    if !has_video_extension(&name) {
        return Err(reject(unsupported_type_reason()));
    }

    let Ok(info) = stat(path.to_string()).await else {
        return Err(reject(REASON_NOT_FOUND.into()));
    };

    if !info.is_file {
        return Err(reject(REASON_NOT_A_FILE.into()));
    }

    if info.size < 1 {
        return Err(reject(REASON_EMPTY.into()));
    }

    Ok(ValidatedFile {
        path: path.to_string(),
        size: info.size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_names() {
        let posix = PathStyle::Posix;
        let win = PathStyle::Windows;

        assert_eq!(posix.base_name("/v/a.mp4"), "a.mp4");
        assert_eq!(posix.base_name("relative/x.mp4"), "x.mp4");
        assert_eq!(posix.base_name("/v/dir/"), "dir");
        assert_eq!(posix.base_name("a\\b.mp4"), "a\\b.mp4");
        assert_eq!(win.base_name("C:\\Videos\\clip.MP4"), "clip.MP4");
        assert_eq!(win.base_name("D:/x/y.mkv"), "y.mkv");
        assert_eq!(win.base_name("C:clip.mp4"), "clip.mp4");
        assert_eq!(win.base_name(""), "");
    }

    #[test]
    fn extensions_are_case_insensitive_and_need_a_name() {
        assert!(has_video_extension("a.MP4"));
        assert!(has_video_extension("b.webm"));
        assert!(!has_video_extension(".mp4"));
        assert!(!has_video_extension("a.mp4.txt"));
        assert!(!has_video_extension("a."));
        assert_eq!(
            unsupported_type_reason(),
            "Unsupported file type. Supported: mp4, mov, mkv, avi, webm."
        );
    }

    #[test]
    fn path_keys_resolve_and_fold_case_on_windows() {
        assert_eq!(PathStyle::Posix.path_key("/v/./x/../a.mp4"), "/v/a.mp4");
        assert_ne!(
            PathStyle::Posix.path_key("/v/A.mp4"),
            PathStyle::Posix.path_key("/v/a.mp4")
        );
        assert_eq!(
            PathStyle::Windows.path_key("C:/Videos/A.MP4"),
            PathStyle::Windows.path_key("c:\\videos\\.\\a.mp4")
        );
    }

    #[test]
    fn absolute_paths() {
        assert!(PathStyle::Posix.is_absolute("/v/a.mp4"));
        assert!(!PathStyle::Posix.is_absolute("v/a.mp4"));
        assert!(!PathStyle::Posix.is_absolute(""));
        assert!(PathStyle::Windows.is_absolute("C:\\v\\a.mp4"));
        assert!(!PathStyle::Windows.is_absolute("v\\a.mp4"));
    }

    #[tokio::test]
    async fn validation_order_and_reasons() {
        let stat_ok = |size: u64, is_file: bool| {
            move |_p: String| async move { Ok(FileStat { is_file, size }) }
        };
        let missing = |_p: String| async { Err(io::Error::from(io::ErrorKind::NotFound)) };
        let style = PathStyle::Posix;

        assert_eq!(
            validate_video_path("/v/a.mp4", style, stat_ok(5, true)).await,
            Ok(ValidatedFile {
                path: "/v/a.mp4".into(),
                size: 5
            })
        );

        let reason = |r: Result<ValidatedFile, RejectedFile>| r.unwrap_err();

        assert_eq!(
            reason(validate_video_path("x/a.mp4", style, stat_ok(5, true)).await),
            RejectedFile {
                name: "a.mp4".into(),
                reason: REASON_INVALID_PATH.into()
            }
        );
        assert_eq!(
            reason(validate_video_path("/v/a.txt", style, stat_ok(5, true)).await).reason,
            unsupported_type_reason()
        );
        assert_eq!(
            reason(validate_video_path("/v/a.mp4", style, missing).await).reason,
            REASON_NOT_FOUND
        );
        assert_eq!(
            reason(validate_video_path("/v/a.mp4", style, stat_ok(5, false)).await).reason,
            REASON_NOT_A_FILE
        );
        assert_eq!(
            reason(validate_video_path("/v/a.mp4", style, stat_ok(0, true)).await).reason,
            REASON_EMPTY
        );
    }
}
