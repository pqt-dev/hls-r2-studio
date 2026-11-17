//! Storyboards (spec 4.4 step 5, port of StoryboardGenerator and steps/storyboard.ts): one
//! decode pass of 75 candidate frames, scoring, slot assignment and `tile=NxN` composition for
//! the 3x3, 4x4 and 5x5 grids. Never fails the video: any problem only logs a warning; only
//! cancellation is propagated.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::env::StepEnv;
use super::fs_util::{file_exists, remove_files};
use super::score::{measure_detail, measure_saturation};
use crate::ffmpeg::args::{
    storyboard_candidate_args, storyboard_tile_args, storyboard_timeout_seconds,
    StoryboardCandidateArgsInput, IMAGE_COMMAND_TIMEOUT_SECONDS,
};
use crate::ffmpeg::errors::{is_cancelled, succeeded, PipelineError, Tool};
use crate::pipeline::file_names::storyboard_file_name;
use crate::pipeline::pool::run_pool;
use crate::pipeline::storyboard_plan::{
    assign_slots, candidate_timestamp, storyboard_json, tile_file_names, StoryboardEntry,
    SCORING_CONCURRENCY, STORYBOARD_GRID_SIZES,
};
use crate::pipeline::thumbnail_plan::Scored;

/// (saturation, detail) per candidate, filled by the scoring workers.
type Scores = Arc<Mutex<Vec<(Option<f64>, Option<f64>)>>>;

const TILE_TIMEOUT: Duration = Duration::from_secs(IMAGE_COMMAND_TIMEOUT_SECONDS);

pub struct StoryboardInput {
    pub input: String,
    pub duration: Option<f64>,
    /// Object key prefix, used for the returned `storyboards` map.
    pub prefix: String,
    pub threads: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    file: String,
    timestamp: f64,
    saturation: Option<f64>,
    detail: Option<f64>,
}

impl Scored for Candidate {
    fn timestamp(&self) -> f64 {
        self.timestamp
    }

    fn saturation(&self) -> Option<f64> {
        self.saturation
    }

    fn detail(&self) -> Option<f64> {
        self.detail
    }
}

/// A failed sub-step: cancellation escapes, anything else is a warning.
enum Fail {
    Cancelled(PipelineError),
    Other(String),
}

impl From<PipelineError> for Fail {
    fn from(error: PipelineError) -> Self {
        if is_cancelled(&error) {
            Fail::Cancelled(error)
        } else {
            Fail::Other(error.message)
        }
    }
}

/// The `storyboards` register map for the grids that were produced, or `None`.
pub async fn generate_storyboards(
    env: &StepEnv,
    input: &StoryboardInput,
) -> Result<Option<BTreeMap<String, StoryboardEntry>>, PipelineError> {
    let Some(duration) = input.duration.filter(|d| *d > 0.0) else {
        env.logger.warn(
            "Skipping the storyboard: the video duration is unknown.",
            None,
        );

        return Ok(None);
    };

    let mut created: Vec<String> = Vec::new();
    let outcome = produce(env, input, duration, &mut created).await;
    let paths: Vec<PathBuf> = created.iter().map(|n| env.cwd.join(n)).collect();

    // `finally`: scratch files always go away.
    remove_files(&*env.fs, &paths).await;

    match outcome {
        Ok(grids) => Ok(storyboard_json(&grids, &input.prefix)),
        Err(Fail::Cancelled(error)) => Err(error),
        Err(Fail::Other(message)) => {
            env.logger.warn(
                "Storyboard generation failed; continuing without storyboards.",
                Some(json!({ "error": message })),
            );

            Ok(None)
        }
    }
}

async fn produce(
    env: &StepEnv,
    input: &StoryboardInput,
    duration: f64,
    created: &mut Vec<String>,
) -> Result<Vec<u32>, Fail> {
    let candidates = extract_and_score(env, input, duration, created).await?;
    let mut grids = Vec::new();

    for size in STORYBOARD_GRID_SIZES {
        match compose_grid(env, &candidates, duration, size, created).await {
            Ok(()) => grids.push(size),
            Err(Fail::Cancelled(error)) => return Err(Fail::Cancelled(error)),
            Err(Fail::Other(message)) => env.logger.warn(
                &format!("Storyboard {size}x{size} failed; skipping that grid."),
                Some(json!({ "error": message })),
            ),
        }
    }

    Ok(grids)
}

