//! `Secret`: a string that is wiped from memory when dropped and never shows up in `Debug`
//! output. Used for the site API token, the sign-in password and the R2 credentials.

use std::fmt;

use zeroize::Zeroizing;

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Takes ownership of `value`: its buffer is the one that gets wiped (no copy is made).
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    /// The secret text. Callers must not copy it into anything that outlives the request
    /// (logs, DTOs, error messages).
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self::new(value.to_string())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

impl<'de> serde::Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_value() {
        let secret = Secret::from("hunter2");

        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert!(!format!("{:?}", Some(secret.clone())).contains("hunter2"));
        assert_eq!(secret.expose(), "hunter2");
        assert_eq!(secret.len(), 7);
        assert!(!secret.is_empty());
    }

    #[test]
    fn deserializes_from_a_json_string_only() {
        let secret: Secret = serde_json::from_str("\"abc\"").unwrap();

        assert_eq!(secret.expose(), "abc");
        assert!(serde_json::from_str::<Secret>("1").is_err());
    }
}
