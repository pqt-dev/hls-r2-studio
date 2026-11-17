//! Thumbnail (spec 4.4 step 4, port of ThumbnailGenerator and steps/thumbnail.ts). Optional: any
//! failure only logs a warning and yields "no thumbnail"; only cancellation is propagated.
//!
//! Scoring uses ffprobe `signalstats` like the TS (no image library), so there are no numeric
//! differences to document.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;

use super::env::StepEnv;
use super::fs_util::{file_exists, remove_files};
use super::image_size::jpeg_size;
use super::score::{measure_detail, measure_saturation};
use crate::ffmpeg::args::{
    hstack_args, short_video_thumbnail_args, smart_crop_crop_args, smart_crop_scale_args,
    thumbnail_frame_args, IMAGE_COMMAND_TIMEOUT_SECONDS,
};
use crate::ffmpeg::errors::{is_cancelled, succeeded, PipelineError, Tool};
use crate::pipeline::file_names::{thumb_candidate_file_name, THUMBNAIL_FILE};
use crate::pipeline::thumbnail_plan::{
    candidate_timestamps, choose_thumbnail_layout, is_landscape, is_short_video,
    needs_extra_candidate, pick_best_offset, smart_crop_offsets, smart_crop_plan, Axis, Canvas,
    OffsetScore, Scored, ThumbnailLayout, COLUMN_CANVAS, SINGLE_CANVAS,
};

const IMAGE_TIMEOUT: Duration = Duration::from_secs(IMAGE_COMMAND_TIMEOUT_SECONDS);

pub struct ThumbnailInput {
    /// Absolute source path.
    pub input: String,
    pub duration: Option<f64>,
    /// Output (transcoded) size, used to pick the landscape or the grid layout.
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
struct Frame {
    timestamp: f64,
    file: String,
    saturation: Option<f64>,
    detail: Option<f64>,
}

impl Scored for Frame {
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

/// Why one sub-step failed (never escapes: only `Cancelled` does).
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

struct Work<'a> {
    env: &'a StepEnv,
    created: Vec<String>,
    next_id: u32,
}

impl Work<'_> {
    fn path(&self, name: &str) -> PathBuf {
        self.env.cwd.join(name)
    }

    fn track(&mut self, name: String) -> String {
        self.created.push(name.clone());

        name
    }

    fn id(&mut self) -> u32 {
        self.next_id += 1;

        self.next_id - 1
    }

    async fn run_image(&self, args: Vec<String>) -> Result<bool, PipelineError> {
        let result = self
            .env
            .exec(Tool::Ffmpeg, args, IMAGE_TIMEOUT, Default::default())
            .await?;

        Ok(succeeded(&result))
    }

    /// `runImage(...).catch(() => false)` that still propagates cancellation.
    async fn run_image_or_false(&self, args: Vec<String>) -> Result<bool, PipelineError> {
        match self.run_image(args).await {
            Err(error) if is_cancelled(&error) => Err(error),
            Err(_) => Ok(false),
            Ok(ok) => Ok(ok),
        }
    }

    async fn exists(&self, name: &str) -> bool {
        file_exists(&*self.env.fs, &self.path(name)).await
    }

    async fn remove(&self, paths: &[PathBuf]) {
        remove_files(&*self.env.fs, paths).await;
    }
}

/// Returns true when `thumbnail.jpg` exists in the job directory afterwards.
pub async fn generate_thumbnail(
    env: &StepEnv,
    input: &ThumbnailInput,
) -> Result<bool, PipelineError> {
    let mut work = Work {
        env,
        created: Vec::new(),
        next_id: 0,
    };
    let outcome = run(&mut work, input).await;
    let created: Vec<PathBuf> = work.created.iter().map(|n| work.path(n)).collect();

    // `finally`: scratch files always go away.
    let thumbnail = work.path(THUMBNAIL_FILE);

    match outcome {
        Err(Fail::Cancelled(error)) => {
            work.remove(&created).await;

            return Err(error);
        }
        Err(Fail::Other(message)) => {
            env.logger.warn(
                "Thumbnail generation failed; continuing without a thumbnail.",
                Some(json!({ "error": message })),
            );
            work.remove(std::slice::from_ref(&thumbnail)).await;
        }
        Ok(()) => {}
    }

    work.remove(&created).await;

    Ok(file_exists(&*env.fs, &thumbnail).await)
}