fn is_candidate_file(name: &str) -> bool {
    name.strip_prefix("candidate_")
        .and_then(|rest| rest.strip_suffix(".jpg"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

async fn extract_and_score(
    env: &StepEnv,
    input: &StoryboardInput,
    duration: f64,
    created: &mut Vec<String>,
) -> Result<Vec<Candidate>, Fail> {
    let mut args = StoryboardCandidateArgsInput::new(&input.input, duration);

    args.threads = input.threads;

    let result = env
        .exec(
            Tool::Ffmpeg,
            storyboard_candidate_args(&args),
            Duration::from_secs(storyboard_timeout_seconds(duration)),
            Default::default(),
        )
        .await?;
    let mut names: Vec<String> = env
        .fs
        .list_names(&env.cwd)
        .await
        .map_err(|_| Fail::Other("could not list the job directory".into()))?
        .into_iter()
        .filter(|n| is_candidate_file(n))
        .collect();

    names.sort();
    created.extend(names.iter().cloned());

    if !succeeded(&result) || names.is_empty() {
        return Err(Fail::Other("storyboard candidate extraction failed".into()));
    }

    let scores: Scores = Arc::new(Mutex::new(vec![(None, None); names.len()]));
    let worker_env = env.clone();
    let worker_scores = Arc::clone(&scores);

    run_pool(
        names.clone(),
        SCORING_CONCURRENCY,
        move |file: String, index| {
            let (env, scores) = (worker_env.clone(), Arc::clone(&worker_scores));

            async move {
                let (saturation, detail) =
                    tokio::try_join!(measure_saturation(&env, &file), measure_detail(&env, &file))?;

                scores.lock().expect("scores lock")[index] = (saturation, detail);

                Ok::<(), PipelineError>(())
            }
        },
    )
    .await?;

    let scores = scores.lock().expect("scores lock");

    Ok(names
        .into_iter()
        .enumerate()
        .map(|(index, file)| Candidate {
            file,
            timestamp: candidate_timestamp(index, duration),
            saturation: scores[index].0,
            detail: scores[index].1,
        })
        .collect())
}

async fn compose_grid(
    env: &StepEnv,
    candidates: &[Candidate],
    duration: f64,
    size: u32,
    created: &mut Vec<String>,
) -> Result<(), Fail> {
    let chosen =
        assign_slots(size, candidates, duration).map_err(|e| Fail::Other(e.to_string()))?;
    let tiles = tile_file_names(size);

    for (slot, frame) in chosen.iter().enumerate() {
        let tile = tiles
            .get(slot)
            .ok_or_else(|| Fail::Other("tile slot out of range".into()))?;

        created.push(tile.clone());
        env.fs
            .copy(&env.cwd.join(&frame.file), &env.cwd.join(tile))
            .await
            .map_err(|_| Fail::Other("could not copy a tile frame".into()))?;
    }

    let output = storyboard_file_name(size);
    let result = env
        .exec(
            Tool::Ffmpeg,
            storyboard_tile_args(size),
            TILE_TIMEOUT,
            Default::default(),
        )
        .await?;

    // The tile filter silently writes nothing when it gets too few frames: check the file too.
    if !succeeded(&result) || !file_exists(&*env.fs, &env.cwd.join(&output)).await {
        remove_files(&*env.fs, &[env.cwd.join(&output)]).await;

        return Err(Fail::Other(format!(
            "ffmpeg {size}x{size} composition failed"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::env::test_env::*;
    use super::*;
    use crate::dto::JobState;
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeFs, FakeRunner};

    /// ffmpeg: candidate pass writes `n` candidates, a tile pass writes `storyboard_NxN.jpg`
    /// unless the size is in `failing`; ffprobe answers fixed scores.
    fn script(
        fs: Arc<FakeFs>,
        n: usize,
        failing: &'static [u32],
        extract_ok: bool,
    ) -> Arc<FakeRunner> {
        FakeRunner::new(move |run| {
            if run.command == "ffprobe" {
                return Ok(ok_result("20"));
            }

            if run.args.iter().any(|a| a.starts_with("fps=")) {
                if !extract_ok {
                    return Ok(exit_result(1));
                }

                for i in 0..n {
                    fs.put(
                        std::path::Path::new(CWD).join(format!("candidate_{i:04}.jpg")),
                        b"c",
                    );
                }

                return Ok(ok_result(""));
            }

            let out = run.args.last().cloned().unwrap();
            let size: u32 = out
                .trim_start_matches("storyboard_")
                .chars()
                .next()
                .unwrap()
                .to_digit(10)
                .unwrap();

            if failing.contains(&size) {
                return Ok(exit_result(1));
            }

            fs.put(std::path::Path::new(CWD).join(out), b"board");

            Ok(ok_result(""))
        })
    }

    fn setup(n: usize, failing: &'static [u32], extract_ok: bool) -> Fixture {
        let fs = Arc::new(FakeFs::default());
        let mut t = fixture(
            script(fs.clone(), n, failing, extract_ok),
            JobState::Storyboard,
        );

        t.env.fs = fs.clone();
        t.fs = fs;

        t
    }

    fn input(duration: Option<f64>) -> StoryboardInput {
        StoryboardInput {
            input: "/src/in.mp4".into(),
            duration,
            prefix: "2026/01/02/clip-ab12cd34ef56/".into(),
            threads: Some(2),
        }
    }

    #[tokio::test]
    async fn produces_the_three_grids_and_cleans_up_scratch_files() {
        let t = setup(75, &[], true);
        let json = generate_storyboards(&t.env, &input(Some(150.0)))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(json.keys().collect::<Vec<_>>(), ["3x3", "4x4", "5x5"]);
        assert_eq!(
            json["4x4"].path,
            "2026/01/02/clip-ab12cd34ef56/storyboard_4x4.jpg"
        );

        let mut names = t.fs.names();

        names.sort();

        assert_eq!(
            names,
            [
                "storyboard_3x3.jpg",
                "storyboard_4x4.jpg",
                "storyboard_5x5.jpg"
            ]
        );

        let calls = t.runner.calls.lock().unwrap();

        // 1 candidate pass + 3 tile passes; 150 probes (2 per candidate).
        assert_eq!(calls.iter().filter(|c| c.command == "ffmpeg").count(), 4);
        assert_eq!(calls.iter().filter(|c| c.command == "ffprobe").count(), 150);
        assert!(calls[0].args.windows(2).any(|w| w == ["-threads", "2"]));
    }

    #[tokio::test]
    async fn a_failed_grid_is_skipped_and_the_others_kept() {
        let t = setup(75, &[4], true);
        let json = generate_storyboards(&t.env, &input(Some(150.0)))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(json.keys().collect::<Vec<_>>(), ["3x3", "5x5"]);
        assert!(t.logger.text().contains("Storyboard 4x4 failed"));
        assert!(!t.fs.has(path("storyboard_4x4.jpg")));
    }

    #[tokio::test]
    async fn all_grids_failing_gives_none() {
        let t = setup(75, &[3, 4, 5], true);

        assert_eq!(
            generate_storyboards(&t.env, &input(Some(150.0)))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_failed_candidate_pass_gives_none_and_a_warning() {
        let t = setup(0, &[], false);

        assert_eq!(
            generate_storyboards(&t.env, &input(Some(150.0)))
                .await
                .unwrap(),
            None
        );
        assert!(t.logger.text().contains("Storyboard generation failed"));
    }

    #[tokio::test]
    async fn no_candidate_files_gives_none() {
        let t = setup(0, &[], true);

        assert_eq!(
            generate_storyboards(&t.env, &input(Some(150.0)))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn an_unknown_duration_skips_the_step() {
        for duration in [None, Some(0.0), Some(-1.0)] {
            let t = setup(75, &[], true);

            assert_eq!(
                generate_storyboards(&t.env, &input(duration))
                    .await
                    .unwrap(),
                None
            );
            assert_eq!(t.runner.call_count(), 0);
            assert!(t.logger.text().contains("duration is unknown"));
        }
    }

    #[tokio::test]
    async fn a_short_candidate_list_still_fills_every_slot() {
        // Only 5 candidates survive extraction: empty slots reuse the nearest genuine one.
        let t = setup(5, &[], true);
        let json = generate_storyboards(&t.env, &input(Some(150.0)))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(json.len(), 3);
    }

    #[tokio::test]
    async fn cancellation_is_propagated_and_cleans_up() {
        let t = setup(75, &[], true);

        t.env.cancel.cancel();

        let error = generate_storyboards(&t.env, &input(Some(150.0)))
            .await
            .unwrap_err();

        assert!(is_cancelled(&error));
        assert!(t.fs.names().is_empty());
    }

    #[test]
    fn recognizes_candidate_names() {
        assert!(is_candidate_file("candidate_0000.jpg"));
        assert!(is_candidate_file("candidate_12.jpg"));
        assert!(!is_candidate_file("candidate_.jpg"));
        assert!(!is_candidate_file("candidate_0000.jpg.tmp"));
        assert!(!is_candidate_file("thumb_candidate_0.jpg"));
        assert!(!is_candidate_file("candidate_00x0.jpg"));
    }
}
