//! Keeps the site API token. Port of desktop-app/src/main/secure/tokenVault.ts: the token is
//! written to disk only when it can be encrypted; otherwise it stays in memory for the session.
//!
//! File: `<user data>/token.dpapi`. The Electron app's `token.bin` (safeStorage format) is never
//! read, written or deleted, so users sign in once after switching apps.
//!
//! File I/O is synchronous: the file is a few hundred bytes and DPAPI is a local call.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use super::backend::SecureBackend;
use super::secret::Secret;

pub const TOKEN_FILE_NAME: &str = "token.dpapi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveResult {
    Persisted,
    MemoryOnly,
}

/// What the auth service needs from the vault (the `TokenStore` interface of authService.ts).
pub trait TokenStore: Send + Sync {
    /// Token currently held in memory (after `load` or a save).
    fn get(&self) -> Option<Secret>;
    /// Loads the persisted token. `None` when missing, empty, corrupt or undecryptable.
    fn load(&self) -> Option<Secret>;
    /// Stores the token in memory and, when encryption is available, on disk.
    fn save(&self, token: Secret) -> io::Result<SaveResult>;
    /// Keeps the token in memory only and removes any previously saved file.
    fn save_memory_only(&self, token: Secret) -> io::Result<()>;
    /// Forgets the token in memory and deletes the file.
    fn clear(&self) -> io::Result<()>;
}

pub struct TokenVault {
    dir: PathBuf,
    file_path: PathBuf,
    backend: Arc<dyn SecureBackend>,
    token: Mutex<Option<Secret>>,
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;

    file.write_all(data)
}

/// Windows: the file inherits the ACL of the per-user data folder (`%APPDATA%`).
#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    fs::write(path, data)
}

impl TokenVault {
    pub fn new(dir: PathBuf, backend: Arc<dyn SecureBackend>) -> Self {
        Self::with_file_name(dir, backend, TOKEN_FILE_NAME)
    }

