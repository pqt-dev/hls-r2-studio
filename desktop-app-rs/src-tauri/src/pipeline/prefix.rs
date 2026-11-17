//! Storage prefix `{YYYY}/{MM}/{DD}/{slug}-{publicId}/` (port of prefix.ts).

use chrono::{DateTime, Datelike, Utc};

use super::file_names::storyboard_file_name;
use super::public_id::is_valid_public_id;

/// Maximum length of the slug part of a prefix, always applied (server columns are varchar(255)).
pub const MAX_SLUG_LENGTH: usize = 100;
/// Server `disk_prefix` / `playlist_path` / `thumbnail_path` columns are varchar(255).
pub const MAX_KEY_LENGTH: usize = 255;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrefixError {
    InvalidSlug,
    TooLong,
}

impl std::fmt::Display for PrefixError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidSlug => "Slug must be a non-empty string of [a-z0-9-].",
            Self::TooLong => "The upload prefix is too long.",
        })
    }
}

impl std::error::Error for PrefixError {}

fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn format_prefix(now: DateTime<Utc>, slug: &str, public_id: &str) -> String {
    format!(
        "{:04}/{:02}/{:02}/{slug}-{public_id}/",
        now.year(),
        now.month(),
        now.day()
    )
}

fn trim_trailing_dashes(text: &str) -> &str {
    text.trim_end_matches('-')
}

/// Builds `{YYYY}/{MM}/{DD}/{slug}-{publicId}/` from UTC date fields. The slug is ALWAYS capped
/// at 100 characters, so the longest key (`prefix + storyboard_5x5.jpg`) stays within 255.
/// (The TS "invalid date" error cannot happen: `DateTime<Utc>` is always valid.)
pub fn build_prefix(
    now: DateTime<Utc>,
    slug: &str,
    public_id: &str,
) -> Result<String, PrefixError> {
    if !is_slug(slug) {
        return Err(PrefixError::InvalidSlug);
    }

    let longest = storyboard_file_name(5).len();
    // The slug is ASCII, so bytes are characters.
    let capped = match trim_trailing_dashes(&slug[..slug.len().min(MAX_SLUG_LENGTH)]) {
        "" => "video",
        other => other,
    };
    let mut prefix = format_prefix(now, capped, public_id);

    if prefix.len() + longest > MAX_KEY_LENGTH {
        // Defensive: only reachable with an abnormally long public id. Cut the slug further.
        let room =
            (MAX_KEY_LENGTH as i64) - (longest as i64) - ((prefix.len() - capped.len()) as i64);
        let keep = room.max(1) as usize;
        let shorter = match trim_trailing_dashes(&capped[..capped.len().min(keep)]) {
            "" => "v",
            other => other,
        };

        prefix = format_prefix(now, shorter, public_id);
    }

    if prefix.len() + longest > MAX_KEY_LENGTH {
        return Err(PrefixError::TooLong);
    }

    Ok(prefix)
}

fn all_digits(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit())
}

