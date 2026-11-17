//! HLS transcode (spec 4.4 step 3): ffmpeg with `-progress pipe:1`, fractions reported live.
//! Port of steps/transcode.ts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::env::{ExecOptions, StepEnv};
use super::probe::FIRST_SEGMENT_FILE;
use crate::api::AppConfigTranscode;
use crate::ffmpeg::args::{transcode_args, transcode_timeout_seconds, TranscodeArgsInput};
use crate::ffmpeg::errors::{exit_code_text, succeeded, PipelineError, Tool};
use crate::ffmpeg::progress::{to_fraction, ProgressParser, ProgressUpdate};
use crate::pipeline::file_names::PLAYLIST_FILE;

/// Called with a fraction in [0, 1], never decreasing; only when the duration is known.
pub type OnFraction = Arc<dyn Fn(f64) + Send + Sync>;

pub struct TranscodeInput {
    /// Absolute source path (the only absolute path handed to ffmpeg).
    pub input: String,
    pub transcode: AppConfigTranscode,
    pub duration: Option<f64>,
    /// `transcode.fps` when set, otherwise the probed source fps.
    pub output_fps: f64,
    pub threads: Option<i64>,
    pub on_fraction: OnFraction,
}

struct Progress {
    parser: ProgressParser,
    fraction: f64,
}

fn handle(
    state: &Mutex<Progress>,
    update: ProgressUpdate,
    duration: Option<f64>,
    on_fraction: &OnFraction,
) {
    let Some(out_time) = update.out_time_seconds else {
        return;
    };
    let mut state = state.lock().expect("progress lock");
    let Some(next) = to_fraction(out_time, duration, state.fraction) else {
        return;
    };

    if next == state.fraction {
        return;
    }

    state.fraction = next;
    on_fraction(next);
}

