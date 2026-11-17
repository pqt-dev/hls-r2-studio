//! Slug generation equivalent to Laravel's
//! `Str::slug(pathinfo($filename, PATHINFO_FILENAME)) ?: 'video'`. Port of slug.ts.
//!
//! Laravel's `Str::slug` first calls `Str::ascii()` (voku/portable-ascii, language 'en'), so
//! `ascii_table.rs` is the table extracted from that very function by
//! `desktop-app/scripts/gen-ascii-table.php` (Latin, Vietnamese, Greek, Cyrillic, punctuation,
//! currency, ligatures). It gives exact parity with PHP for those blocks (checked by the golden
//! test) and adds no dependency.
//!
//! Known limitation (same as the TS): scripts PHP transliterates with its huge tables but that
//! are NOT in the generated table (CJK, Arabic, Hebrew, Thai, Devanagari, ...) are dropped, so
//! such names may give a shorter slug (or the `video` fallback) than PHP would. The result is
//! still always `[a-z0-9-]+`, never starts or ends with `-`, and is accepted by the server.

use super::ascii_table;

pub const SLUG_FALLBACK: &str = "video";

/// PHP `pathinfo($name, PATHINFO_FILENAME)`: basename without the part after the last dot.
pub fn base_name_without_extension(filename: &str) -> String {
    // PHP basename(): ignores trailing '/' and keeps only the last path component.
    let trimmed = filename.trim_end_matches('/');
    let base = &trimmed[trimmed.rfind('/').map_or(0, |i| i + 1)..];

    // No dot: whole name. ".hidden" has its only dot at index 0 -> PHP returns '' as the filename.
    match base.rfind('.') {
        Some(dot) => base[..dot].to_string(),
        None => base.to_string(),
    }
}

/// Equivalent of `Str::ascii($value, 'en')` for the supported blocks.
fn to_ascii(input: &str) -> String {
    let mut out = String::with_capacity(input.len());

    for ch in input.chars() {
        let cp = ch as u32;

        if cp < 0x80 {
            // portable-ascii keeps printable ASCII plus tab/CR/LF and drops other control chars.
            if (0x20..=0x7e).contains(&cp) || cp == 0x09 || cp == 0x0a || cp == 0x0d {
                out.push(ch);
            }
        } else if let Some(mapped) = ascii_table::lookup(cp) {
            out.push_str(mapped);
        }
    }

    out
}

/// JS `\s` restricted to ASCII (the input is ASCII after `to_ascii`).
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

/// Equivalent of `Str::slug($title)`; may return an empty string (see [`slugify`]).
pub fn laravel_slug(title: &str) -> String {
    // `_+` -> '-', '@' -> '-at-', lowercase.
    let mut text = String::new();
    let mut previous_underscore = false;

    for c in to_ascii(title).chars() {
        if c == '_' {
            if !previous_underscore {
                text.push('-');
            }
            previous_underscore = true;

            continue;
        }

        previous_underscore = false;

        if c == '@' {
            text.push_str("-at-");
        } else {
            text.push(c.to_ascii_lowercase());
        }
    }

    // Drop everything but [-a-z0-9\s], collapse runs of [-\s] to one '-', trim '-'.
    let mut slug = String::new();
    let mut in_separator = false;

    for c in text.chars() {
        if c == '-' || is_space(c) {
            in_separator = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            // A removed character does not break a separator run (the TS removes it first).
            if in_separator && !slug.is_empty() {
                slug.push('-');
            }
            in_separator = false;
            slug.push(c);
        }
    }

    slug
}

/// Slug for a file name WITHOUT extension; falls back to `video` when nothing is left.
pub fn slugify(filename_without_extension: &str) -> String {
    let slug = laravel_slug(filename_without_extension);

    if slug.is_empty() {
        SLUG_FALLBACK.to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Sample {
        input: String,
        expected: String,
    }

    fn golden() -> Vec<Sample> {
        serde_json::from_str(include_str!("../../tests/fixtures/slug-golden.json"))
            .expect("slug-golden.json")
    }

    #[test]
    fn golden_has_enough_samples() {
        assert!(golden().len() >= 40);
    }

    #[test]
    fn every_golden_sample_matches_php() {
        for (i, sample) in golden().iter().enumerate() {
            assert_eq!(
                laravel_slug(&sample.input),
                sample.expected,
                "sample #{i}: {:?}",
                sample.input
            );

            let expected = if sample.expected.is_empty() {
                "video"
            } else {
                &sample.expected
            };

            assert_eq!(slugify(&sample.input), expected, "sample #{i}");
        }
    }

    #[test]
    fn falls_back_to_video() {
        for input in ["", "!!!", "🔥🔥🔥", "---", "   "] {
            assert_eq!(slugify(input), "video", "{input:?}");
        }
    }

    fn is_safe_slug(slug: &str) -> bool {
        !slug.is_empty()
            && !slug.starts_with('-')
            && !slug.ends_with('-')
            && !slug.contains("--")
            && slug
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    }

    #[test]
    fn keeps_the_output_safe_for_non_latin_scripts() {
        for input in [
            "日本語のファイル名",
            "中文视频 2024",
            "Видео с Кириллицей",
            "فيديو عربي",
            "ไทย วิดีโอ",
            "ελληνικό αρχείο",
            "日本語 abc 한국어",
        ] {
            assert!(is_safe_slug(&slugify(input)), "{input:?}");
        }
    }

    #[test]
    fn drops_untransliterated_scripts_and_keeps_the_latin_parts() {
        assert_eq!(slugify("日本語 abc 한국어"), "abc");
        assert_eq!(slugify("日本語"), "video");
    }

    #[test]
    fn base_name_follows_php_pathinfo() {
        for (input, expected) in [
            ("video.mp4", "video"),
            ("a.b.mp4", "a.b"),
            (".hidden", ""),
            (".hidden.mp4", ".hidden"),
            ("noext", "noext"),
            ("trailing.", "trailing"),
            ("..", "."),
            ("archive.tar.gz", "archive.tar"),
            ("dir/sub/clip.mov", "clip"),
            ("dir/sub/", "sub"),
            ("Phim Việt.MP4", "Phim Việt"),
            ("", ""),
        ] {
            assert_eq!(base_name_without_extension(input), expected, "{input:?}");
        }
    }

    #[test]
    fn the_ascii_table_is_sorted_and_complete() {
        let table = ascii_table::ASCII_TABLE;

        assert_eq!(table.len(), 676);
        assert!(table.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(table
            .iter()
            .all(|(cp, text)| *cp >= 0x80 && text.is_ascii()));
        assert_eq!(ascii_table::lookup(0x00c6), Some("AE"));
        assert_eq!(ascii_table::lookup(0x0111), Some("d"));
        assert_eq!(ascii_table::lookup(0x201c), Some("\""));
        assert_eq!(ascii_table::lookup(0xfb03), Some("ffi"));
        assert_eq!(ascii_table::lookup(0x65e5), None);
    }

    #[test]
    fn transliterates_underscores_and_at_signs() {
        assert_eq!(laravel_slug("a__b"), "a-b");
        assert_eq!(laravel_slug("me@site"), "me-at-site");
        assert_eq!(laravel_slug("  Hello,  World!  "), "hello-world");
    }
}
