//! Safety of the job temp directory deletion: only `<tmp_root>/<public id>` is ever removed,
//! links are never followed, `..` / empty / relative / root paths are refused.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;

const ID: &str = "ab12cd34ef56";

struct Rig {
    _dir: tempfile::TempDir,
    root: PathBuf,
    /// A directory next to the temp root that must survive every test.
    outside: PathBuf,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("tmp");
    let outside = dir.path().join("outside");

    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(outside.join("deep")).unwrap();
    fs::write(outside.join("precious.txt"), b"keep me").unwrap();
    fs::write(outside.join("deep").join("also.txt"), b"keep me too").unwrap();

    Rig {
        _dir: dir,
        root,
        outside,
    }
}

fn outside_intact(r: &Rig) -> bool {
    fs::read(r.outside.join("precious.txt")).ok().as_deref() == Some(b"keep me".as_slice())
        && r.outside.join("deep").join("also.txt").is_file()
}

fn make_job_dir(root: &Path) -> PathBuf {
    let dir = root.join(ID);

    fs::create_dir_all(dir.join("sub")).unwrap();
    fs::write(dir.join("segment_000.ts"), b"x").unwrap();
    fs::write(dir.join("sub").join("y.jpg"), b"y").unwrap();

    dir
}

fn refused(result: Result<(), RemoveError>) -> bool {
    matches!(result, Err(RemoveError::Unsafe(_)))
}

#[test]
fn removes_the_job_dir_with_its_content_and_nothing_else() {
    let r = rig();
    let dir = make_job_dir(&r.root);

    fs::write(r.root.join("other.txt"), b"sibling").unwrap();
    remove_job_dir_blocking(&r.root, &dir).unwrap();

    assert!(!dir.exists());
    assert!(r.root.is_dir());
    assert!(r.root.join("other.txt").is_file());
    assert!(outside_intact(&r));
}

#[test]
fn a_missing_dir_is_fine() {
    let r = rig();

    remove_job_dir_blocking(&r.root, &r.root.join(ID)).unwrap();
    // Even when the temp root itself is gone.
    remove_job_dir_blocking(&r.root.join("gone"), &r.root.join("gone").join(ID)).unwrap();
}

#[test]
fn refuses_empty_and_relative_paths() {
    let r = rig();

    assert!(refused(remove_job_dir_blocking(
        Path::new(""),
        &r.root.join(ID)
    )));
    assert!(refused(remove_job_dir_blocking(&r.root, Path::new(""))));
    assert!(refused(remove_job_dir_blocking(
        Path::new("tmp"),
        Path::new("tmp").join(ID).as_path()
    )));
}

#[test]
fn refuses_dot_dot_traversal_even_to_a_job_named_dir() {
    let r = rig();
    // `<root>/../<id>` exists and has a valid job name, but is outside the temp root.
    let escaped = r.root.parent().unwrap().join(ID);

    fs::create_dir_all(&escaped).unwrap();
    fs::write(escaped.join("keep.txt"), b"k").unwrap();

    let traversal = r.root.join("..").join(ID);

    assert!(refused(remove_job_dir_blocking(&r.root, &traversal)));
    // `..` that would land back inside the root is refused too (no lexical games at all).
    assert!(refused(remove_job_dir_blocking(
        &r.root,
        &r.root.join("sub").join("..").join(ID)
    )));
    assert!(refused(remove_job_dir_blocking(
        &r.root.join("..").join("tmp"),
        &r.root.join("..").join("tmp").join(ID)
    )));
    assert!(escaped.join("keep.txt").is_file());
}

#[test]
fn refuses_anything_but_a_direct_child_with_a_job_id_name() {
    let r = rig();
    let nested = r.root.join("sub").join(ID);

    fs::create_dir_all(&nested).unwrap();

    assert!(refused(remove_job_dir_blocking(&r.root, &nested)));
    assert!(refused(remove_job_dir_blocking(&r.root, &r.root)));
    assert!(refused(remove_job_dir_blocking(&r.root, &r.outside)));
    assert!(refused(remove_job_dir_blocking(
        &r.root,
        &r.root.join("notanid")
    )));
    assert!(refused(remove_job_dir_blocking(
        &r.root,
        &r.root.join("AB12CD34EF56")
    )));
    assert!(nested.is_dir());
    assert!(outside_intact(&r));
}

#[test]
fn refuses_a_filesystem_root_as_temp_root() {
    let root = if cfg!(windows) {
        PathBuf::from("C:\\")
    } else {
        PathBuf::from("/")
    };

    assert!(is_filesystem_root(&root));
    assert!(refused(remove_job_dir_blocking(&root, &root.join(ID))));
    assert!(refused(check_lexical(&root, &root.join(ID))));
}

#[test]
fn a_regular_file_in_place_of_the_dir_is_removed_as_a_file() {
    let r = rig();
    let file = r.root.join(ID);

    fs::write(&file, b"x").unwrap();
    remove_job_dir_blocking(&r.root, &file).unwrap();

    assert!(!file.exists());
}

#[tokio::test]
async fn prepare_wipes_an_old_dir_and_creates_an_empty_one() {
    let r = rig();
    let old = make_job_dir(&r.root);
    let dir = prepare_job_dir(&r.root, ID).await.unwrap();

    assert_eq!(dir, old);
    assert!(dir.is_dir());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);

    // The temp root is created when missing.
    let fresh = r.root.join("new-root");
    let made = prepare_job_dir(&fresh, ID).await.unwrap();

    assert!(made.is_dir());
}

