//! Filesystem helpers of the steps (port of steps/fsUtil.ts), over [`StepFs`].

use std::path::{Path, PathBuf};

use crate::pipeline::deps::StepFs;

/// True when `path` is an existing regular file.
pub async fn file_exists(fs: &dyn StepFs, path: &Path) -> bool {
    fs.is_file(path).await
}

/// Deletes the files, ignoring missing ones and any error (best-effort temp cleanup).
pub async fn remove_files(fs: &dyn StepFs, paths: &[PathBuf]) {
    fs.remove_files(paths).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::deps::{RealFs, StepFs};

    #[tokio::test]
    async fn file_exists_is_true_for_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jpg");

        std::fs::write(&file, b"x").unwrap();

        assert!(file_exists(&RealFs, &file).await);
        assert!(!file_exists(&RealFs, dir.path()).await);
        assert!(!file_exists(&RealFs, &dir.path().join("missing")).await);
    }

    #[tokio::test]
    async fn remove_files_ignores_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jpg");

        std::fs::write(&file, b"x").unwrap();
        remove_files(&RealFs, &[file.clone(), dir.path().join("missing")]).await;

        assert!(!file.exists());
    }

    #[tokio::test]
    async fn real_fs_lists_reads_and_copies() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");

        std::fs::write(&a, b"hi").unwrap();
        RealFs.copy(&a, &b).await.unwrap();

        let mut names = RealFs.list_names(dir.path()).await.unwrap();

        names.sort();

        assert_eq!(names, ["a.txt", "b.txt"]);
        assert_eq!(RealFs.read(&b).await.unwrap(), b"hi");
        assert_eq!(RealFs.file_size(&b).await, Some(2));
    }
}
