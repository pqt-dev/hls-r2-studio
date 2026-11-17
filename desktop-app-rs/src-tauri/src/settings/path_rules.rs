//! Pure path text rules for the temporary folder. Port of the path handling in
//! desktop-app/src/main/settings/settingsService.ts (`classifyTmpRoot`) plus Node's
//! `path.normalize` for both path flavours, so the same string yields the same result on every
//! platform and the Windows rules can be tested on any machine.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmpRootProblem {
    Empty,
    NotAbsolute,
    Unc,
    Device,
}

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// Classifies a temp folder string (pure; the same on every platform). UNC (`\\server\share`,
/// `//server/share`) and device paths (`\\.\`, `\\?\`, including `\\?\UNC\`) are rejected
/// everywhere: temp files must live on a local drive. `is_absolute_path` is injectable for tests.
pub fn classify_tmp_root(
    raw: &str,
    is_absolute_path: &dyn Fn(&str) -> bool,
) -> Option<TmpRootProblem> {
    let text = raw.trim();
    let mut chars = text.chars();
    let (c0, c1, c2) = (chars.next(), chars.next(), chars.next());

    if text.is_empty() {
        return Some(TmpRootProblem::Empty);
    }

    // `^[\\/]{2}[.?][\\/]`
    if c0.is_some_and(is_sep)
        && c1.is_some_and(is_sep)
        && matches!(c2, Some('.' | '?'))
        && chars.next().is_some_and(is_sep)
    {
        return Some(TmpRootProblem::Device);
    }

    // `^[\\/]{2}`
    if c0.is_some_and(is_sep) && c1.is_some_and(is_sep) {
        return Some(TmpRootProblem::Unc);
    }

    if !is_absolute_path(text) {
        return Some(TmpRootProblem::NotAbsolute);
    }

    None
}

/// `path.isAbsolute` of the current platform (Rust's rules: on Windows a drive letter AND a root,
/// so `C:\x` and `C:/x` are absolute; `\x` and `C:x` are not).
pub fn is_absolute_native(path: &str) -> bool {
    Path::new(path).is_absolute()
}

/// Resolves `.`/`..` and empty segments. `allow_above_root` keeps leading `..` (relative paths).
fn normalize_segments(
    path: &str,
    allow_above_root: bool,
    is_separator: fn(char) -> bool,
    joiner: &str,
) -> String {
    let mut stack: Vec<&str> = Vec::new();

    for segment in path.split(is_separator) {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|last| *last != "..") {
                    stack.pop();
                } else if allow_above_root {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }

    stack.join(joiner)
}

/// Node's `path.posix.normalize`.
pub fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }

    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut tail = normalize_segments(path, !absolute, |c| c == '/', "/");

    if tail.is_empty() {
        if absolute {
            return "/".into();
        }

        return if trailing { "./".into() } else { ".".into() };
    }

    if trailing {
        tail.push('/');
    }

    if absolute {
        format!("/{tail}")
    } else {
        tail
    }
}

/// Node's `path.win32.normalize` for the paths this app accepts: drive paths (`C:\x`, `C:/x`),
/// drive-relative (`C:x`), rooted (`\x`) and relative. UNC/device roots never get this far
/// (`classify_tmp_root` rejects them), so they are not interpreted here.
pub fn normalize_win32(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }

    let chars: Vec<char> = path.chars().collect();
    let has_drive = chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':';
    let (device, absolute, root_end) = if has_drive {
        let drive: String = chars[..2].iter().collect();

        if chars.get(2).is_some_and(|c| is_sep(*c)) {
            (Some(drive), true, 3)
        } else {
            (Some(drive), false, 2)
        }
    } else if is_sep(chars[0]) {
        (None, true, 1)
    } else {
        (None, false, 0)
    };

    let rest: String = chars[root_end..].iter().collect();
    let mut tail = normalize_segments(&rest, !absolute, is_sep, "\\");

    if tail.is_empty() && !absolute {
        tail = ".".into();
    }

    if !tail.is_empty() && is_sep(chars[chars.len() - 1]) {
        tail.push('\\');
    }

    match (device, absolute) {
        (None, true) => format!("\\{tail}"),
        (None, false) => tail,
        (Some(d), true) => format!("{d}\\{tail}"),
        (Some(d), false) => format!("{d}{tail}"),
    }
}