#[tokio::test]
async fn the_async_wrapper_removes_and_logs_refusals() {
    use crate::logger::testing::RecordingLogger;

    let r = rig();
    let dir = make_job_dir(&r.root);
    let logger = RecordingLogger::default();

    remove_job_dir(&r.root, Some(&dir), &logger).await;
    remove_job_dir(&r.root, None, &logger).await;

    assert!(!dir.exists());
    assert!(logger.entries.lock().unwrap().is_empty());

    remove_job_dir(&r.root, Some(&r.outside), &logger).await;

    assert!(outside_intact(&r));
    assert!(logger
        .text()
        .contains("Could not remove the job temp directory"));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_symlink_inside_the_job_dir_is_removed_without_following_it() {
        let r = rig();
        let dir = make_job_dir(&r.root);

        symlink(&r.outside, dir.join("link-to-outside")).unwrap();
        symlink(r.outside.join("precious.txt"), dir.join("file-link")).unwrap();
        remove_job_dir_blocking(&r.root, &dir).unwrap();

        assert!(!dir.exists());
        assert!(outside_intact(&r));
    }

    #[test]
    fn a_job_dir_that_is_a_symlink_is_unlinked_not_followed() {
        let r = rig();
        let link = r.root.join(ID);

        symlink(&r.outside, &link).unwrap();
        remove_job_dir_blocking(&r.root, &link).unwrap();

        assert!(fs::symlink_metadata(&link).is_err());
        assert!(outside_intact(&r));
    }

    #[tokio::test]
    async fn prepare_replaces_a_planted_symlink_with_a_real_dir() {
        let r = rig();
        let link = r.root.join(ID);

        symlink(&r.outside, &link).unwrap();

        let dir = prepare_job_dir(&r.root, ID).await.unwrap();
        let meta = fs::symlink_metadata(&dir).unwrap();

        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert!(outside_intact(&r));
    }

    #[test]
    fn a_symlinked_temp_root_is_resolved_and_only_its_job_dir_removed() {
        let r = rig();
        let real_root = r.outside.join("real-tmp");
        let dir = make_job_dir(&real_root);
        let alias = r.root.join("alias");

        symlink(&real_root, &alias).unwrap();
        remove_job_dir_blocking(&alias, &alias.join(ID)).unwrap();

        assert!(!dir.exists());
        assert!(real_root.is_dir());
        assert!(outside_intact(&r));
    }

    #[test]
    fn a_parent_swapped_for_a_symlink_cannot_redirect_the_delete() {
        let r = rig();
        // `<root>/<id>` resolves (through a symlinked parent component of the job path) to a
        // directory that is NOT directly inside the real temp root.
        let target_parent = r.outside.join("elsewhere");
        let victim = target_parent.join(ID);

        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("keep.txt"), b"k").unwrap();

        let fake_root = r.root.join("fake-root");

        symlink(&target_parent, &fake_root).unwrap();

        // The caller claims the temp root is `<root>` but passes a dir under the symlink.
        assert!(refused(remove_job_dir_blocking(
            &r.root,
            &fake_root.join(ID)
        )));
        assert!(victim.join("keep.txt").is_file());
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::process::Command;

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();

        assert!(status.success(), "mklink /J failed");
    }

    #[test]
    fn a_junction_inside_the_job_dir_is_removed_without_following_it() {
        let r = rig();
        let dir = make_job_dir(&r.root);

        junction(&dir.join("junction-to-outside"), &r.outside);
        remove_job_dir_blocking(&r.root, &dir).unwrap();

        assert!(!dir.exists());
        assert!(outside_intact(&r));
    }

    #[test]
    fn a_job_dir_that_is_a_junction_is_unlinked_not_followed() {
        let r = rig();
        let link = r.root.join(ID);

        junction(&link, &r.outside);
        remove_job_dir_blocking(&r.root, &link).unwrap();

        assert!(fs::symlink_metadata(&link).is_err());
        assert!(outside_intact(&r));
    }

    #[tokio::test]
    async fn prepare_replaces_a_planted_junction_with_a_real_dir() {
        let r = rig();

        junction(&r.root.join(ID), &r.outside);

        let dir = prepare_job_dir(&r.root, ID).await.unwrap();

        assert!(!is_link(&fs::symlink_metadata(&dir).unwrap()));
        assert!(outside_intact(&r));
    }

    #[test]
    fn removes_a_tree_deeper_than_max_path() {
        let r = rig();
        let dir = make_job_dir(&r.root);
        let mut deep = dir.clone();

        while deep.as_os_str().len() < 400 {
            deep = deep.join("a-fairly-long-directory-name");
        }

        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("segment_000.ts"), b"x").unwrap();
        remove_job_dir_blocking(&r.root, &dir).unwrap();

        assert!(!dir.exists());
        assert!(outside_intact(&r));
    }

    #[test]
    fn refuses_drive_roots_and_unc_roots() {
        for root in ["C:\\", "D:\\", "\\\\?\\C:\\", "\\\\server\\share\\"] {
            let root = PathBuf::from(root);

            assert!(refused(check_lexical(&root, &root.join(ID))), "{root:?}");
        }
    }

    #[test]
    fn compares_paths_case_insensitively() {
        assert!(same_path(
            Path::new("C:\\Temp\\HLS"),
            Path::new("c:\\temp\\hls")
        ));
    }
}
