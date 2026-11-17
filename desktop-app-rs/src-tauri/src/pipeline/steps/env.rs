//! Shared context and helpers for the pipeline steps (port of steps/env.ts).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::dto::JobState;
use crate::ffmpeg::errors::{cancelled_error, failed, PipelineError, Tool};
use crate::ffmpeg::runner::{RunProcessInput, RunResult, StdoutCallback};
use crate::logger::Log;
use crate::pipeline::deps::{CommandRunner, StepFs};

#[derive(Clone)]
pub struct StepEnv {
    pub run: Arc<dyn CommandRunner>,
    pub fs: Arc<dyn StepFs>,
    pub ffmpeg: String,
    pub ffprobe: String,
    /// Job temp directory; every child process runs here and uses relative file names.
    pub cwd: PathBuf,
    pub cancel: CancellationToken,
    pub logger: Arc<dyn Log>,
    /// Job state reported in errors raised by the step.
    pub step: JobState,
}

#[derive(Default)]
pub struct ExecOptions {
    pub on_stdout: Option<StdoutCallback>,
    pub collect_stdout: bool,
}

impl StepEnv {
    pub fn throw_if_aborted(&self) -> Result<(), PipelineError> {
        if self.cancel.is_cancelled() {
            Err(cancelled_error(self.step))
        } else {
            Ok(())
        }
    }

    pub fn failed(&self, message: &str, result: Option<&RunResult>) -> PipelineError {
        failed(self.step, message, result)
    }

    /// Runs a tool in the job directory. Fails with a `cancelled` error when the job was
    /// aborted; otherwise returns the result (the caller decides what a non-zero exit or a
    /// timeout means). A process that cannot be started is a `failed` error with a path-free
    /// message (the TS lets the raw spawn error escape).
    pub async fn exec(
        &self,
        tool: Tool,
        args: Vec<String>,
        timeout: Duration,
        options: ExecOptions,
    ) -> Result<RunResult, PipelineError> {
        self.throw_if_aborted()?;

        let mut input = RunProcessInput::new(
            if tool == Tool::Ffmpeg {
                &self.ffmpeg
            } else {
                &self.ffprobe
            },
            args,
            timeout,
        );

        input.cwd = Some(self.cwd.clone());
        input.cancel = Some(self.cancel.clone());
        input.on_stdout = options.on_stdout;
        input.collect_stdout = options.collect_stdout;

        let result = self
            .run
            .run(input)
            .await
            .map_err(|_| self.failed(&format!("Could not start {}.", tool.name()), None))?;

        if result.aborted || self.cancel.is_cancelled() {
            return Err(cancelled_error(self.step));
        }

        Ok(result)
    }

    /// `exec` with stdout collected (ffprobe style).
    pub async fn exec_collect(
        &self,
        tool: Tool,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<RunResult, PipelineError> {
        self.exec(
            tool,
            args,
            timeout,
            ExecOptions {
                on_stdout: None,
                collect_stdout: true,
            },
        )
        .await
    }
}

#[cfg(test)]
pub mod test_env {
    use super::*;
    use crate::logger::testing::RecordingLogger;
    use crate::pipeline::deps::fakes::{FakeFs, FakeRunner};

    pub const CWD: &str = "/job";

    pub struct Fixture {
        pub env: StepEnv,
        pub fs: Arc<FakeFs>,
        pub runner: Arc<FakeRunner>,
        pub logger: Arc<RecordingLogger>,
    }

    pub fn fixture(runner: Arc<FakeRunner>, step: JobState) -> Fixture {
        let fs = Arc::new(FakeFs::default());
        let logger = Arc::new(RecordingLogger::default());
        let env = StepEnv {
            run: runner.clone(),
            fs: fs.clone(),
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            cwd: PathBuf::from(CWD),
            cancel: CancellationToken::new(),
            logger: logger.clone(),
            step,
        };

        Fixture {
            env,
            fs,
            runner,
            logger,
        }
    }

    pub fn path(name: &str) -> PathBuf {
        PathBuf::from(CWD).join(name)
    }
}

#[cfg(test)]
mod tests {
    use super::test_env::*;
    use super::*;
    use crate::ffmpeg::errors::{is_cancelled, PipelineErrorKind};
    use crate::ffmpeg::runner::RunError;
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeRunner};

    #[tokio::test]
    async fn runs_in_the_job_directory_with_the_right_tool() {
        let runner = FakeRunner::new(|input| {
            assert_eq!(input.cwd, Some(path("")));
            Ok(ok_result("x"))
        });
        let t = fixture(runner, JobState::Transcoding);

        let result = t
            .env
            .exec_collect(Tool::Ffprobe, vec!["a".into()], Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(result.stdout(), "x");
        assert_eq!(t.runner.calls.lock().unwrap()[0].command, "ffprobe");
    }

    #[tokio::test]
    async fn a_cancelled_job_does_not_start_a_process() {
        let t = fixture(FakeRunner::new(|_| Ok(ok_result(""))), JobState::Thumbnail);

        t.env.cancel.cancel();

        let error = t
            .env
            .exec(
                Tool::Ffmpeg,
                vec![],
                Duration::from_secs(1),
                ExecOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(is_cancelled(&error));
        assert_eq!(error.step, JobState::Thumbnail);
        assert_eq!(t.runner.call_count(), 0);
    }

    #[tokio::test]
    async fn an_aborted_run_is_cancelled() {
        let t = fixture(
            FakeRunner::new(|_| {
                Ok(RunResult {
                    aborted: true,
                    ..RunResult::default()
                })
            }),
            JobState::Storyboard,
        );

        let error = t
            .env
            .exec(
                Tool::Ffmpeg,
                vec![],
                Duration::from_secs(1),
                ExecOptions::default(),
            )
            .await
            .unwrap_err();

        assert!(is_cancelled(&error));
    }

    #[tokio::test]
    async fn a_failed_exit_is_returned_not_raised() {
        let t = fixture(
            FakeRunner::new(|_| Ok(exit_result(3))),
            JobState::Transcoding,
        );
        let result = t
            .env
            .exec(
                Tool::Ffmpeg,
                vec![],
                Duration::from_secs(1),
                ExecOptions::default(),
            )
            .await
            .unwrap();

        assert_eq!(result.exit_code, Some(3));
    }

    #[tokio::test]
    async fn a_spawn_failure_is_a_path_free_failed_error() {
        let t = fixture(
            FakeRunner::new(|_| Err(RunError("No such file: C:\\Users\\bob\\ffmpeg.exe".into()))),
            JobState::Transcoding,
        );
        let error = t
            .env
            .exec(
                Tool::Ffmpeg,
                vec![],
                Duration::from_secs(1),
                ExecOptions::default(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.kind, PipelineErrorKind::Failed);
        assert_eq!(error.message, "Could not start ffmpeg.");
    }
}