    pub fn with_file_name(dir: PathBuf, backend: Arc<dyn SecureBackend>, file_name: &str) -> Self {
        let file_path = dir.join(file_name);

        Self {
            dir,
            file_path,
            backend,
            token: Mutex::new(None),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    fn memory(&self) -> MutexGuard<'_, Option<Secret>> {
        self.token.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn tmp_path(&self) -> PathBuf {
        let mut os = self.file_path.as_os_str().to_owned();
        os.push(".tmp");

        PathBuf::from(os)
    }

    /// Writes `<file>.tmp` and renames it over the file. A leftover temp file is removed when a
    /// step fails.
    fn write_atomically(&self, data: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;

        let tmp = self.tmp_path();
        let written = write_private(&tmp, data).and_then(|()| fs::rename(&tmp, &self.file_path));

        if written.is_err() {
            let _ = remove_if_exists(&tmp);
        }

        written
    }
}

impl TokenStore for TokenVault {
    fn get(&self) -> Option<Secret> {
        self.memory().clone()
    }

    fn load(&self) -> Option<Secret> {
        if let Some(token) = self.memory().clone() {
            return Some(token);
        }

        if !self.backend.is_available() {
            return None;
        }

        let data = fs::read(&self.file_path).ok()?;

        if data.is_empty() {
            return None;
        }

        let mut plain = self.backend.decrypt(&data).ok()?;
        // Moves the buffer (no copy): it is wiped by `Secret`, or right here when rejected.
        let token = match String::from_utf8(std::mem::take(&mut *plain)) {
            Ok(text) => Secret::new(text),
            Err(error) => {
                drop(zeroize::Zeroizing::new(error.into_bytes()));

                return None;
            }
        };

        if token.is_empty() {
            return None;
        }

        *self.memory() = Some(token.clone());

        Some(token)
    }

    fn save(&self, token: Secret) -> io::Result<SaveResult> {
        let plain = token.expose().as_bytes().to_vec();
        let plain = zeroize::Zeroizing::new(plain);

        *self.memory() = Some(token);

        if !self.backend.is_available() {
            remove_if_exists(&self.file_path)?;

            return Ok(SaveResult::MemoryOnly);
        }

        let Ok(encrypted) = self.backend.encrypt(&plain) else {
            remove_if_exists(&self.file_path)?;

            return Ok(SaveResult::MemoryOnly);
        };

        self.write_atomically(&encrypted)?;

        Ok(SaveResult::Persisted)
    }

    fn save_memory_only(&self, token: Secret) -> io::Result<()> {
        *self.memory() = Some(token);

        remove_if_exists(&self.file_path)
    }

    fn clear(&self) -> io::Result<()> {
        *self.memory() = None;

        remove_if_exists(&self.file_path)
    }
}

#[cfg(test)]
pub mod testing {
    //! Fake backend shared by the vault and auth tests: "encrypts" by reversing and prefixing, so
    //! plaintext never appears on disk (same as the TS test helper).

    use std::sync::atomic::{AtomicBool, Ordering};

    use zeroize::Zeroizing;

    use crate::secure::backend::{SecureBackend, SecureError};

    pub struct FakeBackend {
        pub available: AtomicBool,
        pub fail_encrypt: AtomicBool,
        pub fail_decrypt: AtomicBool,
    }

    impl FakeBackend {
        pub fn new(available: bool) -> Self {
            Self {
                available: AtomicBool::new(available),
                fail_encrypt: AtomicBool::new(false),
                fail_decrypt: AtomicBool::new(false),
            }
        }
    }

    impl SecureBackend for FakeBackend {
        fn is_available(&self) -> bool {
            self.available.load(Ordering::SeqCst)
        }

        fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>, SecureError> {
            if self.fail_encrypt.load(Ordering::SeqCst) {
                return Err(SecureError("boom".into()));
            }

            let mut out = b"ENC:".to_vec();
            out.extend(plain.iter().rev());

            Ok(out)
        }

        fn decrypt(&self, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecureError> {
            if self.fail_decrypt.load(Ordering::SeqCst) {
                return Err(SecureError("DPAPI failure".into()));
            }

            let Some(rest) = data.strip_prefix(b"ENC:") else {
                return Err(SecureError("bad data".into()));
            };

            Ok(Zeroizing::new(rest.iter().rev().copied().collect()))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::testing::FakeBackend;
    use super::*;

    fn fake(available: bool) -> Arc<FakeBackend> {
        Arc::new(FakeBackend::new(available))
    }

    fn vault(dir: &Path, backend: Arc<FakeBackend>) -> TokenVault {
        TokenVault::new(dir.to_path_buf(), backend)
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();

        names
    }

    fn exposed(token: Option<Secret>) -> Option<String> {
        token.map(|t| t.expose().to_string())
    }

    #[test]
    fn persists_an_encrypted_token_and_loads_it_in_a_new_instance() {
        let dir = tempfile::tempdir().unwrap();
        let backend = fake(true);
        let first = vault(dir.path(), backend.clone());

        assert_eq!(
            first.save("1|secrettokenvalue".into()).unwrap(),
            SaveResult::Persisted
        );

        let on_disk = fs::read(dir.path().join(TOKEN_FILE_NAME)).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("secrettokenvalue"));

        let second = vault(dir.path(), backend);
        assert!(second.get().is_none());
        assert_eq!(
            exposed(second.load()).as_deref(),
            Some("1|secrettokenvalue")
        );
        assert_eq!(exposed(second.get()).as_deref(), Some("1|secrettokenvalue"));
    }

    #[test]
    fn returns_none_when_the_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();

        assert!(vault(dir.path(), fake(true)).load().is_none());
    }

    #[test]
    fn returns_none_for_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TOKEN_FILE_NAME), "garbage").unwrap();

        assert!(vault(dir.path(), fake(true)).load().is_none());
    }