async fn run(work: &mut Work<'_>, input: &ThumbnailInput) -> Result<(), Fail> {
    let env = work.env;
    let thumbnail = work.path(THUMBNAIL_FILE);

    if is_short_video(input.duration) {
        let ok = work
            .run_image(short_video_thumbnail_args(&input.input, input.duration))
            .await?;

        if !ok {
            env.logger
                .warn("Could not extract a frame from the short video.", None);
            work.remove(&[thumbnail]).await;
        }

        return Ok(());
    }

    let duration = input.duration.unwrap_or(0.0);
    let plan = candidate_timestamps(duration);
    let mut candidates: Vec<Frame> = Vec::new();

    let timestamps = plan
        .initial
        .iter()
        .map(|t| (*t, false))
        .chain(plan.extras.iter().map(|t| (*t, true)));

    for (counter, (timestamp, is_extra)) in (0u32..).zip(timestamps) {
        if is_extra && !needs_extra_candidate(&candidates) {
            break;
        }

        let file = work.track(thumb_candidate_file_name(counter));

        let ok = work
            .run_image_or_false(thumbnail_frame_args(&input.input, timestamp, &file))
            .await?;

        if !ok || !work.exists(&file).await {
            env.logger.warn(
                "Could not extract a thumbnail candidate frame; skipping it.",
                None,
            );

            continue;
        }

        let saturation = measure_saturation(env, &file).await?;
        let detail = measure_detail(env, &file).await?;

        candidates.push(Frame {
            timestamp,
            file,
            saturation,
            detail,
        });
    }

    if candidates.is_empty() {
        env.logger
            .warn("No thumbnail candidate frames could be extracted.", None);

        return Ok(());
    }

    let layout = choose_thumbnail_layout(&candidates, is_landscape(input.width, input.height));

    let ranked = match layout {
        ThumbnailLayout::None => return Ok(()),
        ThumbnailLayout::Triple { ranked, .. } => {
            if try_grid(work, &ranked).await? {
                return Ok(());
            }

            ranked
        }
        ThumbnailLayout::Single { ranked, .. } => ranked,
    };

    if !try_single(work, &ranked).await? {
        env.logger.warn(
            "No thumbnail could be created from any candidate frame.",
            None,
        );
        work.remove(&[thumbnail]).await;
    }

    Ok(())
}

async fn try_single(work: &mut Work<'_>, ranked: &[Frame]) -> Result<bool, Fail> {
    for frame in ranked {
        match smart_crop_to_canvas(work, &frame.file, THUMBNAIL_FILE, SINGLE_CANVAS).await {
            Ok(()) => return Ok(true),
            Err(Fail::Cancelled(error)) => return Err(Fail::Cancelled(error)),
            Err(Fail::Other(message)) => work.env.logger.warn(
                "Single-frame thumbnail failed; trying the next candidate.",
                Some(json!({ "error": message })),
            ),
        }
    }

    Ok(false)
}

async fn try_grid(work: &mut Work<'_>, ranked: &[Frame]) -> Result<bool, Fail> {
    let env = work.env;
    let id = work.id();
    let mut columns: Vec<(f64, String)> = Vec::new();

    for frame in ranked {
        if columns.len() >= 3 {
            break;
        }

        let file = work.track(format!("grid{id}_col_{}.jpg", columns.len()));

        match smart_crop_to_canvas(work, &frame.file, &file, COLUMN_CANVAS).await {
            Ok(()) => columns.push((frame.timestamp, file)),
            Err(Fail::Cancelled(error)) => return Err(Fail::Cancelled(error)),
            Err(Fail::Other(message)) => env.logger.warn(
                "Cropping a grid column failed; trying the next candidate.",
                Some(json!({ "error": message })),
            ),
        }
    }

    columns.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let [first, second, third] = match columns.as_slice() {
        [a, b, c] => [a.1.as_str(), b.1.as_str(), c.1.as_str()],
        _ => return Ok(false),
    };
    let thumbnail = work.path(THUMBNAIL_FILE);

    match work
        .run_image(hstack_args([first, second, third], THUMBNAIL_FILE))
        .await
    {
        Ok(true) if work.exists(THUMBNAIL_FILE).await => return Ok(true),
        Ok(_) => {}
        Err(error) if is_cancelled(&error) => return Err(Fail::Cancelled(error)),
        Err(error) => env.logger.warn(
            "Composing the grid thumbnail failed; using a single frame.",
            Some(json!({ "error": error.message })),
        ),
    }

    work.remove(&[thumbnail]).await;

    Ok(false)
}

