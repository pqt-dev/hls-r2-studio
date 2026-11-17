//! Pure planning helpers for the R2 upload step (port of upload/plan.ts; no I/O, sleeping is
//! injected).

use std::cmp::Ordering;
use std::future::Future;

use crate::pipeline::file_names::{PLAYLIST_FILE, THUMBNAIL_FILE};

pub const UPLOAD_CONCURRENCY: usize = 5;
pub const UPLOAD_MAX_ATTEMPTS: usize = 3;
/// Wait before attempt 2 and attempt 3.
pub const UPLOAD_RETRY_DELAYS_MS: [u64; 2] = [1000, 2000];

/// `^segment_\d{3,}\.ts$`.
fn is_segment_name(name: &str) -> bool {
    name.strip_prefix("segment_")
        .and_then(|rest| rest.strip_suffix(".ts"))
        .is_some_and(|digits| digits.len() >= 3 && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `^storyboard_(?:3x3|4x4|5x5)\.jpg$`.
fn is_storyboard_name(name: &str) -> bool {
    matches!(
        name,
        "storyboard_3x3.jpg" | "storyboard_4x4.jpg" | "storyboard_5x5.jpg"
    )
}

fn is_upload_name(name: &str) -> bool {
    name == PLAYLIST_FILE
        || name == THUMBNAIL_FILE
        || is_segment_name(name)
        || is_storyboard_name(name)
}

/// Natural order (`localeCompare(b, 'en', { numeric: true })` for the upload names): runs of
/// digits compare by value, everything else by character. Ties fall back to plain order.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a, b);

    loop {
        match (left.chars().next(), right.chars().next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let lx = left
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(left.len());
                let ly = right
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(right.len());
                let nx = left[..lx].trim_start_matches('0');
                let ny = right[..ly].trim_start_matches('0');
                let order = nx.len().cmp(&ny.len()).then_with(|| nx.cmp(ny));

                if order != Ordering::Equal {
                    return order;
                }

                left = &left[lx..];
                right = &right[ly..];
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }

                left = &left[x.len_utf8()..];
                right = &right[y.len_utf8()..];
            }
        }
    }
}

/// Selects the output files from the (top-level) names of a job directory: `segment_NNN.ts`,
/// `thumbnail.jpg`, `storyboard_NxN.jpg` and `playlist.m3u8`. Anything else (candidate_*,
/// tile_*, thumb_candidate_*, ffmpeg temp files, sub-directories) is ignored. Order: segments
/// (natural order), thumbnail, storyboards, and `playlist.m3u8` always LAST.
pub fn list_upload_files(names: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();

    for name in names {
        if is_upload_name(name) && !unique.contains(name) {
            unique.push(name.clone());
        }
    }

    let has_playlist = unique.iter().any(|n| n == PLAYLIST_FILE);
    let mut rest: Vec<String> = unique.into_iter().filter(|n| n != PLAYLIST_FILE).collect();

    rest.sort_by(|a, b| compare_names(a, b));

    if has_playlist {
        rest.push(PLAYLIST_FILE.to_string());
    }

    rest
}

pub fn content_type_for(name: &str) -> Result<&'static str, String> {
    if name.ends_with(".m3u8") {
        Ok("application/vnd.apple.mpegurl")
    } else if name.ends_with(".ts") {
        Ok("video/mp2t")
    } else if name.ends_with(".jpg") {
        Ok("image/jpeg")
    } else {
        Err(format!("No content type for file: {name}"))
    }
}

/// `prefix + name`; the layout is flat, so a name must not contain a path separator.
pub fn object_key(prefix: &str, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(format!(
            "Invalid object name: {}",
            serde_json::Value::String(name.to_string())
        ));
    }

    Ok(format!("{prefix}{name}"))
}

/// Upload stage fraction: files done / total files (1 when there is nothing to upload).
pub fn progress_from_uploaded(done: i64, total: i64) -> f64 {
    if total <= 0 {
        return 1.0;
    }

    (done as f64 / total as f64).clamp(0.0, 1.0)
}

