//! Public id generation and validation (port of publicId.ts).

pub const PUBLIC_ID_LENGTH: usize = 12;
pub const PUBLIC_ID_ALPHABET: &str = "abcdefghijklmnopqrstuvwxyz0123456789";

/// Returns a uniformly random integer in `[0, max_exclusive)`. Injectable for tests.
pub type RandomInt<'a> = &'a mut dyn FnMut(usize) -> usize;

/// The random index was outside the alphabet (`RangeError` in the TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutOfRange(pub usize);

impl std::fmt::Display for OutOfRange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "random_int returned an out-of-range index: {}", self.0)
    }
}

impl std::error::Error for OutOfRange {}

/// Generates a 12 character `[a-z0-9]` public id (the server enforces the same format) from the
/// given random source.
pub fn generate_public_id_with(random_int: RandomInt<'_>) -> Result<String, OutOfRange> {
    let alphabet = PUBLIC_ID_ALPHABET.as_bytes();
    let mut id = String::with_capacity(PUBLIC_ID_LENGTH);

    for _ in 0..PUBLIC_ID_LENGTH {
        let index = random_int(alphabet.len());
        let byte = alphabet.get(index).ok_or(OutOfRange(index))?;

        id.push(char::from(*byte));
    }

    Ok(id)
}

/// 12 uniformly random `[a-z0-9]` characters from the OS random source. Uniform: values that
/// would bias the modulo are rejected and redrawn (like Node's `randomInt`).
pub fn generate_public_id() -> String {
    let mut random = os_random_index;

    generate_public_id_with(&mut random).expect("os_random_index stays below the bound")
}

fn os_random_index(max_exclusive: usize) -> usize {
    use std::hash::{BuildHasher, Hasher, RandomState};

    // `RandomState` is seeded from the OS CSPRNG per instance; finishing a fresh hasher gives a
    // fresh 64-bit random value without an extra dependency.
    let max = max_exclusive as u64;
    let limit = u64::MAX - (u64::MAX % max);

    loop {
        let value = RandomState::new().build_hasher().finish();

        if value < limit {
            return (value % max) as usize;
        }
    }
}

/// `^[a-z0-9]{12}$`.
pub fn is_valid_public_id(value: &str) -> bool {
    value.len() == PUBLIC_ID_LENGTH
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_injected_random_values_onto_the_alphabet() {
        let values = [0, 1, 25, 26, 35, 0, 1, 2, 3, 4, 5, 6];
        let mut call = 0;
        let mut random = |max: usize| {
            assert_eq!(max, 36);
            let value = values.get(call).copied().unwrap_or(0);
            call += 1;
            value
        };

        assert_eq!(
            generate_public_id_with(&mut random).unwrap(),
            "abz09abcdefg"
        );
        assert_eq!(call, 12);
    }

    #[test]
    fn always_produces_a_valid_id_with_the_default_generator() {
        for _ in 0..50 {
            assert!(is_valid_public_id(&generate_public_id()));
        }
    }

    #[test]
    fn default_generator_is_not_constant() {
        assert_ne!(generate_public_id(), generate_public_id());
    }

    #[test]
    fn rejects_an_out_of_range_random_value() {
        let mut random = |_max: usize| PUBLIC_ID_ALPHABET.len();

        assert_eq!(
            generate_public_id_with(&mut random),
            Err(OutOfRange(PUBLIC_ID_ALPHABET.len()))
        );
    }

    #[test]
    fn accepts_valid_ids() {
        for value in ["abcdefghijkl", "0123456789ab", "ab12cd34ef56"] {
            assert!(is_valid_public_id(value), "{value}");
        }
    }

    #[test]
    fn rejects_invalid_ids() {
        for value in [
            "short",
            "abcdefghijklm",
            "ABCDEFGHIJKL",
            "abcdefghijk-",
            "abcdefghijkl\n",
            "",
            "abcdefghijkĐ",
        ] {
            assert!(!is_valid_public_id(value), "{value:?}");
        }
    }
}