/// `path.normalize` of the current platform.
pub fn normalize(path: &str) -> String {
    if cfg!(windows) {
        normalize_win32(path)
    } else {
        normalize_posix(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs_win(p: &str) -> bool {
        let b = p.as_bytes();

        b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/')
    }

    fn abs_posix(p: &str) -> bool {
        p.starts_with('/')
    }

    #[test]
    fn accepts_local_absolute_paths() {
        assert_eq!(classify_tmp_root("C:\\Temp\\hls", &abs_win), None);
        assert_eq!(classify_tmp_root("D:/data/tmp", &abs_win), None);
        assert_eq!(classify_tmp_root("/var/tmp/hls", &abs_posix), None);
    }

    #[test]
    fn rejects_unc_paths_on_every_platform() {
        for path in [
            "\\\\server\\share\\tmp",
            "//server/share/tmp",
            "\\/server/share",
            "/\\server\\share",
        ] {
            assert_eq!(
                classify_tmp_root(path, &|_| true),
                Some(TmpRootProblem::Unc),
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_device_paths() {
        for path in [
            "\\\\?\\UNC\\server\\share",
            "\\\\?\\C:\\tmp",
            "\\\\.\\PhysicalDrive0",
            "//./pipe/x",
            "//?/C:/tmp",
        ] {
            assert_eq!(
                classify_tmp_root(path, &|_| true),
                Some(TmpRootProblem::Device),
                "{path}"
            );
        }
    }

    #[test]
    fn reports_empty_and_relative_values() {
        assert_eq!(
            classify_tmp_root("  ", &|_| true),
            Some(TmpRootProblem::Empty)
        );
        assert_eq!(
            classify_tmp_root("relative/dir", &|_| false),
            Some(TmpRootProblem::NotAbsolute)
        );
    }

    #[test]
    fn trims_before_classifying() {
        assert_eq!(classify_tmp_root("  C:\\Temp  ", &abs_win), None);
        assert_eq!(
            classify_tmp_root("  \\\\srv\\share", &|_| true),
            Some(TmpRootProblem::Unc)
        );
    }

    #[test]
    fn win32_normalize_matches_node() {
        for (input, expected) in [
            ("C:\\Temp\\hls", "C:\\Temp\\hls"),
            ("C:/data/tmp", "C:\\data\\tmp"),
            ("C:\\a\\..\\b\\.\\c", "C:\\b\\c"),
            ("C:\\..\\x", "C:\\x"),
            ("C:\\x\\\\y\\", "C:\\x\\y\\"),
            ("c:/Users/Alice/", "c:\\Users\\Alice\\"),
            ("C:\\", "C:\\"),
            ("C:", "C:."),
            ("C:x\\..\\..\\y", "C:..\\y"),
            ("\\data\\tmp", "\\data\\tmp"),
            ("a\\..\\..\\b", "..\\b"),
            ("", "."),
            ("C:\\tmp.", "C:\\tmp."),
        ] {
            assert_eq!(normalize_win32(input), expected, "{input}");
        }
    }

    #[test]
    fn posix_normalize_matches_node() {
        for (input, expected) in [
            ("/data/tmp", "/data/tmp"),
            ("/a//b/../c/", "/a/c/"),
            ("/../x", "/x"),
            ("/", "/"),
            ("/a/..", "/"),
            ("a/../..", ".."),
            ("a/..", "."),
            ("a/../", "./"),
            ("", "."),
        ] {
            assert_eq!(normalize_posix(input), expected, "{input}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_rules_on_windows() {
        assert!(is_absolute_native("C:\\Temp\\hls"));
        assert!(is_absolute_native("D:/data/tmp"));
        assert!(!is_absolute_native("relative\\dir"));
        assert!(!is_absolute_native("C:rel"));
        assert_eq!(normalize("D:/data//tmp"), "D:\\data\\tmp");
        assert_eq!(
            classify_tmp_root("C:\\Temp\\hls", &is_absolute_native),
            None
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn native_rules_on_posix() {
        assert!(is_absolute_native("/var/tmp"));
        assert!(!is_absolute_native("rel/dir"));
        assert_eq!(normalize("/data//tmp/"), "/data/tmp/");
    }
}
