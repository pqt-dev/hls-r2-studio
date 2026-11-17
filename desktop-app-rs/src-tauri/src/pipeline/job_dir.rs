//! The per-job temp directory `<tmp_root>/<public_id>/`: creation and SAFE recursive removal
//! (the TS `rm(jobDir, { recursive: true, force: true })`).
//!
//! A recursive delete only ever runs on a directory that is provably the job's own:
//! 1. lexical checks (no filesystem access): both paths non-empty and absolute, no `.`/`..`
//!    components, the temp root is not a filesystem/drive root, the directory name is a valid
//!    public id (12 x `[a-z0-9]`) and its parent IS the temp root;
//! 2. the directory itself is looked at WITHOUT following links: a symlink / junction is
//!    removed as a link (its target is never touched); a plain file is removed as a file;
//! 3. both paths are canonicalized (real paths, `\\?\` long-path form on Windows) and the real
//!    directory must sit directly inside the real temp root, which must not be a root itself;
//! 4. the delete is `std::fs::remove_dir_all` on that verified real path, which never follows
//!    symlinks or junctions inside the tree (it removes the links themselves).

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::logger::Log;
use crate::pipeline::fault::Fault;
use crate::pipeline::public_id::is_valid_public_id;

/// Retries of a failed removal (antivirus / indexer locks on Windows), like Node's
/// `maxRetries: 3, retryDelay: 200` (linear backoff).
const REMOVE_RETRIES: u32 = 3;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub enum RemoveError {
    /// The path is not provably the job's own directory: nothing was touched.
    Unsafe(String),
    Io(io::Error),
}

impl std::fmt::Display for RemoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsafe(reason) => write!(f, "refused to delete the job temp directory: {reason}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<io::Error> for RemoveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<RemoveError> for Fault {
    fn from(error: RemoveError) -> Self {
        match error {
            RemoveError::Io(error) => Fault::Io(error),
            unsafe_path @ RemoveError::Unsafe(_) => Fault::Other(unsafe_path.to_string()),
        }
    }
}

pub fn job_dir_path(tmp_root: &Path, public_id: &str) -> PathBuf {
    tmp_root.join(public_id)
}

/// Same path, component by component (case-insensitive on Windows, like the filesystem).
pub fn same_path(a: &Path, b: &Path) -> bool {
    let left: Vec<Component<'_>> = a.components().collect();
    let right: Vec<Component<'_>> = b.components().collect();

    left.len() == right.len()
        && left.iter().zip(&right).all(|(x, y)| {
            if cfg!(windows) {
                x.as_os_str().to_string_lossy().to_lowercase()
                    == y.as_os_str().to_string_lossy().to_lowercase()
            } else {
                x == y
            }
        })
}

/// True for `/`, `C:\`, `\\?\C:\`, `\\server\share\` (a path without a parent).
pub fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn has_dot_components(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
}

/// Checks 1 (no filesystem access).
pub fn check_lexical(tmp_root: &Path, job_dir: &Path) -> Result<(), RemoveError> {
    let refuse = |reason: &str| Err(RemoveError::Unsafe(reason.to_string()));

    if tmp_root.as_os_str().is_empty() || job_dir.as_os_str().is_empty() {
        return refuse("empty path");
    }

    if !tmp_root.is_absolute() || !job_dir.is_absolute() {
        return refuse("not an absolute path");
    }

    if has_dot_components(tmp_root) || has_dot_components(job_dir) {
        return refuse("the path contains . or .. components");
    }

    if is_filesystem_root(tmp_root) {
        return refuse("the temp root is a filesystem root");
    }

    let name_ok = job_dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_valid_public_id);

    if !name_ok {
        return refuse("the directory name is not a job id");
    }

    if !job_dir.parent().is_some_and(|p| same_path(p, tmp_root)) {
        return refuse("the directory is not directly inside the temp root");
    }

    Ok(())
}