fn crop_origin(axis: Option<Axis>, offset: i64) -> (i64, i64) {
    (
        if axis == Some(Axis::X) { offset } else { 0 },
        if axis == Some(Axis::Y) { offset } else { 0 },
    )
}

/// Port of PHP `smartCropToCanvas`: scale to cover, pick the sharpest of 3 crops, final crop.
async fn smart_crop_to_canvas(
    work: &mut Work<'_>,
    frame_path: &str,
    output_path: &str,
    canvas: Canvas,
) -> Result<(), Fail> {
    let env = work.env;
    let id = work.id();
    let scaled = work.track(format!("sc{id}_scaled.jpg"));

    if !work
        .run_image(smart_crop_scale_args(
            frame_path,
            &scaled,
            canvas.width,
            canvas.height,
        ))
        .await?
    {
        return Err(Fail::Other("smart-crop scale failed".into()));
    }

    let bytes = env
        .fs
        .read(&work.path(&scaled))
        .await
        .map_err(|_| Fail::Other("could not read the scaled image".into()))?;
    let size = jpeg_size(&bytes)
        .ok_or_else(|| Fail::Other("could not read the scaled image size".into()))?;
    let plan = smart_crop_plan(
        i64::from(size.width),
        i64::from(size.height),
        i64::from(canvas.width),
        i64::from(canvas.height),
    );
    let mut scores = Vec::new();

    for (index, offset) in smart_crop_offsets(plan.max_offset).into_iter().enumerate() {
        let trial = work.track(format!("sc{id}_trial_{index}.jpg"));
        let (x, y) = crop_origin(plan.axis, offset);
        let ok = work
            .run_image_or_false(smart_crop_crop_args(
                &scaled,
                &trial,
                canvas.width,
                canvas.height,
                x,
                y,
            ))
            .await?;

        if !ok {
            continue;
        }

        scores.push(OffsetScore {
            offset,
            score: measure_detail(env, &trial).await?,
        });
    }

    let best = pick_best_offset(&scores, plan.max_offset);
    let (x, y) = crop_origin(plan.axis, best);
    let final_ok = work
        .run_image(smart_crop_crop_args(
            &scaled,
            output_path,
            canvas.width,
            canvas.height,
            x,
            y,
        ))
        .await?;

    if final_ok {
        Ok(())
    } else {
        Err(Fail::Other("smart-crop final crop failed".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::super::env::test_env::*;
    use super::*;
    use crate::dto::JobState;
    use crate::ffmpeg::runner::RunProcessInput;
    use crate::pipeline::deps::fakes::{exit_result, ok_result, FakeFs, FakeRunner};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// SOF0 header of a 1920x1080 JPEG (the "scaled" image of the fake ffmpeg).
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];

        data.extend(height.to_be_bytes());
        data.extend(width.to_be_bytes());
        data.push(0x03);
        data
    }

    fn output_of(args: &[String]) -> String {
        args.last().cloned().unwrap_or_default()
    }

    /// A fake ffmpeg/ffprobe over the fake filesystem. ffmpeg writes its last argument; scale
    /// steps (`scale=`) write a JPEG of `scaled_size`. ffprobe answers per image name.
    fn script(
        fs: Arc<FakeFs>,
        scaled_size: (u16, u16),
        scores: HashMap<&'static str, (&'static str, &'static str)>,
        failing_outputs: &'static [&'static str],
    ) -> Arc<FakeRunner> {
        FakeRunner::new(move |run: &mut RunProcessInput| {
            if run.command == "ffprobe" {
                let movie = run.args.iter().find(|a| a.starts_with("movie=")).unwrap();
                let name = movie
                    .trim_start_matches("movie=")
                    .split(',')
                    .next()
                    .unwrap()
                    .to_string();
                let is_detail = movie.contains("edgedetect");
                let (sat, det) = scores.get(name.as_str()).copied().unwrap_or(("20", "6"));

                return Ok(ok_result(if is_detail { det } else { sat }));
            }

            let out = output_of(&run.args);

            if failing_outputs.iter().any(|f| out == *f) {
                return Ok(exit_result(1));
            }

            let path = std::path::Path::new(CWD).join(&out);

            if run.args.iter().any(|a| a.starts_with("scale=")) {
                fs.put(path, &jpeg(scaled_size.0, scaled_size.1));
            } else {
                fs.put(path, b"img");
            }

            Ok(ok_result(""))
        })
    }

    fn input(duration: Option<f64>, size: (u64, u64)) -> ThumbnailInput {
        ThumbnailInput {
            input: "/src/in.mp4".into(),
            duration,
            width: Some(size.0),
            height: Some(size.1),
        }
    }

    fn no_scratch(fs: &FakeFs) -> bool {
        fs.names().iter().all(|n| n == THUMBNAIL_FILE)
    }

    fn setup(
        scaled: (u16, u16),
        scores: HashMap<&'static str, (&'static str, &'static str)>,
        failing: &'static [&'static str],
    ) -> Fixture {
        let fs = Arc::new(FakeFs::default());
        let mut t = fixture(
            script(fs.clone(), scaled, scores, failing),
            JobState::Thumbnail,
        );

        t.env.fs = fs.clone();
        t.fs = fs;

        t
    }

    #[tokio::test]
    async fn a_short_video_uses_one_mid_frame() {
        let t = setup((1080, 1080), HashMap::new(), &[]);
        let ok = generate_thumbnail(&t.env, &input(Some(2.0), (1280, 720)))
            .await
            .unwrap();

        assert!(ok);
        assert_eq!(t.runner.call_count(), 1);

        let call = &t.runner.calls.lock().unwrap()[0];

        assert_eq!(call.args.last().unwrap(), THUMBNAIL_FILE);
        assert!(call.args.windows(2).any(|w| w == ["-ss", "1"]));
    }

    #[tokio::test]
    async fn a_failing_short_video_frame_means_no_thumbnail() {
        let t = setup((1080, 1080), HashMap::new(), &[THUMBNAIL_FILE]);

        assert!(!generate_thumbnail(&t.env, &input(None, (1280, 720)))
            .await
            .unwrap());
        assert!(t.logger.text().contains("short video"));
    }

    #[tokio::test]
    async fn a_landscape_video_gets_a_single_smart_cropped_frame() {
        // 1920x1080 scaled image: excess 840 on x -> three trial crops at 0, 420, 840.
        let t = setup((1920, 1080), HashMap::new(), &[]);
        let ok = generate_thumbnail(&t.env, &input(Some(100.0), (1280, 720)))
            .await
            .unwrap();

        assert!(ok);
        assert!(no_scratch(&t.fs), "{:?}", t.fs.names());

        let calls = t.runner.calls.lock().unwrap();
        let crops: Vec<&String> = calls
            .iter()
            .filter(|c| c.command == "ffmpeg")
            .flat_map(|c| c.args.iter())
            .filter(|a| a.starts_with("crop="))
            .collect();

        // 3 trial crops + the final crop; ties keep the first offset (0).
        assert_eq!(crops.len(), 4);
        assert_eq!(crops[0], "crop=1080:1080:0:0");
        assert_eq!(crops[1], "crop=1080:1080:420:0");
        assert_eq!(crops[2], "crop=1080:1080:840:0");
        assert_eq!(crops[3], "crop=1080:1080:0:0");
        // 3 initial candidates only: they all pass the filter, no extras.
        let frames = calls
            .iter()
            .filter(|c| c.args.contains(&"thumbnail=24".to_string()))
            .count();

        assert_eq!(frames, 3);
    }

    #[tokio::test]
    async fn a_portrait_video_gets_a_three_column_grid() {
        let t = setup((360, 1080), HashMap::new(), &[]);
        let ok = generate_thumbnail(&t.env, &input(Some(100.0), (720, 1280)))
            .await
            .unwrap();

        assert!(ok);
        assert!(no_scratch(&t.fs), "{:?}", t.fs.names());

        let calls = t.runner.calls.lock().unwrap();
        let hstack = calls
            .iter()
            .find(|c| c.args.iter().any(|a| a.contains("hstack=inputs=3")))
            .expect("hstack call");

        assert_eq!(hstack.args.last().unwrap(), THUMBNAIL_FILE);
    }

    #[tokio::test]
    async fn extra_candidates_are_tried_until_three_frames_pass() {
        let scores = HashMap::from([
            ("thumb_candidate_0.jpg", ("1", "1")),
            ("thumb_candidate_1.jpg", ("1", "1")),
        ]);
        let t = setup((1920, 1080), scores, &[]);

        assert!(generate_thumbnail(&t.env, &input(Some(100.0), (1280, 720)))
            .await
            .unwrap());

        let calls = t.runner.calls.lock().unwrap();
        let frames: Vec<&Vec<String>> = calls
            .iter()
            .filter(|c| c.args.contains(&"thumbnail=24".to_string()))
            .map(|c| &c.args)
            .collect();

        // 0 and 1 are removed, so after 3 initial frames only 1 passes: both extras are tried.
        assert_eq!(frames.len(), 5);
    }

    #[tokio::test]
    async fn without_any_candidate_there_is_no_thumbnail() {
        let t = setup(
            (1080, 1080),
            HashMap::new(),
            &[
                "thumb_candidate_0.jpg",
                "thumb_candidate_1.jpg",
                "thumb_candidate_2.jpg",
                "thumb_candidate_3.jpg",
                "thumb_candidate_4.jpg",
            ],
        );

        assert!(
            !generate_thumbnail(&t.env, &input(Some(100.0), (1280, 720)))
                .await
                .unwrap()
        );
        assert!(t.logger.text().contains("No thumbnail candidate frames"));
    }

    #[tokio::test]
    async fn a_failing_grid_falls_back_to_a_single_frame() {
        let t = setup((360, 1080), HashMap::new(), &["grid0_col_0.jpg"]);

        // The first grid column cannot be cropped; the 4th frame is not available, so the grid
        // fails and the single-frame path produces the thumbnail.
        assert!(generate_thumbnail(&t.env, &input(Some(100.0), (720, 1280)))
            .await
            .unwrap());
        assert!(
            t.logger.text().contains("Cropping a grid column failed")
                || t.logger.text().contains("trying the next")
        );
    }

    #[tokio::test]
    async fn a_failing_scale_everywhere_gives_no_thumbnail_and_cleans_up() {
        let t = setup(
            (1920, 1080),
            HashMap::new(),
            &["sc0_scaled.jpg", "sc1_scaled.jpg", "sc2_scaled.jpg"],
        );

        assert!(
            !generate_thumbnail(&t.env, &input(Some(100.0), (1280, 720)))
                .await
                .unwrap()
        );
        assert!(t.logger.text().contains("No thumbnail could be created"));
        assert!(t.fs.names().is_empty(), "{:?}", t.fs.names());
    }

    #[tokio::test]
    async fn cancellation_is_propagated_and_cleans_up() {
        let t = setup((1920, 1080), HashMap::new(), &[]);
        let token = t.env.cancel.clone();
        let fs = t.fs.clone();
        let counter = Arc::new(Mutex::new(0));
        let env = {
            let mut e = t.env.clone();

            e.run = FakeRunner::new({
                let counter = counter.clone();

                move |run| {
                    let mut n = counter.lock().unwrap();

                    *n += 1;

                    if *n == 2 {
                        token.cancel();
                    }

                    if run.command == "ffmpeg" {
                        fs.put(std::path::Path::new(CWD).join(output_of(&run.args)), b"img");
                    }

                    Ok(ok_result("20"))
                }
            });

            e
        };
        let error = generate_thumbnail(&env, &input(Some(100.0), (1280, 720)))
            .await
            .unwrap_err();

        assert!(crate::ffmpeg::errors::is_cancelled(&error));
        assert!(t.fs.names().is_empty(), "{:?}", t.fs.names());
    }
}