pub async fn transcode_to_hls(env: &StepEnv, options: TranscodeInput) -> Result<(), PipelineError> {
    let args = transcode_args(&TranscodeArgsInput {
        input: options.input.clone(),
        resolution: options.transcode.resolution.as_str().to_string(),
        segment_seconds: options.transcode.segment_seconds,
        fps: options.transcode.fps,
        output_fps: options.output_fps,
        threads: options.threads,
    });
    let state = Arc::new(Mutex::new(Progress {
        parser: ProgressParser::new(),
        fraction: 0.0,
    }));
    let (duration, on_fraction) = (options.duration, options.on_fraction.clone());
    let on_stdout = {
        let (state, on_fraction) = (Arc::clone(&state), on_fraction.clone());

        Box::new(move |chunk: &str| {
            let update = state.lock().expect("progress lock").parser.feed(chunk);

            handle(&state, update, duration, &on_fraction);
        })
    };

    let result = env
        .exec(
            Tool::Ffmpeg,
            args,
            Duration::from_secs(transcode_timeout_seconds(options.duration)),
            ExecOptions {
                on_stdout: Some(on_stdout),
                collect_stdout: false,
            },
        )
        .await?;
    let flushed = state.lock().expect("progress lock").parser.flush();

    handle(&state, flushed, duration, &on_fraction);

    if result.timed_out {
        return Err(env.failed(
            "Converting the video took too long and was stopped.",
            Some(&result),
        ));
    }

    if !succeeded(&result) {
        return Err(env.failed(
            &format!(
                "ffmpeg failed to convert the video (exit code {}).",
                exit_code_text(&result)
            ),
            Some(&result),
        ));
    }

    for name in [PLAYLIST_FILE, FIRST_SEGMENT_FILE] {
        if !env.fs.is_file(&env.cwd.join(name)).await {
            return Err(env.failed(
                "ffmpeg finished without producing the HLS output.",
                Some(&result),
            ));
        }
    }

    on_fraction(1.0);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::env::test_env::*;
    use super::*;
    use crate::api::Resolution;
    use crate::dto::JobState;
    use crate::ffmpeg::errors::{is_cancelled, PipelineErrorKind};
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeFs, FakeRunner};

    fn input(duration: Option<f64>, fractions: Arc<Mutex<Vec<f64>>>) -> TranscodeInput {
        TranscodeInput {
            input: "/src/in.mp4".into(),
            transcode: AppConfigTranscode {
                resolution: Resolution::P720,
                segment_seconds: 6.0,
                fps: None,
            },
            duration,
            output_fps: 25.0,
            threads: None,
            on_fraction: Arc::new(move |f| fractions.lock().unwrap().push(f)),
        }
    }

    fn outputs(fs: &Arc<FakeFs>) {
        fs.put(path(PLAYLIST_FILE), b"#EXTM3U");
        fs.put(path(FIRST_SEGMENT_FILE), b"ts");
    }

    #[tokio::test]
    async fn reports_increasing_fractions_and_ends_at_1() {
        let t = fixture(
            FakeRunner::new(|run| {
                let on_stdout = run.on_stdout.as_mut().unwrap();

                on_stdout("out_time_us=2000000\nprogress=continue\n");
                on_stdout("out_time_us=1000000\nprogress=continue\nout_time_us=5000000\n");
                on_stdout("progress=end\n");

                Ok(ok_result(""))
            }),
            JobState::Transcoding,
        );

        outputs(&t.fs);

        let fractions = Arc::new(Mutex::new(Vec::new()));

        transcode_to_hls(&t.env, input(Some(10.0), fractions.clone()))
            .await
            .unwrap();

        assert_eq!(*fractions.lock().unwrap(), vec![0.2, 0.5, 1.0]);

        let call = &t.runner.calls.lock().unwrap()[0];

        assert_eq!(call.command, "ffmpeg");
        assert!(call.args.contains(&"/src/in.mp4".to_string()));
        assert!(call.args.contains(&"-progress".to_string()));
    }

    #[tokio::test]
    async fn without_a_duration_only_the_final_1_is_reported() {
        let t = fixture(
            FakeRunner::new(|run| {
                run.on_stdout.as_mut().unwrap()("out_time_us=2000000\nprogress=continue\n");

                Ok(ok_result(""))
            }),
            JobState::Transcoding,
        );

        outputs(&t.fs);

        let fractions = Arc::new(Mutex::new(Vec::new()));

        transcode_to_hls(&t.env, input(None, fractions.clone()))
            .await
            .unwrap();

        assert_eq!(*fractions.lock().unwrap(), vec![1.0]);
    }

    #[tokio::test]
    async fn the_timeout_scales_with_the_duration() {
        let t = fixture(
            FakeRunner::new(|run| {
                assert_eq!(run.timeout, Duration::from_secs(8 * 1000));

                Ok(ok_result(""))
            }),
            JobState::Transcoding,
        );

        outputs(&t.fs);
        transcode_to_hls(&t.env, input(Some(1000.0), Default::default()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_timeout_is_reported_as_too_long() {
        let t = fixture(
            FakeRunner::new(|_| {
                let mut r = exit_result(1);

                r.timed_out = true;

                Ok(r)
            }),
            JobState::Transcoding,
        );
        let error = transcode_to_hls(&t.env, input(Some(5.0), Default::default()))
            .await
            .unwrap_err();

        assert_eq!(
            error.message,
            "Converting the video took too long and was stopped."
        );
        assert_eq!(error.kind, PipelineErrorKind::Failed);
    }

    #[tokio::test]
    async fn a_failed_exit_carries_the_exit_code_and_stderr() {
        let t = fixture(
            FakeRunner::new(|_| Ok(exit_result(187))),
            JobState::Transcoding,
        );
        let error = transcode_to_hls(&t.env, input(Some(5.0), Default::default()))
            .await
            .unwrap_err();

        assert_eq!(
            error.message,
            "ffmpeg failed to convert the video (exit code 187)."
        );
        assert_eq!(error.exit_code, Some(187));
        assert_eq!(error.stderr_tail, vec!["boom".to_string()]);
        assert_eq!(error.step, JobState::Transcoding);
    }

    #[tokio::test]
    async fn a_signal_exit_says_unknown() {
        let t = fixture(
            FakeRunner::new(|_| Ok(Default::default())),
            JobState::Transcoding,
        );
        let error = transcode_to_hls(&t.env, input(Some(5.0), Default::default()))
            .await
            .unwrap_err();

        assert_eq!(
            error.message,
            "ffmpeg failed to convert the video (exit code unknown)."
        );
    }

    #[tokio::test]
    async fn missing_output_files_fail_the_step() {
        for missing in [PLAYLIST_FILE, FIRST_SEGMENT_FILE] {
            let t = fixture(
                FakeRunner::new(|_| Ok(ok_result(""))),
                JobState::Transcoding,
            );

            outputs(&t.fs);
            t.fs.files.lock().unwrap().remove(&path(missing));

            let fractions = Arc::new(Mutex::new(Vec::new()));
            let error = transcode_to_hls(&t.env, input(Some(5.0), fractions.clone()))
                .await
                .unwrap_err();

            assert_eq!(
                error.message,
                "ffmpeg finished without producing the HLS output."
            );
            assert!(!fractions.lock().unwrap().contains(&1.0));
        }
    }

    #[tokio::test]
    async fn cancellation_is_propagated() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result(""))),
            JobState::Transcoding,
        );

        t.env.cancel.cancel();

        assert!(is_cancelled(
            &transcode_to_hls(&t.env, input(Some(5.0), Default::default()))
                .await
                .unwrap_err()
        ));
    }
}
