//! Test helpers: an in-memory `FileOps` and an `AppStore` backed by it (port of
//! desktop-app/src/main/testing/memoryStore.ts).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::app_store::{create_app_store, AppStore, AppStoreOptions};
use super::file_ops::FileOps;

#[derive(Default)]
pub struct MemoryFileOps {
    pub files: Mutex<HashMap<PathBuf, String>>,
}

impl FileOps for MemoryFileOps {
    fn read(&self, path: &Path) -> io::Result<String> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "ENOENT"))
    }

    fn write(&self, path: &Path, data: &str) -> io::Result<()> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), data.to_string());

        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut files = self.files.lock().unwrap();

        if let Some(data) = files.remove(from) {
            files.insert(to.to_path_buf(), data);
        }

        Ok(())
    }

    fn copy(&self, _from: &Path, _to: &Path) -> io::Result<()> {
        Ok(())
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        self.files.lock().unwrap().remove(path);

        Ok(())
    }

    fn create_dir_all(&self, _path: &Path) -> io::Result<()> {
        Ok(())
    }
}

pub fn create_memory_store(tmp_root: &str) -> AppStore {
    create_app_store(AppStoreOptions {
        dir: PathBuf::from("/memory"),
        default_tmp_root: tmp_root.to_string(),
        debounce: Some(Duration::from_millis(5)),
        file_ops: Some(Arc::new(MemoryFileOps::default())),
        on_error: None,
    })
}
