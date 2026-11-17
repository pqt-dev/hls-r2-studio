//! Pure planning/ranking for the thumbnail step (port of thumbnailPlan.ts, itself a port of
//! ThumbnailGenerator). The caller extracts frames and measures scores; this module only decides
//! what to extract and which frames to use.

use std::cmp::Ordering;

pub const MIN_SATURATION: f64 = 5.0;
pub const MIN_DETAIL: f64 = 3.0;
pub const DETAIL_SCORE_WEIGHT: f64 = 5.0;
pub const SHORT_VIDEO_SECONDS: f64 = 3.0;
pub const INITIAL_SAMPLE_FRACTIONS: [f64; 3] = [0.25, 0.5, 0.75];
pub const EXTRA_SAMPLE_FRACTIONS: [f64; 2] = [0.1, 0.9];
pub const REQUIRED_KEPT_FOR_EARLY_STOP: usize = 3;
pub const SMART_CROP_WINDOW_COUNT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
}

pub const SINGLE_CANVAS: Canvas = Canvas {
    width: 1080,
    height: 1080,
};
pub const COLUMN_CANVAS: Canvas = Canvas {
    width: 360,
    height: 1080,
};

/// A scored candidate frame. `saturation`/`detail` are `None` when the measurement failed.
pub trait Scored {
    fn timestamp(&self) -> f64;
    fn saturation(&self) -> Option<f64>;
    fn detail(&self) -> Option<f64>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoredFrame {
    pub timestamp: f64,
    pub saturation: Option<f64>,
    pub detail: Option<f64>,
}

impl Scored for ScoredFrame {
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

/// JS `Math.round`: halves round up (towards +infinity).
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Duration below 3 s (or unknown, treated as 0) uses the single mid-frame path.
pub fn is_short_video(duration: Option<f64>) -> bool {
    duration.unwrap_or(0.0) < SHORT_VIDEO_SECONDS
}

/// Timestamp of the single frame extracted for short videos: `duration / 2`.
pub fn short_video_timestamp(duration: Option<f64>) -> f64 {
    duration.unwrap_or(0.0) / 2.0
}

fn clamped_timestamp(duration: f64, fraction: f64) -> f64 {
    let max_timestamp = (duration - 0.5).max(0.0);

    (duration * fraction).max(0.0).min(max_timestamp)
}

#[derive(Debug, Clone, PartialEq)]
pub struct CandidatePlan {
    pub initial: Vec<f64>,
    pub extras: Vec<f64>,
}

/// Candidate timestamps for videos of 3 s or more: `initial` (0.25/0.5/0.75) are always tried;
/// `extras` (0.1/0.9) are tried one at a time, only while [`needs_extra_candidate`] says so.
pub fn candidate_timestamps(duration: f64) -> CandidatePlan {
    CandidatePlan {
        initial: INITIAL_SAMPLE_FRACTIONS
            .iter()
            .map(|f| clamped_timestamp(duration, *f))
            .collect(),
        extras: EXTRA_SAMPLE_FRACTIONS
            .iter()
            .map(|f| clamped_timestamp(duration, *f))
            .collect(),
    }
}

pub fn is_removed(saturation: Option<f64>, detail: Option<f64>) -> bool {
    match saturation {
        None => true,
        Some(s) => s < MIN_SATURATION || detail.is_some_and(|d| d < MIN_DETAIL),
    }
}

/// `saturation + 5 * detail`, with a missing score counting as 0.
pub fn rank(saturation: Option<f64>, detail: Option<f64>) -> f64 {
    saturation.unwrap_or(0.0) + DETAIL_SCORE_WEIGHT * detail.unwrap_or(0.0)
}

pub fn rank_frame<T: Scored>(frame: &T) -> f64 {
    rank(frame.saturation(), frame.detail())
}

pub fn is_frame_removed<T: Scored>(frame: &T) -> bool {
    is_removed(frame.saturation(), frame.detail())
}

/// Stable sort by rank, best first (ties keep their input order, like PHP 8 usort).
pub fn sort_by_rank_desc<T: Scored + Clone>(frames: &[T]) -> Vec<T> {
    let mut sorted = frames.to_vec();

    sorted.sort_by(|a, b| {
        rank_frame(b)
            .partial_cmp(&rank_frame(a))
            .unwrap_or(Ordering::Equal)
    });

    sorted
}

/// Checked before extracting each extra candidate: fewer than 3 frames passed the filter so far.
pub fn needs_extra_candidate<T: Scored>(candidates: &[T]) -> bool {
    candidates.iter().filter(|c| !is_frame_removed(*c)).count() < REQUIRED_KEPT_FOR_EARLY_STOP
}

pub fn is_landscape(width: Option<u64>, height: Option<u64>) -> bool {
    matches!((width, height), (Some(w), Some(h)) if w > h)
}

#[derive(Debug, Clone, PartialEq)]
pub enum ThumbnailLayout<T> {
    None,
    /// `ranked` is the best-first list so the caller can fall through when a frame fails.
    Single {
        frame: T,
        ranked: Vec<T>,
    },
    /// `frames` are the 3 best, ordered by timestamp; `ranked` allows replacing a failed crop.
    Triple {
        frames: [T; 3],
        ranked: Vec<T>,
    },
}

pub fn choose_thumbnail_layout<T: Scored + Clone>(
    candidates: &[T],
    landscape: bool,
) -> ThumbnailLayout<T> {
    if candidates.is_empty() {
        return ThumbnailLayout::None;
    }

    let mut kept: Vec<T> = candidates
        .iter()
        .filter(|c| !is_frame_removed(*c))
        .cloned()
        .collect();
    let removed: Vec<T> = candidates
        .iter()
        .filter(|c| is_frame_removed(*c))
        .cloned()
        .collect();
    let min_needed = if landscape { 1 } else { 3 };

    if kept.len() < min_needed {
        let missing = min_needed - kept.len();

        kept.extend(sort_by_rank_desc(&removed).into_iter().take(missing));
    }

    let ranked = sort_by_rank_desc(&kept);

    match (landscape, ranked.as_slice()) {
        (false, [first, second, third, ..]) => {
            let mut frames = [first.clone(), second.clone(), third.clone()];

            frames.sort_by(|a, b| {
                a.timestamp()
                    .partial_cmp(&b.timestamp())
                    .unwrap_or(Ordering::Equal)
            });

            ThumbnailLayout::Triple { frames, ranked }
        }
        // Landscape, or not enough frames for a grid: single frame (the PHP fall-back).
        (_, [first, ..]) => ThumbnailLayout::Single {
            frame: first.clone(),
            ranked,
        },
        (_, []) => ThumbnailLayout::None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmartCropPlan {
    pub axis: Option<Axis>,
    /// Excess pixels along the axis (0 when the scaled image already matches the canvas).
    pub max_offset: i64,
}

/// Axis and excess after scaling: x first, then y, else none (PHP `smartCropToCanvas`).
pub fn smart_crop_plan(
    scaled_width: i64,
    scaled_height: i64,
    canvas_width: i64,
    canvas_height: i64,
) -> SmartCropPlan {
    let excess_x = scaled_width - canvas_width;
    let excess_y = scaled_height - canvas_height;

    if excess_x > 0 {
        SmartCropPlan {
            axis: Some(Axis::X),
            max_offset: excess_x,
        }
    } else if excess_y > 0 {
        SmartCropPlan {
            axis: Some(Axis::Y),
            max_offset: excess_y,
        }
    } else {
        SmartCropPlan {
            axis: None,
            max_offset: 0,
        }
    }
}

/// The trial crop offsets `round(excess * i / 2)` for i = 0..2, de-duplicated (PHP uses
/// `(int) round()`; the spec text said floor). `[0]` when there is no excess.
pub fn smart_crop_offsets(excess: i64) -> Vec<i64> {
    if excess <= 0 {
        return vec![0];
    }

    let mut offsets: Vec<i64> = Vec::new();

    for i in 0..SMART_CROP_WINDOW_COUNT {
        let offset =
            js_round((excess as f64 * i as f64) / (SMART_CROP_WINDOW_COUNT - 1) as f64) as i64;

        if !offsets.contains(&offset) {
            offsets.push(offset);
        }
    }

    offsets
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffsetScore {
    pub offset: i64,
    /// Detail score of the trial crop; `None` when the crop or the measurement failed.
    pub score: Option<f64>,
}

/// The offset with the highest detail score (first wins on ties, `None`s skipped). When no trial
/// produced a score, the centre `round(max_offset / 2)` is used, like PHP.
pub fn pick_best_offset(scores: &[OffsetScore], max_offset: i64) -> i64 {
    let mut best: Option<(i64, f64)> = None;

    for entry in scores {
        if let Some(score) = entry.score {
            match best {
                Some((_, best_score)) if score <= best_score => {}
                _ => best = Some((entry.offset, score)),
            }
        }
    }

    best.map_or_else(
        || js_round(max_offset as f64 / 2.0) as i64,
        |(offset, _)| offset,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(timestamp: f64, saturation: Option<f64>, detail: Option<f64>) -> ScoredFrame {
        ScoredFrame {
            timestamp,
            saturation,
            detail,
        }
    }

    fn f(timestamp: f64, saturation: f64, detail: f64) -> ScoredFrame {
        frame(timestamp, Some(saturation), Some(detail))
    }

    #[test]
    fn short_videos() {
        for (duration, expected) in [
            (None, true),
            (Some(0.0), true),
            (Some(2.99), true),
            (Some(3.0), false),
            (Some(120.0), false),
        ] {
            assert_eq!(is_short_video(duration), expected, "{duration:?}");
        }

        assert_eq!(short_video_timestamp(Some(2.0)), 1.0);
        assert_eq!(short_video_timestamp(None), 0.0);
    }

    #[test]
    fn samples_25_50_75_percent_and_the_10_90_percent_extras() {
        let plan = candidate_timestamps(100.0);

        assert_eq!(plan.initial, vec![25.0, 50.0, 75.0]);
        assert_eq!(plan.extras, vec![10.0, 90.0]);
    }

    #[test]
    fn clamps_to_duration_minus_half_a_second() {
        let plan = candidate_timestamps(3.0);

        assert_eq!(plan.initial, vec![0.75, 1.5, 2.25]);
        assert_eq!(plan.extras[1], 2.5);
    }

    #[test]
    fn candidate_timestamps_never_go_negative() {
        assert!(candidate_timestamps(3.0).extras.iter().all(|t| *t >= 0.0));
        assert!(candidate_timestamps(0.2).initial.iter().all(|t| *t >= 0.0));
    }

    #[test]
    fn is_removed_table() {
        for (saturation, detail, expected) in [
            (None, Some(10.0), true),
            (Some(4.99), Some(10.0), true),
            (Some(5.0), Some(3.0), false),
            (Some(5.0), Some(2.99), true),
            (Some(5.0), None, false),
            (Some(50.0), None, false),
            (Some(0.0), None, true),
        ] {
            assert_eq!(
                is_removed(saturation, detail),
                expected,
                "{saturation:?} {detail:?}"
            );
        }
    }

    #[test]
    fn ranks_saturation_plus_5_x_detail_with_missing_scores_as_0() {
        assert_eq!(rank(Some(10.0), Some(4.0)), 30.0);
        assert_eq!(rank(None, Some(2.0)), 10.0);
        assert_eq!(rank(Some(7.0), None), 7.0);
        assert_eq!(rank(None, None), 0.0);
    }

    #[test]
    fn needs_an_extra_candidate_until_3_frames_pass_the_filter() {
        let good = f(1.0, 20.0, 10.0);
        let bad = f(2.0, 1.0, 1.0);

        assert!(needs_extra_candidate::<ScoredFrame>(&[]));
        assert!(needs_extra_candidate(&[good, good, bad]));
        assert!(!needs_extra_candidate(&[good, good, good]));
        assert!(!needs_extra_candidate(&[good, good, good, bad]));
    }

    #[test]
    fn landscape_table() {
        for (w, h, expected) in [
            (Some(1920), Some(1080), true),
            (Some(1080), Some(1920), false),
            (Some(1000), Some(1000), false),
            (Some(1), Some(1), false),
            (None, Some(10), false),
            (Some(10), None, false),
        ] {
            assert_eq!(is_landscape(w, h), expected, "{w:?}x{h:?}");
        }
    }

    #[test]
    fn no_layout_without_candidates() {
        assert_eq!(
            choose_thumbnail_layout::<ScoredFrame>(&[], true),
            ThumbnailLayout::None
        );
        assert_eq!(
            choose_thumbnail_layout::<ScoredFrame>(&[], false),
            ThumbnailLayout::None
        );
    }

    #[test]
    fn landscape_uses_the_best_ranked_kept_frame() {
        let a = f(10.0, 10.0, 4.0); // 30
        let b = f(20.0, 30.0, 4.0); // 50
        let c = f(30.0, 20.0, 4.0); // 40

        assert_eq!(
            choose_thumbnail_layout(&[a, b, c], true),
            ThumbnailLayout::Single {
                frame: b,
                ranked: vec![b, c, a]
            }
        );
    }

    #[test]
    fn landscape_with_only_removed_candidates_uses_the_best_removed_one() {
        let a = f(10.0, 1.0, 1.0);
        let b = f(20.0, 4.0, 2.0);

        assert_eq!(
            choose_thumbnail_layout(&[a, b], true),
            ThumbnailLayout::Single {
                frame: b,
                ranked: vec![b]
            }
        );
    }

    #[test]
    fn portrait_uses_the_3_best_frames_sorted_by_timestamp() {
        let f1 = f(10.0, 10.0, 4.0); // 30
        let f2 = f(20.0, 40.0, 4.0); // 60
        let f3 = f(30.0, 20.0, 4.0); // 40
        let f4 = f(40.0, 15.0, 4.0); // 35

        assert_eq!(
            choose_thumbnail_layout(&[f1, f2, f3, f4], false),
            ThumbnailLayout::Triple {
                frames: [f2, f3, f4],
                ranked: vec![f2, f3, f4, f1]
            }
        );
    }

    #[test]
    fn portrait_tops_up_from_the_best_removed_frames() {
        let good1 = f(50.0, 20.0, 4.0);
        let good2 = f(10.0, 10.0, 4.0);
        let removed_low = f(20.0, 2.0, 1.0);
        let removed_high = f(30.0, 4.0, 2.5); // rank 16.5

        match choose_thumbnail_layout(&[good1, good2, removed_low, removed_high], false) {
            ThumbnailLayout::Triple { frames, .. } => {
                assert_eq!(frames, [good2, removed_high, good1]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn portrait_with_fewer_than_3_candidates_falls_back_to_a_single_frame() {
        let a = f(10.0, 20.0, 4.0);
        let b = f(20.0, 30.0, 4.0);

        assert_eq!(
            choose_thumbnail_layout(&[a, b], false),
            ThumbnailLayout::Single {
                frame: b,
                ranked: vec![b, a]
            }
        );
    }

    #[test]
    fn square_videos_are_not_landscape_and_use_the_grid() {
        let frames = [f(1.0, 10.0, 4.0), f(2.0, 10.0, 4.0), f(3.0, 10.0, 4.0)];

        assert!(matches!(
            choose_thumbnail_layout(&frames, is_landscape(Some(1), Some(1))),
            ThumbnailLayout::Triple { .. }
        ));
    }

    #[test]
    fn keeps_input_order_on_rank_ties() {
        let a = f(30.0, 10.0, 4.0);
        let b = f(10.0, 10.0, 4.0);
        let c = f(20.0, 10.0, 4.0);

        assert_eq!(
            choose_thumbnail_layout(&[a, b, c], true),
            ThumbnailLayout::Single {
                frame: a,
                ranked: vec![a, b, c]
            }
        );
    }

    #[test]
    fn keeps_kept_frames_ahead_of_topped_up_ones_on_equal_rank() {
        let kept = f(10.0, 20.0, 4.0); // 40
        let removed = f(20.0, 40.0, 0.0); // 40, removed (detail < 3)

        match choose_thumbnail_layout(&[removed, kept], true) {
            ThumbnailLayout::Single { frame, .. } => assert_eq!(frame, kept),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn smart_crop_offsets_table() {
        for (excess, expected) in [
            (0, vec![0]),
            (-4, vec![0]),
            (1, vec![0, 1]), // round(0.5) = 1, round(1) = 1 -> unique [0, 1]
            (2, vec![0, 1, 2]),
            (3, vec![0, 2, 3]), // round(1.5) = 2
            (5, vec![0, 3, 5]), // round(2.5) = 3
            (720, vec![0, 360, 720]),
        ] {
            assert_eq!(smart_crop_offsets(excess), expected, "excess {excess}");
        }
    }

    #[test]
    fn smart_crop_chooses_the_axis_with_excess_x_first() {
        let plan = |axis, max_offset| SmartCropPlan { axis, max_offset };

        assert_eq!(
            smart_crop_plan(1920, 1080, 1080, 1080),
            plan(Some(Axis::X), 840)
        );
        assert_eq!(
            smart_crop_plan(1080, 1920, 1080, 1080),
            plan(Some(Axis::Y), 840)
        );
        assert_eq!(smart_crop_plan(1080, 1080, 1080, 1080), plan(None, 0));
        assert_eq!(
            smart_crop_plan(1500, 1200, 1080, 1080),
            plan(Some(Axis::X), 420)
        );
    }

    #[test]
    fn picks_the_highest_detail_offset_first_on_ties() {
        let scores = [
            OffsetScore {
                offset: 0,
                score: Some(4.0),
            },
            OffsetScore {
                offset: 5,
                score: Some(9.0),
            },
            OffsetScore {
                offset: 10,
                score: Some(9.0),
            },
        ];

        assert_eq!(pick_best_offset(&scores, 10), 5);
    }

    #[test]
    fn skips_unscored_offsets_and_falls_back_to_the_centre() {
        let unscored = OffsetScore {
            offset: 0,
            score: None,
        };

        assert_eq!(
            pick_best_offset(
                &[
                    unscored,
                    OffsetScore {
                        offset: 5,
                        score: Some(1.0)
                    }
                ],
                10
            ),
            5
        );
        assert_eq!(pick_best_offset(&[unscored], 11), 6);
        assert_eq!(pick_best_offset(&[], 0), 0);
    }
}
