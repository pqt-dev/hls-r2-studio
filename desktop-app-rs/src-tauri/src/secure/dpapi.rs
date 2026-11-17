//! Windows DPAPI backend: `CryptProtectData` / `CryptUnprotectData` in the current user's scope
//! (no `CRYPTPROTECT_LOCAL_MACHINE`), with `CRYPTPROTECT_UI_FORBIDDEN` so Windows never shows a
//! prompt. A fixed, app-specific entropy value is mixed in, so other software running as the same
//! user cannot decrypt the file with a plain `CryptUnprotectData` call by accident.
//!
//! Note: this is NOT compatible with the Electron app's `token.bin` (Electron's safeStorage uses
//! AES-GCM with a key kept in `Local State`), which is why the vault uses `token.dpapi`.

use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use zeroize::{Zeroize, Zeroizing};

use super::backend::{SecureBackend, SecureError};

const ENTROPY: &[u8] = b"HLS R2 Studio/token/v1";

#[derive(Debug, Default, Clone, Copy)]
pub struct DpapiBackend;

fn blob(data: &[u8]) -> Result<CRYPT_INTEGER_BLOB, SecureError> {
    let len = u32::try_from(data.len()).map_err(|_| SecureError("Data is too large.".into()))?;

    Ok(CRYPT_INTEGER_BLOB {
        cbData: len,
        // DPAPI only reads the input blobs.
        pbData: data.as_ptr().cast_mut(),
    })
}

/// Copies a DPAPI output blob and frees it (wiping it first when it holds plaintext).
///
/// # Safety
/// `out` must be a blob filled by a successful DPAPI call (memory owned by `LocalAlloc`).
unsafe fn take_output(out: &CRYPT_INTEGER_BLOB, wipe: bool) -> Vec<u8> {
    if out.pbData.is_null() {
        return Vec::new();
    }

    let slice = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
    let copy = slice.to_vec();

    if wipe {
        slice.zeroize();
    }

    LocalFree(out.pbData.cast());

    copy
}

fn last_error(what: &str) -> SecureError {
    SecureError(format!(
        "{what} failed: {}",
        std::io::Error::last_os_error()
    ))
}

impl SecureBackend for DpapiBackend {
    fn is_available(&self) -> bool {
        true
    }

    fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>, SecureError> {
        let input = blob(plain)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        // SAFETY: all pointers are valid for the duration of the call; `out` is filled by DPAPI.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };

        if ok == 0 {
            return Err(last_error("CryptProtectData"));
        }

        // SAFETY: `out` was filled by the successful call above.
        Ok(unsafe { take_output(&out, false) })
    }

    fn decrypt(&self, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecureError> {
        let input = blob(data)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        // SAFETY: all pointers are valid for the duration of the call; `out` is filled by DPAPI.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };

        if ok == 0 {
            return Err(last_error("CryptUnprotectData"));
        }

        // SAFETY: `out` was filled by the successful call above.
        Ok(Zeroizing::new(unsafe { take_output(&out, true) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_never_stores_plaintext() {
        let backend = DpapiBackend;
        let encrypted = backend.encrypt(b"1|secrettokenvalue").unwrap();

        assert!(!encrypted
            .windows(b"secrettokenvalue".len())
            .any(|w| w == b"secrettokenvalue"));
        assert_eq!(
            backend.decrypt(&encrypted).unwrap().as_slice(),
            b"1|secrettokenvalue"
        );
    }

    #[test]
    fn rejects_tampered_and_garbage_data() {
        let backend = DpapiBackend;
        let mut encrypted = backend.encrypt(b"token").unwrap();
        let last = encrypted.len() - 1;

        encrypted[last] ^= 0xFF;

        assert!(backend.decrypt(&encrypted).is_err());
        assert!(backend.decrypt(b"garbage").is_err());
    }
}