/// The exact regex the server applies to `disk_prefix` (spec 3.5), anchored and bound to
/// `public_id`: `^\d{4}/\d{2}/\d{2}/[a-z0-9-]+-<publicId>/$`.
pub fn is_valid_prefix(prefix: &str, public_id: &str) -> bool {
    if !is_valid_public_id(public_id) {
        return false;
    }

    let Some(rest) = prefix.strip_suffix(&format!("-{public_id}/")) else {
        return false;
    };
    let mut parts = rest.splitn(4, '/');
    let (Some(year), Some(month), Some(day), Some(slug)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };

    year.len() == 4
        && all_digits(year)
        && month.len() == 2
        && all_digits(month)
        && day.len() == 2
        && all_digits(day)
        && is_slug(slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::slug::slugify;
    use chrono::TimeZone;

    const ID: &str = "ab12cd34ef56";

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn jan_first() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    #[test]
    fn uses_utc_date_fields_and_a_flat_slug_id_folder() {
        assert_eq!(
            build_prefix(utc("2026-03-05T23:59:59Z"), "my-video", ID).unwrap(),
            "2026/03/05/my-video-ab12cd34ef56/"
        );
    }

    #[test]
    fn is_utc_even_when_the_local_date_differs() {
        // 23:30 at UTC-5 is already the next day in UTC.
        assert_eq!(
            build_prefix(utc("2026-12-31T23:30:00-05:00"), "x", ID).unwrap(),
            "2027/01/01/x-ab12cd34ef56/"
        );
    }

    #[test]
    fn pads_month_day_and_year() {
        assert_eq!(
            build_prefix(utc("0987-01-02T00:00:00Z"), "x", ID).unwrap(),
            "0987/01/02/x-ab12cd34ef56/"
        );
    }

    #[test]
    fn keeps_a_slug_of_exactly_100_characters() {
        let slug = "a".repeat(MAX_SLUG_LENGTH);

        assert_eq!(
            build_prefix(jan_first(), &slug, ID).unwrap(),
            format!("2026/01/01/{slug}-{ID}/")
        );
    }

    #[test]
    fn always_caps_the_slug_at_100_characters() {
        assert_eq!(
            build_prefix(jan_first(), &"a".repeat(101), ID).unwrap(),
            format!("2026/01/01/{}-{ID}/", "a".repeat(100))
        );
    }

    #[test]
    fn keeps_every_key_within_255_characters() {
        let long_at = slugify(&format!("{}abc", "@".repeat(200)));
        let unicode = slugify(&"Ünïcödé-Vidéo ".repeat(40));
        let cut_dash = format!("{}-{}", "a".repeat(99), "b".repeat(50));

        for (label, slug) in [
            ("a 240-character name", "x".repeat(240)),
            ("200 at signs", long_at),
            ("a long unicode name", unicode),
            ("a very long name", "b".repeat(5000)),
            ("100 chars ending in dash after cut", cut_dash),
        ] {
            let prefix = build_prefix(jan_first(), &slug, ID).unwrap();

            assert!(
                prefix.len() + "storyboard_5x5.jpg".len() <= MAX_KEY_LENGTH,
                "{label}"
            );
            assert!(is_valid_prefix(&prefix, ID), "{label}");
        }
    }

    #[test]
    fn re_trims_a_dash_exposed_by_the_truncation() {
        let slug = format!("{}-{}", "a".repeat(99), "b".repeat(800));
        let prefix = build_prefix(jan_first(), &slug, ID).unwrap();

        assert_eq!(prefix, format!("2026/01/01/{}-{ID}/", "a".repeat(99)));
        assert!(is_valid_prefix(&prefix, ID));
    }

    #[test]
    fn rejects_an_invalid_slug() {
        assert_eq!(
            build_prefix(jan_first(), "", ID),
            Err(PrefixError::InvalidSlug)
        );
        assert_eq!(
            build_prefix(jan_first(), "Bad Slug", ID),
            Err(PrefixError::InvalidSlug)
        );
    }

    #[test]
    fn cuts_the_slug_again_for_an_abnormally_long_public_id() {
        // Only reachable with a public id that is not 12 characters; the key must still fit.
        let long_id = "z".repeat(140);
        let prefix = build_prefix(jan_first(), &"a".repeat(100), &long_id).unwrap();

        assert!(prefix.len() + "storyboard_5x5.jpg".len() <= MAX_KEY_LENGTH);
        assert!(prefix.contains("/a-") || prefix.contains("/aa"));
    }

    #[test]
    fn accepts_a_prefix_produced_by_build_prefix() {
        let prefix = build_prefix(utc("2026-03-05T00:00:00Z"), "video", ID).unwrap();

        assert!(is_valid_prefix(&prefix, ID));
    }

    #[test]
    fn rejects_malformed_prefixes() {
        for (prefix, why) in [
            ("2026/03/05/video-ab12cd34ef56", "missing trailing slash"),
            ("2026/03/05/video-zzzzzzzzzzzz/", "different public id"),
            ("2026/3/05/video-ab12cd34ef56/", "short month"),
            ("2026/03/05/Video-ab12cd34ef56/", "uppercase slug"),
            ("2026/03/05/-ab12cd34ef56/", "empty slug"),
            ("2026/03/05/a/b-ab12cd34ef56/", "extra path segment"),
            ("x/2026/03/05/video-ab12cd34ef56/", "leading garbage"),
            ("2026/03/05/video-ab12cd34ef56/\n", "trailing newline"),
        ] {
            assert!(!is_valid_prefix(prefix, ID), "{why}");
        }
    }

    #[test]
    fn rejects_an_invalid_public_id() {
        assert!(!is_valid_prefix("2026/03/05/video-abc/", "abc"));
    }
}
