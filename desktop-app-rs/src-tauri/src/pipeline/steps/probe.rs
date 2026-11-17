//! Probing: source duration/fps (spec 4.4 step 2) and output info of the first segment
//! (step 3). Port of steps/probe.ts.

use std::time::Duration;

use super::env::StepEnv;
use crate::ffmpeg::args::{
    probe_duration_args, probe_fps_args, probe_output_info_args, PROBE_TIMEOUT_SECONDS,
};
use crate::ffmpeg::errors::{failed, succeeded, PipelineError, Tool};
use crate::ffmpeg::probe_parse::{
    parse_duration_output, parse_frame_rate_output, parse_output_info, OutputInfo,
    ParseOutputInfoOptions, EMPTY_OUTPUT_INFO,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(PROBE_TIMEOUT_SECONDS);
pub const FIRST_SEGMENT_FILE: &str = "segment_000.ts";

/// Duration in seconds. ffprobe failing (exit != 0 or timeout) fails the job; an unusable value
/// (not numeric or <= 0) only logs a warning and yields `None`.
pub async fn probe_duration(env: &StepEnv, input: &str) -> Result<Option<f64>, PipelineError> {
    let result = env
        .exec_collect(Tool::Ffprobe, probe_duration_args(input), PROBE_TIMEOUT)
        .await?;

    if !succeeded(&result) {
        return Err(failed(
            env.step,
            "ffprobe could not read the video file.",
            Some(&result),
        ));
    }

    let duration = parse_duration_output(result.stdout());

    if duration.is_none() {
        env.logger.warn(
            "ffprobe returned an unusable duration; continuing without a duration.",
            None,
        );
    }

    Ok(duration)
}

/// Source frame rate (`num/den`); ffprobe failing fails the job, an unusable value yields 0.
pub async fn probe_fps(env: &StepEnv, input: &str) -> Result<f64, PipelineError> {
    let result = env
        .exec_collect(Tool::Ffprobe, probe_fps_args(input), PROBE_TIMEOUT)
        .await?;

    if !succeeded(&result) {
        return Err(failed(
            env.step,
            "ffprobe could not read the video frame rate.",
            Some(&result),
        ));
    }

    Ok(parse_frame_rate_output(result.stdout()))
}

/// width/height/fps/bitrate/codec of the first output segment. Any problem (no segment, ffprobe
/// failure) yields `EMPTY_OUTPUT_INFO` and never fails the job (only cancellation does).
pub async fn probe_output_info(
    env: &StepEnv,
    segment_seconds: f64,
) -> Result<OutputInfo, PipelineError> {
    let Some(segment_bytes) = env.fs.file_size(&env.cwd.join(FIRST_SEGMENT_FILE)).await else {
        env.logger.warn(
            "No HLS segment found to probe; output info is left empty.",
            None,
        );

        return Ok(EMPTY_OUTPUT_INFO);
    };

    let result = env
        .exec_collect(
            Tool::Ffprobe,
            probe_output_info_args(FIRST_SEGMENT_FILE),
            PROBE_TIMEOUT,
        )
        .await?;

    if !succeeded(&result) {
        env.logger.warn(
            "ffprobe could not read the output segment; output info is left empty.",
            None,
        );

        return Ok(EMPTY_OUTPUT_INFO);
    }

    Ok(parse_output_info(
        result.stdout(),
        &ParseOutputInfoOptions {
            segment_bytes,
            segment_seconds,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::super::env::test_env::*;
    use super::*;
    use crate::dto::JobState;
    use crate::ffmpeg::errors::{is_cancelled, PipelineErrorKind};
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeRunner};

    #[tokio::test]
    async fn reads_the_duration() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("61.234\n"))),
            JobState::Transcoding,
        );

        assert_eq!(
            probe_duration(&t.env, "/src/in.mp4").await.unwrap(),
            Some(61.234)
        );
        assert_eq!(t.runner.calls.lock().unwrap()[0].command, "ffprobe");
        assert!(t.runner.calls.lock().unwrap()[0]
            .args
            .contains(&"/src/in.mp4".to_string()));
    }

    #[tokio::test]
    async fn an_unusable_duration_only_warns() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("N/A\n"))),
            JobState::Transcoding,
        );

        assert_eq!(probe_duration(&t.env, "in.mp4").await.unwrap(), None);
        assert!(t.logger.text().contains("unusable duration"));
    }

    #[tokio::test]
    async fn ffprobe_failure_or_timeout_fails_the_job() {
        let t = fixture(
            FakeRunner::new(|_| Ok(exit_result(1))),
            JobState::Transcoding,
        );
        let error = probe_duration(&t.env, "in.mp4").await.unwrap_err();

        assert_eq!(error.kind, PipelineErrorKind::Failed);
        assert_eq!(error.message, "ffprobe could not read the video file.");
        assert_eq!(error.exit_code, Some(1));
        assert_eq!(error.stderr_tail, vec!["boom".to_string()]);

        let mut timed_out = ok_result("1");

        timed_out.timed_out = true;

        let t = fixture(
            FakeRunner::new(move |_| Ok(timed_out.clone())),
            JobState::Transcoding,
        );

        assert!(probe_duration(&t.env, "in.mp4").await.is_err());
        assert_eq!(
            probe_fps(&t.env, "in.mp4").await.unwrap_err().message,
            "ffprobe could not read the video frame rate."
        );
    }

    #[tokio::test]
    async fn reads_the_frame_rate_and_yields_0_for_garbage() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("30000/1001\n"))),
            JobState::Transcoding,
        );

        assert!((probe_fps(&t.env, "in.mp4").await.unwrap() - 29.97).abs() < 0.01);

        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("0/0\n"))),
            JobState::Transcoding,
        );

        assert_eq!(probe_fps(&t.env, "in.mp4").await.unwrap(), 0.0);
    }

    #[tokio::test]
    async fn output_info_is_empty_without_a_segment() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result(""))),
            JobState::Transcoding,
        );

        assert_eq!(
            probe_output_info(&t.env, 6.0).await.unwrap(),
            EMPTY_OUTPUT_INFO
        );
        assert_eq!(t.runner.call_count(), 0);
        assert!(t.logger.text().contains("No HLS segment"));
    }

    #[tokio::test]
    async fn output_info_is_empty_when_ffprobe_fails() {
        let t = fixture(
            FakeRunner::new(|_| Ok(exit_result(1))),
            JobState::Transcoding,
        );

        t.fs.put(path(FIRST_SEGMENT_FILE), &[0; 10]);

        assert_eq!(
            probe_output_info(&t.env, 6.0).await.unwrap(),
            EMPTY_OUTPUT_INFO
        );
        assert!(t
            .logger
            .text()
            .contains("could not read the output segment"));
    }

    #[tokio::test]
    async fn parses_the_output_info() {
        let json = r#"{"streams":[{"width":1280,"height":720,"r_frame_rate":"30/1","bit_rate":"2000000","codec_name":"h264"}]}"#;
        let t = fixture(
            FakeRunner::new(move |_| Ok(ok_result(json))),
            JobState::Transcoding,
        );

        t.fs.put(path(FIRST_SEGMENT_FILE), &[0; 10]);

        let info = probe_output_info(&t.env, 6.0).await.unwrap();

        assert_eq!((info.width, info.height), (Some(1280), Some(720)));
        assert_eq!(info.fps, Some(30.0));
        assert_eq!(info.bitrate_kbps, Some(2000));
        assert_eq!(info.codec.as_deref(), Some("h264"));
        assert_eq!(
            t.runner.calls.lock().unwrap()[0]
                .args
                .last()
                .map(String::as_str),
            Some(FIRST_SEGMENT_FILE)
        );
    }

    #[tokio::test]
    async fn cancellation_is_propagated() {
        let t = fixture(
            FakeRunner::new(|_| Ok(ok_result("1"))),
            JobState::Transcoding,
        );

        t.env.cancel.cancel();

        assert!(is_cancelled(
            &probe_duration(&t.env, "in.mp4").await.unwrap_err()
        ));
    }
}