/// A symlink or (Windows) a junction / any name-surrogate reparse point: never followed. Same
/// rule as `std::fs::remove_dir_all`. Other reparse points (e.g. cloud-file placeholders) are
/// real directories; step 3 still checks where they resolve.
fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Removes the link itself (not its target).
fn remove_link(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;

        // Directory symlinks and junctions are removed with RemoveDirectory, which deletes the
        // reparse point and never touches the target. (`is_dir()` is false for them.)
        if meta.file_type().is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }

    let _ = meta;

    fs::remove_file(path)
}

/// Removes `job_dir` recursively when (and only when) it is provably the job's own temp
/// directory inside `tmp_root`. A missing directory is fine.
pub fn remove_job_dir_blocking(tmp_root: &Path, job_dir: &Path) -> Result<(), RemoveError> {
    check_lexical(tmp_root, job_dir)?;

    let meta = match fs::symlink_metadata(job_dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if is_link(&meta) {
        return Ok(remove_link(job_dir, &meta)?);
    }

    if !meta.is_dir() {
        return Ok(fs::remove_file(job_dir)?);
    }

    let real_root = fs::canonicalize(tmp_root)?;

    if is_filesystem_root(&real_root) {
        return Err(RemoveError::Unsafe(
            "the temp root resolves to a filesystem root".into(),
        ));
    }

    let real_dir = fs::canonicalize(job_dir)?;
    let inside = real_dir
        .parent()
        .is_some_and(|parent| same_path(parent, &real_root))
        && real_dir.file_name() == job_dir.file_name();

    if !inside {
        return Err(RemoveError::Unsafe(
            "the directory resolves outside the temp root".into(),
        ));
    }

    match fs::remove_dir_all(&real_dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => Ok(other?),
    }
}

/// [`remove_job_dir_blocking`] off the async runtime, with the retries.
pub async fn remove_job_dir_checked(tmp_root: &Path, job_dir: &Path) -> Result<(), RemoveError> {
    let mut attempt = 0;

    loop {
        let (root, dir) = (tmp_root.to_path_buf(), job_dir.to_path_buf());
        let result = tokio::task::spawn_blocking(move || remove_job_dir_blocking(&root, &dir))
            .await
            .unwrap_or_else(|_| Err(RemoveError::Io(io::Error::other("the removal panicked"))));

        match result {
            Err(RemoveError::Io(_)) if attempt < REMOVE_RETRIES => {
                attempt += 1;
                tokio::time::sleep(REMOVE_RETRY_DELAY * attempt).await;
            }
            other => return other,
        }
    }
}

/// Best-effort removal after a run (`removeJobDir` of the TS): failures are only logged.
pub async fn remove_job_dir(tmp_root: &Path, job_dir: Option<&Path>, logger: &dyn Log) {
    let Some(job_dir) = job_dir else {
        return;
    };

    if let Err(error) = remove_job_dir_checked(tmp_root, job_dir).await {
        logger.warn(
            "Could not remove the job temp directory.",
            Some(json!({ "error": error.to_string() })),
        );
    }
}

/// Step 0: `<tmp_root>/<public_id>` is removed if it exists (safely) and created empty.
pub async fn prepare_job_dir(tmp_root: &Path, public_id: &str) -> Result<PathBuf, Fault> {
    let dir = job_dir_path(tmp_root, public_id);

    remove_job_dir_checked(tmp_root, &dir).await?;

    let (root, created) = (tmp_root.to_path_buf(), dir.clone());

    tokio::task::spawn_blocking(move || -> Result<(), Fault> {
        fs::create_dir_all(&root)?;
        // Not recursive: fails if anything (even a link) appeared in the meantime.
        fs::create_dir(&created)?;

        let real_root = fs::canonicalize(&root)?;
        let real_dir = fs::canonicalize(&created)?;

        if !real_dir
            .parent()
            .is_some_and(|parent| same_path(parent, &real_root))
        {
            return Err(Fault::Other(
                "the job temp directory resolves outside the temp root".into(),
            ));
        }

        Ok(())
    })
    .await
    .map_err(|_| Fault::Other("creating the job temp directory panicked".into()))??;

    Ok(dir)
}

#[cfg(test)]
#[path = "job_dir_tests.rs"]
mod tests;
