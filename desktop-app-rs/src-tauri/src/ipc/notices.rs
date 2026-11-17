//! Third-party notices file (port of desktop-app/src/main/ipc/notices.ts). The path is fixed
//! (never renderer input): `<resources>/LICENSES/THIRD-PARTY-NOTICES.txt` in an installed app,
//! `<desktop-app-rs>/LICENSES/THIRD-PARTY-NOTICES.txt` in development. Before it is handed to the
//! OS it must be a regular file (not a directory, not a symlink/junction), so nothing but that
//! text file can ever be opened through this command.

use std::path::{Path, PathBuf};

use crate::dto::ActionResult;

pub const NOTICES_DIR: &str = "LICENSES";
pub const NOTICES_FILE: &str = "THIRD-PARTY-NOTICES.txt";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticesOutcome {
    Opened,
    NotFound,
    Failed,
}

/// Where the notices file lives: next to the app resources, or the project folder in dev.
pub fn notices_path(is_packaged: bool, resources_dir: &Path, app_dir: &Path) -> PathBuf {
    let base = if is_packaged { resources_dir } else { app_dir };

    base.join(NOTICES_DIR).join(NOTICES_FILE)
}

/// The development "app path" (`app.getAppPath()` of Electron): the desktop-app-rs folder.
pub fn dev_app_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

/// True when `path` is a regular file (links are NOT followed).
pub fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
}

pub fn open_notices(
    path: &Path,
    exists: impl FnOnce(&Path) -> bool,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> NoticesOutcome {
    if !exists(path) {
        return NoticesOutcome::NotFound;
    }

    match open(path) {
        Ok(()) => NoticesOutcome::Opened,
        Err(_) => NoticesOutcome::Failed,
    }
}

/// The `app:open-notices` result (same texts as the Electron handler).
pub fn notices_result(outcome: NoticesOutcome) -> ActionResult {
    match outcome {
        NoticesOutcome::Opened => ActionResult::Ok,
        NoticesOutcome::NotFound => ActionResult::err("Notices file not found."),
        NoticesOutcome::Failed => ActionResult::err("Could not open the notices file."),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn resolves_from_resources_when_packaged_and_from_the_app_folder_in_dev() {
        let expected = Path::new(NOTICES_DIR).join(NOTICES_FILE);

        assert_eq!(
            notices_path(true, Path::new("res"), Path::new("app")),
            Path::new("res").join(&expected)
        );
        assert_eq!(
            notices_path(false, Path::new("res"), Path::new("app")),
            Path::new("app").join(&expected)
        );
        assert!(dev_app_dir().ends_with("desktop-app-rs"));
    }

    #[test]
    fn opens_an_existing_file() {
        let path = notices_path(true, Path::new("res"), Path::new("app"));
        let opened = RefCell::new(None);

        assert_eq!(
            open_notices(
                &path,
                |_| true,
                |p| {
                    *opened.borrow_mut() = Some(p.to_path_buf());
                    Ok(())
                }
            ),
            NoticesOutcome::Opened
        );
        assert_eq!(opened.into_inner(), Some(path));
    }

    #[test]
    fn reports_a_missing_file_without_trying_to_open_it() {
        let mut called = false;

        assert_eq!(
            open_notices(
                Path::new("x"),
                |_| false,
                |_| {
                    called = true;
                    Ok(())
                }
            ),
            NoticesOutcome::NotFound
        );
        assert!(!called);
    }

    #[test]
    fn reports_a_failure_when_the_shell_returns_an_error() {
        assert_eq!(
            open_notices(Path::new("x"), |_| true, |_| Err("no handler".into())),
            NoticesOutcome::Failed
        );
    }

    #[test]
    fn maps_outcomes_to_the_electron_texts() {
        assert_eq!(notices_result(NoticesOutcome::Opened), ActionResult::Ok);
        assert_eq!(
            notices_result(NoticesOutcome::NotFound),
            ActionResult::err("Notices file not found.")
        );
        assert_eq!(
            notices_result(NoticesOutcome::Failed),
            ActionResult::err("Could not open the notices file.")
        );
    }

    #[test]
    fn only_a_regular_file_counts_as_present() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(NOTICES_FILE);

        assert!(!is_regular_file(&file));
        std::fs::write(&file, "notices").unwrap();
        assert!(is_regular_file(&file));
        assert!(!is_regular_file(dir.path()));

        #[cfg(unix)]
        {
            let link = dir.path().join("link.txt");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(!is_regular_file(&link));
        }
    }
}