/// Runs `run(attempt)` (attempt is 1-based), retrying on errors with the given delays (total
/// attempts = `delays_ms.len() + 1`). `should_retry` returning false stops at once (rethrowing
/// the error); it is NOT asked after the last attempt. `on_retry` is called before each wait.
pub async fn with_retry<T, E, Run, RunFut, Sleep, SleepFut>(
    mut run: Run,
    delays_ms: &[u64],
    mut sleep: Sleep,
    mut should_retry: impl FnMut(&E, usize) -> bool,
    mut on_retry: impl FnMut(&E, usize, u64),
) -> Result<T, E>
where
    Run: FnMut(usize) -> RunFut,
    RunFut: Future<Output = Result<T, E>>,
    Sleep: FnMut(u64) -> SleepFut,
    SleepFut: Future<Output = ()>,
{
    let max_attempts = delays_ms.len() + 1;
    let mut attempt = 1;

    loop {
        match run(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let delay = match delays_ms.get(attempt - 1) {
                    Some(delay) if attempt < max_attempts => *delay,
                    _ => return Err(error),
                };

                if !should_retry(&error, attempt) {
                    return Err(error);
                }

                on_retry(&error, attempt, delay);
                sleep(delay).await;
            }
        }

        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn selects_only_the_output_files_and_puts_the_playlist_last() {
        let input = names(&[
            "playlist.m3u8",
            "segment_010.ts",
            "segment_002.ts",
            "segment_000.ts",
            "thumbnail.jpg",
            "storyboard_5x5.jpg",
            "storyboard_3x3.jpg",
            "storyboard_4x4.jpg",
            "candidate_0001.jpg",
            "tile_3x3_0000.jpg",
            "thumb_candidate_0.jpg",
            "ffmpeg_progress.txt",
            "segment_000.ts.tmp",
            "playlist.m3u8.tmp",
            "notes.json",
            "storyboard_2x2.jpg",
            "segment_1.ts",
            "Playlist.m3u8",
            "sub/segment_001.ts",
        ]);

        assert_eq!(
            list_upload_files(&input),
            names(&[
                "segment_000.ts",
                "segment_002.ts",
                "segment_010.ts",
                "storyboard_3x3.jpg",
                "storyboard_4x4.jpg",
                "storyboard_5x5.jpg",
                "thumbnail.jpg",
                "playlist.m3u8",
            ])
        );
    }

    #[test]
    fn orders_segments_numerically_including_more_than_999() {
        assert_eq!(
            list_upload_files(&names(&[
                "segment_1000.ts",
                "segment_999.ts",
                "segment_100.ts"
            ])),
            names(&["segment_100.ts", "segment_999.ts", "segment_1000.ts"])
        );
    }

    #[test]
    fn handles_duplicates_and_a_missing_playlist() {
        assert_eq!(
            list_upload_files(&names(&["segment_000.ts", "segment_000.ts"])),
            names(&["segment_000.ts"])
        );
        assert!(list_upload_files(&[]).is_empty());
    }

    #[test]
    fn content_types() {
        for (name, kind) in [
            ("playlist.m3u8", "application/vnd.apple.mpegurl"),
            ("segment_000.ts", "video/mp2t"),
            ("thumbnail.jpg", "image/jpeg"),
            ("storyboard_3x3.jpg", "image/jpeg"),
        ] {
            assert_eq!(content_type_for(name), Ok(kind), "{name}");
        }

        assert_eq!(
            content_type_for("a.png"),
            Err("No content type for file: a.png".to_string())
        );
    }

    #[test]
    fn joins_prefix_and_name_flat_only() {
        assert_eq!(
            object_key("2026/01/02/x-ab12cd34ef56/", "playlist.m3u8").unwrap(),
            "2026/01/02/x-ab12cd34ef56/playlist.m3u8"
        );
        assert_eq!(
            object_key("p/", "a/b.ts"),
            Err("Invalid object name: \"a/b.ts\"".to_string())
        );
        assert!(object_key("p/", "..\\b.ts").is_err());
        assert!(object_key("p/", "").is_err());
    }

    #[test]
    fn progress_from_uploaded_table() {
        for (done, total, expected) in [
            (0, 10, 0.0),
            (5, 10, 0.5),
            (10, 10, 1.0),
            (12, 10, 1.0),
            (-1, 10, 0.0),
            (0, 0, 1.0),
        ] {
            assert_eq!(
                progress_from_uploaded(done, total),
                expected,
                "{done}/{total}"
            );
        }
    }

    #[test]
    fn retry_constants_allow_3_attempts_with_1_s_and_2_s_waits() {
        assert_eq!(UPLOAD_MAX_ATTEMPTS, 3);
        assert_eq!(UPLOAD_RETRY_DELAYS_MS, [1000, 2000]);
        assert_eq!(UPLOAD_CONCURRENCY, 5);
    }

    async fn retry<T>(
        run: impl FnMut(usize) -> Result<T, String>,
        delays: &[u64],
        should_retry: impl FnMut(&String, usize) -> bool,
    ) -> (Result<T, String>, Vec<u64>, Vec<(usize, u64)>) {
        let sleeps = RefCell::new(Vec::new());
        let events = RefCell::new(Vec::new());
        let run = RefCell::new(run);
        let result = with_retry(
            |attempt| {
                let outcome = (run.borrow_mut())(attempt);

                async move { outcome }
            },
            delays,
            |ms| {
                sleeps.borrow_mut().push(ms);

                async {}
            },
            should_retry,
            |_e, attempt, delay| events.borrow_mut().push((attempt, delay)),
        )
        .await;

        (result, sleeps.into_inner(), events.into_inner())
    }

    #[tokio::test]
    async fn returns_immediately_on_success_without_sleeping() {
        let (result, sleeps, _) = retry(|_| Ok("ok"), &[1000, 2000], |_, _| true).await;

        assert_eq!(result, Ok("ok"));
        assert!(sleeps.is_empty());
    }

    #[tokio::test]
    async fn retries_with_the_given_delays_and_passes_the_attempt_number() {
        let mut attempts = Vec::new();
        let (result, sleeps, _) = retry(
            |attempt| {
                attempts.push(attempt);

                if attempt < 3 {
                    Err("boom".to_string())
                } else {
                    Ok("done")
                }
            },
            &[1000, 2000],
            |_, _| true,
        )
        .await;

        assert_eq!(result, Ok("done"));
        assert_eq!(attempts, vec![1, 2, 3]);
        assert_eq!(sleeps, vec![1000, 2000]);
    }

    #[tokio::test]
    async fn rethrows_the_last_error_after_the_final_attempt() {
        let mut calls = 0;
        let (result, sleeps, _) = retry::<()>(
            |_| {
                calls += 1;
                Err(format!("fail {calls}"))
            },
            &[1, 2],
            |_, _| true,
        )
        .await;

        assert_eq!(result, Err("fail 3".to_string()));
        assert_eq!(calls, 3);
        assert_eq!(sleeps.len(), 2);
    }

    #[tokio::test]
    async fn stops_at_once_when_should_retry_says_no() {
        let mut calls = 0;
        let (result, sleeps, _) = retry::<()>(
            |_| {
                calls += 1;
                Err("fatal".to_string())
            },
            &[1, 2],
            |_, _| false,
        )
        .await;

        assert_eq!(result, Err("fatal".to_string()));
        assert_eq!(calls, 1);
        assert!(sleeps.is_empty());
    }

    #[tokio::test]
    async fn reports_each_retry_through_on_retry() {
        let (_, _, events) = retry(
            |attempt| {
                if attempt < 2 {
                    Err("x".to_string())
                } else {
                    Ok(())
                }
            },
            &[5],
            |_, _| true,
        )
        .await;

        assert_eq!(events, vec![(1, 5)]);
    }

    #[tokio::test]
    async fn with_no_delays_runs_exactly_once() {
        let mut calls = 0;
        let (result, _, _) = retry::<()>(
            |_| {
                calls += 1;
                Err("x".to_string())
            },
            &[],
            |_, _| true,
        )
        .await;

        assert_eq!(result, Err("x".to_string()));
        assert_eq!(calls, 1);
    }

    #[test]
    fn natural_compare() {
        assert_eq!(
            compare_names("segment_010.ts", "segment_9.ts"),
            Ordering::Greater
        );
        assert_eq!(
            compare_names("segment_000.ts", "storyboard_3x3.jpg"),
            Ordering::Less
        );
        assert_eq!(
            compare_names("storyboard_5x5.jpg", "thumbnail.jpg"),
            Ordering::Less
        );
        assert_eq!(compare_names("a", "a"), Ordering::Equal);
    }
}
