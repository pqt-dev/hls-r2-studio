//! Secret handling: the `Secret` string type, the OS encryption backend (DPAPI on Windows) and
//! the token vault.

pub mod backend;
#[cfg(windows)]
pub mod dpapi;
pub mod secret;
pub mod token_vault;

pub use backend::{default_backend, SecureBackend, SecureError, UnavailableBackend};
pub use secret::Secret;
pub use token_vault::{SaveResult, TokenStore, TokenVault, TOKEN_FILE_NAME};
