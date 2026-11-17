//! Frame quality measurements through ffprobe `movie=<file>,signalstats` (spec 4.4 step 4).
//! Port of steps/score.ts.

use std::time::Duration;

use super::env::StepEnv;
use crate::ffmpeg::args::{detail_probe_args, saturation_probe_args};
use crate::ffmpeg::errors::{succeeded, PipelineError, Tool};

pub const MEASURE_TIMEOUT: Duration = Duration::from_millis(60_000);

/// `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`.
fn is_numeric(text: &str) -> bool {
    let rest = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };

    if let Some(exp) = exponent {
        let digits = exp.strip_prefix(['+', '-']).unwrap_or(exp);

        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }

    let (int, frac) = match mantissa.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());

    match frac {
        None => !int.is_empty() && digits(int),
        Some(f) => digits(int) && digits(f) && (!int.is_empty() || !f.is_empty()),
    }
}

/// PHP `readMeasurementProcessOutput`: `None` unless the output is a single numeric value.
pub fn parse_score(raw: &str) -> Option<f64> {
    let text = raw.trim();

    if is_numeric(text) {
        text.parse().ok()
    } else {
        None
    }
}

async fn measure(
    env: &StepEnv,
    args: Vec<String>,
    what: &str,
) -> Result<Option<f64>, PipelineError> {
    let outcome = env.exec_collect(Tool::Ffprobe, args, MEASURE_TIMEOUT).await;

    match outcome {
        Ok(result) if succeeded(&result) => Ok(parse_score(result.stdout())),
        Ok(_) => {
            env.logger.warn(
                &format!("Could not measure {what}; treating it as unscored."),
                None,
            );

            Ok(None)
        }
        Err(error) => {
            if env.cancel.is_cancelled() {
                return Err(error);
            }

            env.logger.warn(
                &format!("Could not measure {what}; treating it as unscored."),
                Some(serde_json::json!({ "error": error.message })),
            );

            Ok(None)
        }
    }
}

fn unsafe_name(env: &StepEnv, error: crate::ffmpeg::args::UnsafeFileName) -> PipelineError {
    env.failed(&format!("Unsafe image file name: {}", error.0), None)
}

/// Average saturation (SATAVG) of an image inside `env.cwd`; `None` when it cannot be measured.
pub async fn measure_saturation(
    env: &StepEnv,
    image_file: &str,
) -> Result<Option<f64>, PipelineError> {
    let args = saturation_probe_args(image_file).map_err(|e| unsafe_name(env, e))?;

    measure(env, args, "saturation").await
}

/// Detail (edge-detect YAVG) of an image inside `env.cwd`; `None` when it cannot be measured.
pub async fn measure_detail(env: &StepEnv, image_file: &str) -> Result<Option<f64>, PipelineError> {
    let args = detail_probe_args(image_file).map_err(|e| unsafe_name(env, e))?;

    measure(env, args, "detail").await
}

#[cfg(test)]
mod tests {
    use super::super::env::test_env::*;
    use super::*;
    use crate::dto::JobState;
    use crate::ffmpeg::errors::is_cancelled;
    use crate::ffmpeg::runner::RunError;
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeRunner};

    #[test]
    fn parses_a_single_numeric_value_only() {
        for (raw, expected) in [
            ("12.5\n", Some(12.5)),
            ("  7 ", Some(7.0)),
            ("-3.25", Some(-3.25)),
            ("+4", Some(4.0)),
            (".5", Some(0.5)),
            ("5.", Some(5.0)),
            ("1e3", Some(1000.0)),
            ("1.5E-2", Some(0.015)),
            ("", None),
            ("abc", None),
            ("1 2", None),
            ("12.5\n13.5", None),
            ("1e", None),
            (".", None),
            ("NaN", None),
            ("inf", None),
            ("0x10", None),
            ("1,5", None),
        ] {
            assert_eq!(parse_score(raw), expected, "{raw:?}");
        }
    }

    #[tokio::test]
    async fn measures_saturation_and_detail_with_ffprobe() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("42.5\n"))),
            JobState::Thumbnail,
        );

        assert_eq!(
            measure_saturation(&t.env, "a.jpg").await.unwrap(),
            Some(42.5)
        );
        assert_eq!(measure_detail(&t.env, "a.jpg").await.unwrap(), Some(42.5));

        let calls = t.runner.calls.lock().unwrap();

        assert!(calls[0].args.iter().any(|a| a == "movie=a.jpg,signalstats"));
        assert!(calls[1]
            .args
            .iter()
            .any(|a| a == "movie=a.jpg,edgedetect,signalstats"));
    }

    #[tokio::test]
    async fn a_failed_or_garbled_measurement_is_unscored() {
        let t = fixture(FakeRunner::new(|_| Ok(exit_result(1))), JobState::Thumbnail);

        assert_eq!(measure_detail(&t.env, "a.jpg").await.unwrap(), None);
        assert!(t.logger.text().contains("Could not measure detail"));

        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("a\nb"))),
            JobState::Thumbnail,
        );

        assert_eq!(measure_saturation(&t.env, "a.jpg").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_spawn_failure_is_unscored() {
        let t = fixture(
            FakeRunner::new(|_| Err(RunError("x".into()))),
            JobState::Thumbnail,
        );

        assert_eq!(measure_saturation(&t.env, "a.jpg").await.unwrap(), None);
        assert!(t.logger.text().contains("Could not measure saturation"));
    }

    #[tokio::test]
    async fn cancellation_is_propagated() {
        let t = fixture(FakeRunner::new(|_| Ok(ok_result("1"))), JobState::Thumbnail);

        t.env.cancel.cancel();

        assert!(is_cancelled(
            &measure_detail(&t.env, "a.jpg").await.unwrap_err()
        ));
    }

    #[tokio::test]
    async fn an_unsafe_file_name_is_a_failure_not_a_score() {
        let t = fixture(FakeRunner::new(|_| Ok(ok_result("1"))), JobState::Thumbnail);

        assert!(measure_detail(&t.env, "a,b.jpg").await.is_err());
        assert_eq!(t.runner.call_count(), 0);
    }
}