    #[test]
    fn returns_none_for_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TOKEN_FILE_NAME), "").unwrap();

        assert!(vault(dir.path(), fake(true)).load().is_none());
    }

    #[test]
    fn returns_none_for_an_empty_or_non_utf8_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);

        fs::write(&path, "ENC:").unwrap();
        assert!(vault(dir.path(), fake(true)).load().is_none());

        fs::write(&path, [b'E', b'N', b'C', b':', 0xFF, 0xFE]).unwrap();
        assert!(vault(dir.path(), fake(true)).load().is_none());
    }

    #[test]
    fn returns_none_when_decryption_fails() {
        let dir = tempfile::tempdir().unwrap();
        vault(dir.path(), fake(true)).save("tok".into()).unwrap();

        let backend = fake(true);
        backend.fail_decrypt.store(true, Ordering::SeqCst);

        assert!(vault(dir.path(), backend).load().is_none());
    }

    #[test]
    fn returns_none_on_load_when_encryption_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        vault(dir.path(), fake(true)).save("tok".into()).unwrap();

        assert!(vault(dir.path(), fake(false)).load().is_none());
    }

    #[test]
    fn refuses_to_write_to_disk_when_encryption_is_unavailable_but_keeps_the_token_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let v = vault(dir.path(), fake(false));

        assert_eq!(
            v.save("session-token".into()).unwrap(),
            SaveResult::MemoryOnly
        );
        assert_eq!(exposed(v.get()).as_deref(), Some("session-token"));
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn removes_a_stale_token_file_when_encryption_becomes_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        vault(dir.path(), fake(true)).save("old".into()).unwrap();

        let v = vault(dir.path(), fake(false));

        assert_eq!(v.save("new".into()).unwrap(), SaveResult::MemoryOnly);
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn falls_back_to_memory_only_when_encrypt_fails() {
        let dir = tempfile::tempdir().unwrap();
        let backend = fake(true);
        backend.fail_encrypt.store(true, Ordering::SeqCst);
        let v = vault(dir.path(), backend);

        assert_eq!(v.save("tok".into()).unwrap(), SaveResult::MemoryOnly);
        assert_eq!(exposed(v.get()).as_deref(), Some("tok"));
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn save_memory_only_removes_a_saved_file() {
        let dir = tempfile::tempdir().unwrap();
        let v = vault(dir.path(), fake(true));

        v.save("disk".into()).unwrap();
        v.save_memory_only("mem".into()).unwrap();

        assert_eq!(exposed(v.get()).as_deref(), Some("mem"));
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn clear_removes_the_file_and_the_in_memory_token() {
        let dir = tempfile::tempdir().unwrap();
        let v = vault(dir.path(), fake(true));

        v.save("tok".into()).unwrap();
        v.clear().unwrap();

        assert!(v.get().is_none());
        assert!(entries(dir.path()).is_empty());
        v.clear().unwrap();
    }

    #[test]
    fn leaves_no_temp_file_behind_after_saving() {
        let dir = tempfile::tempdir().unwrap();

        vault(dir.path(), fake(true)).save("tok".into()).unwrap();

        assert_eq!(entries(dir.path()), [TOKEN_FILE_NAME]);
    }

    #[test]
    fn creates_the_directory_and_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        let v = vault(&nested, fake(true));

        v.save("one".into()).unwrap();
        v.save("two".into()).unwrap();

        let fresh = vault(&nested, fake(true));
        assert_eq!(exposed(fresh.load()).as_deref(), Some("two"));
    }

    #[test]
    fn never_touches_the_electron_token_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("token.bin"), "electron data").unwrap();
        let v = vault(dir.path(), fake(true));

        assert!(v.load().is_none());
        v.save("tok".into()).unwrap();
        v.clear().unwrap();

        assert_eq!(entries(dir.path()), ["token.bin"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let v = vault(dir.path(), fake(true));
        v.save("tok".into()).unwrap();

        let mode = fs::metadata(v.file_path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_failed_write_keeps_the_token_in_memory_and_reports_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "a file, not a directory").unwrap();
        let v = vault(&blocker.join("sub"), fake(true));

        assert!(v.save("tok".into()).is_err());
        assert_eq!(exposed(v.get()).as_deref(), Some("tok"));
    }

    #[test]
    fn debug_of_a_held_token_is_redacted() {
        let dir = tempfile::tempdir().unwrap();
        let v = vault(dir.path(), fake(false));
        v.save("1|abcdefghijklmnopqrstuvwxyz".into()).unwrap();

        assert!(!format!("{:?}", v.get()).contains("abcdef"));
    }

    #[cfg(windows)]
    #[test]
    fn round_trips_through_dpapi_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let v = TokenVault::new(dir.path().to_path_buf(), crate::secure::default_backend());

        assert_eq!(
            v.save("1|dpapi-token".into()).unwrap(),
            SaveResult::Persisted
        );

        let fresh = TokenVault::new(dir.path().to_path_buf(), crate::secure::default_backend());
        assert_eq!(exposed(fresh.load()).as_deref(), Some("1|dpapi-token"));

        // Tampered file: undecryptable, so no token.
        let path = dir.path().join(TOKEN_FILE_NAME);
        let mut data = fs::read(&path).unwrap();
        let last = data.len() - 1;
        data[last] ^= 0xFF;
        fs::write(&path, data).unwrap();

        let tampered = TokenVault::new(dir.path().to_path_buf(), crate::secure::default_backend());
        assert!(tampered.load().is_none());
    }
}
