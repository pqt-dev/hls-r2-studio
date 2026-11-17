//! File operations used by the store; injectable so tests can observe, slow down or fail them.
//! Mirrors `FileOps` in desktop-app/src/main/store/jsonStore.ts.

use std::fs;
use std::io;
use std::path::Path;

pub trait FileOps: Send + Sync {
    /// Reads the file as UTF-8 text. Invalid bytes are replaced (like Node's `readFile(.., 'utf8')`),
    /// so a damaged file fails JSON parsing (and is backed up) instead of looking "missing".
    fn read(&self, path: &Path) -> io::Result<String>;
    fn write(&self, path: &Path, data: &str) -> io::Result<()>;
    /// Must replace an existing destination (see `StdFileOps`).
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn copy(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Removes a file; a missing file is not an error (`rm(path, { force: true })`).
    fn remove(&self, path: &Path) -> io::Result<()>;
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
}

/// The real file system.
///
/// `fs::rename` replaces an existing destination on every platform: on Windows std calls
/// `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` (newer toolchains use POSIX-style replace), the same
/// call libuv makes for Node's `fs.rename`. So the "write temp file, rename over the old one" step
/// needs no special handling there (the `rename_replaces_an_existing_file` test runs on Windows CI).
#[derive(Debug, Default, Clone, Copy)]
pub struct StdFileOps;

impl FileOps for StdFileOps {
    fn read(&self, path: &Path) -> io::Result<String> {
        let bytes = fs::read(path)?;

        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn write(&self, path: &Path, data: &str) -> io::Result<()> {
        fs::write(path, data)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::copy(from, to).map(|_| ())
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.tmp");
        let to = dir.path().join("a.json");

        fs::write(&to, "old").unwrap();
        fs::write(&from, "new").unwrap();
        StdFileOps.rename(&from, &to).unwrap();

        assert_eq!(fs::read_to_string(&to).unwrap(), "new");
        assert!(!from.exists());
    }

    #[test]
    fn remove_ignores_a_missing_file_and_read_replaces_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x");

        StdFileOps.remove(&path).unwrap();
        fs::write(&path, [b'a', 0xFF, b'b']).unwrap();
        assert_eq!(StdFileOps.read(&path).unwrap(), "a\u{FFFD}b");
    }
}
