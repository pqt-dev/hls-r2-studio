//! Encryption backend of the token vault (port of desktop-app/src/main/secure/backend.ts).
//!
//! Windows: DPAPI (`dpapi.rs`). Other platforms have no backend yet, so they report "unavailable"
//! and the token stays in memory for the session (exactly what the Electron app does when
//! `safeStorage` is unavailable). There is deliberately no fallback "encryption".

use std::fmt;
use std::sync::Arc;

use zeroize::Zeroizing;

/// Why an encrypt/decrypt call failed. Never carries plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecureError(pub String);

impl fmt::Display for SecureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SecureError {}

/// Abstraction over the OS secret protection so the vault can be tested with a fake.
pub trait SecureBackend: Send + Sync {
    fn is_available(&self) -> bool;
    fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>, SecureError>;
    /// The plaintext is returned in a buffer that is wiped when dropped.
    fn decrypt(&self, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecureError>;
}

/// A platform without secret protection: nothing is ever written to disk.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableBackend;

impl SecureBackend for UnavailableBackend {
    fn is_available(&self) -> bool {
        false
    }

    fn encrypt(&self, _plain: &[u8]) -> Result<Vec<u8>, SecureError> {
        Err(SecureError("Encryption is not available.".into()))
    }

    fn decrypt(&self, _data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SecureError> {
        Err(SecureError("Encryption is not available.".into()))
    }
}

/// The backend of this platform.
pub fn default_backend() -> Arc<dyn SecureBackend> {
    #[cfg(windows)]
    {
        Arc::new(super::dpapi::DpapiBackend)
    }

    #[cfg(not(windows))]
    {
        Arc::new(UnavailableBackend)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unavailable_backend_never_encrypts() {
        let backend = UnavailableBackend;

        assert!(!backend.is_available());
        assert!(backend.encrypt(b"x").is_err());
        assert!(backend.decrypt(b"x").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_platforms_keep_the_token_in_memory_only() {
        assert!(!default_backend().is_available());
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_dpapi() {
        assert!(default_backend().is_available());
    }
}
