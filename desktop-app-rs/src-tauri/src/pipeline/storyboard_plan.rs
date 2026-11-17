//! Pure planning for the storyboard step (port of storyboardPlan.ts, itself a port of
//! StoryboardGenerator).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::file_names::{storyboard_file_name, tile_sequence_pattern};
use super::thumbnail_plan::{is_frame_removed, rank_frame, Scored};

pub const STORYBOARD_GRID_SIZES: [u32; 3] = [3, 4, 5];
pub use crate::ffmpeg::args::STORYBOARD_TILE_SIZE;
pub const CANDIDATES_PER_SLOT: u32 = 3;
pub const SCORING_CONCURRENCY: usize = 4;

const LARGEST_GRID: u32 = 5;

/// 3 x 5 x 5 = 75 candidates extracted in one decode pass.
pub const TOTAL_CANDIDATES: u32 = CANDIDATES_PER_SLOT * LARGEST_GRID * LARGEST_GRID;

/// One entry of the register `storyboards` map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoryboardEntry {
    pub path: String,
}

/// Source timestamp of candidate `index`: `index * duration / 75` (the fps filter's spacing).
pub fn candidate_timestamp(index: usize, duration: f64) -> f64 {
    (index as f64 * duration) / f64::from(TOTAL_CANDIDATES)
}

/// Pixel size (width = height) of the finished grid image, e.g. 3 -> 480.
pub fn grid_pixel_size(grid_size: u32) -> u32 {
    grid_size * STORYBOARD_TILE_SIZE
}

/// Frame names `tile_NxN_0000.jpg`, ... in slot order.
pub fn tile_file_names(grid_size: u32) -> Vec<String> {
    (0..grid_size * grid_size)
        .map(|slot| tile_sequence_pattern(grid_size).replace("%04d", &format!("{slot:04}")))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoCandidates;

impl std::fmt::Display for NoCandidates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("No storyboard candidate frames are available for any tile slot.")
    }
}

impl std::error::Error for NoCandidates {}

/// Picks one candidate per slot of a `grid_size` x `grid_size` grid:
/// - the duration is split into N*N equal slots, a candidate belongs to `floor(ts / slotLength)`
///   (clamped to the valid range);
/// - a slot takes its best-ranked candidate that passes the filter, else its best-ranked overall;
/// - an empty slot reuses the nearest slot that genuinely had candidates, searching outwards and
///   checking the earlier slot (index - d) before the later one (index + d).
///
/// Ties keep the earlier candidate (stable sort, like PHP 8 usort). Fails when no candidate
/// exists at all.
pub fn assign_slots<T: Scored + Clone>(
    grid_size: u32,
    candidates: &[T],
    duration: f64,
) -> Result<Vec<T>, NoCandidates> {
    let total_tiles = (grid_size * grid_size) as usize;
    let slot_duration = duration / total_tiles as f64;
    let mut slots: Vec<Vec<&T>> = vec![Vec::new(); total_tiles];

    for candidate in candidates {
        let raw = (candidate.timestamp() / slot_duration).floor();

        // JS: a NaN index finds no slot and the candidate is dropped.
        if raw.is_nan() {
            continue;
        }

        let index = raw.clamp(0.0, (total_tiles - 1) as f64) as usize;

        slots[index].push(candidate);
    }

    let genuine: Vec<Option<&T>> = slots
        .iter()
        .map(|slot| {
            if slot.is_empty() {
                return None;
            }

            let passing: Vec<&T> = slot
                .iter()
                .copied()
                .filter(|c| !is_frame_removed(*c))
                .collect();
            let pool = if passing.is_empty() { slot } else { &passing };
            let mut best: Option<&T> = None;

            // First of the stable "rank descending" order: the earliest among the highest rank.
            for candidate in pool {
                match best {
                    Some(b) if rank_frame(*candidate) <= rank_frame(b) => {}
                    _ => best = Some(candidate),
                }
            }

            best
        })
        .collect();

    (0..total_tiles)
        .map(|slot_index| {
            genuine[slot_index]
                .or_else(|| nearest_chosen(&genuine, slot_index))
                .cloned()
                .ok_or(NoCandidates)
        })
        .collect()
}

fn nearest_chosen<'a, T>(chosen: &[Option<&'a T>], slot_index: usize) -> Option<&'a T> {
    for distance in 1..chosen.len() {
        let earlier = slot_index.checked_sub(distance).and_then(|i| chosen[i]);

        if earlier.is_some() {
            return earlier;
        }

        if let Some(Some(later)) = chosen.get(slot_index + distance) {
            return Some(*later);
        }
    }

    None
}

/// The `storyboards` register field: grids that produced a file, or `None` when none did.
pub fn storyboard_json(
    existing_grids: &[u32],
    prefix: &str,
) -> Option<BTreeMap<String, StoryboardEntry>> {
    let mut result = BTreeMap::new();

    for size in STORYBOARD_GRID_SIZES {
        if existing_grids.contains(&size) {
            result.insert(
                format!("{size}x{size}"),
                StoryboardEntry {
                    path: format!("{prefix}{}", storyboard_file_name(size)),
                },
            );
        }
    }

    (!result.is_empty()).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::thumbnail_plan::ScoredFrame;

    #[derive(Debug, Clone, Copy, PartialEq)]
    struct Candidate {
        id: usize,
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

    fn make_candidates(
        duration: f64,
        scores: impl Fn(usize) -> (Option<f64>, Option<f64>),
    ) -> Vec<Candidate> {
        (0..TOTAL_CANDIDATES as usize)
            .map(|id| {
                let (saturation, detail) = scores(id);

                Candidate {
                    id,
                    timestamp: candidate_timestamp(id, duration),
                    saturation,
                    detail,
                }
            })
            .collect()
    }

    fn only(timestamp: f64, id: usize) -> Candidate {
        Candidate {
            id,
            timestamp,
            saturation: Some(10.0),
            detail: Some(4.0),
        }
    }

    fn ids(chosen: &[Candidate]) -> Vec<usize> {
        chosen.iter().map(|c| c.id).collect()
    }

    #[test]
    fn extracts_75_candidates_matching_the_ffmpeg_layer() {
        assert_eq!(TOTAL_CANDIDATES, 75);
        assert_eq!(
            TOTAL_CANDIDATES,
            crate::ffmpeg::args::STORYBOARD_TOTAL_CANDIDATES
        );
    }

    #[test]
    fn spaces_candidates_evenly_over_the_duration() {
        assert_eq!(candidate_timestamp(0, 150.0), 0.0);
        assert_eq!(candidate_timestamp(1, 150.0), 2.0);
        assert!((candidate_timestamp(74, 150.0) - 148.0).abs() < 1e-10);
    }

    #[test]
    fn computes_grid_pixel_sizes() {
        assert_eq!(STORYBOARD_GRID_SIZES.map(grid_pixel_size), [480, 640, 800]);
    }

    #[test]
    fn lists_tile_names_in_slot_order() {
        let names = tile_file_names(3);

        assert_eq!(names.len(), 9);
        assert_eq!(names[0], "tile_3x3_0000.jpg");
        assert_eq!(names[8], "tile_3x3_0008.jpg");
        assert_eq!(tile_file_names(5)[24], "tile_5x5_0024.jpg");
    }

    #[test]
    fn gives_every_slot_of_a_5x5_grid_its_own_3_candidates_and_picks_the_best() {
        let duration = 150.0;
        // Within each group of 3 consecutive candidates the middle one is the best.
        let candidates = make_candidates(duration, |i| {
            if i % 3 == 1 {
                (Some(30.0), Some(10.0))
            } else {
                (Some(10.0), Some(4.0))
            }
        });
        let chosen = assign_slots(5, &candidates, duration).unwrap();

        assert_eq!(
            ids(&chosen),
            (0..25).map(|slot| slot * 3 + 1).collect::<Vec<_>>()
        );
    }

    #[test]
    fn prefers_a_passing_candidate_over_a_higher_ranked_removed_one() {
        let duration = 150.0;
        // Slot 0 of a 3x3 grid has candidates 0..7 (75 / 9 = 8.33 per slot).
        let candidates = make_candidates(duration, |i| match i {
            2 => (Some(100.0), Some(1.0)), // detail < 3 -> removed, but a huge rank (105)
            4 => (Some(10.0), Some(4.0)),  // passing, rank 30
            _ => (None, None),
        });

        assert_eq!(assign_slots(3, &candidates, duration).unwrap()[0].id, 4);
    }

    #[test]
    fn uses_the_best_overall_candidate_when_none_of_the_slot_passes() {
        let duration = 90.0;
        let candidates = make_candidates(duration, |i| {
            if i == 3 {
                (Some(4.0), Some(10.0))
            } else {
                (None, None)
            }
        });

        assert_eq!(assign_slots(3, &candidates, duration).unwrap()[0].id, 3);
    }

    #[test]
    fn keeps_the_earliest_candidate_on_rank_ties() {
        let duration = 90.0;
        let candidates = make_candidates(duration, |_| (Some(10.0), Some(4.0)));
        let chosen = assign_slots(3, &candidates, duration).unwrap();

        assert_eq!(ids(&chosen), vec![0, 9, 17, 25, 34, 42, 50, 59, 67]);
    }

    #[test]
    fn fills_an_empty_slot_from_the_nearest_genuine_slot() {
        // 3x3: slot length 10 s. Slots 1 (ts 15) and 5 (ts 55) have candidates.
        let chosen = assign_slots(3, &[only(15.0, 1), only(55.0, 5)], 90.0).unwrap();

        assert_eq!(ids(&chosen), vec![1, 1, 1, 1, 5, 5, 5, 5, 5]);
    }

    #[test]
    fn prefers_the_earlier_slot_when_two_filled_slots_are_equally_near() {
        // Slots 0 and 2 filled, slot 1 empty (distance 1 on both sides -> earlier slot 0).
        let chosen = assign_slots(3, &[only(1.0, 10), only(25.0, 20)], 90.0).unwrap();

        assert_eq!(chosen[1].id, 10);
    }

    #[test]
    fn fills_from_genuine_slots_only_not_from_earlier_fills() {
        // Only slot 8 (ts 85) has data: every other slot reuses it.
        let chosen = assign_slots(3, &[only(85.0, 7)], 90.0).unwrap();

        assert_eq!(chosen.len(), 9);
        assert!(chosen.iter().all(|c| c.id == 7));
    }

    #[test]
    fn clamps_candidates_at_or_past_the_duration_to_the_last_slot() {
        let chosen = assign_slots(3, &[only(90.0, 1)], 90.0).unwrap();

        assert_eq!(chosen.len(), 9);
        assert_eq!(chosen[8].id, 1);
    }

    #[test]
    fn fails_when_there_are_no_candidates_at_all() {
        let error = assign_slots::<ScoredFrame>(3, &[], 60.0).unwrap_err();

        assert!(error.to_string().contains("No storyboard candidate frames"));
    }

    #[test]
    fn storyboard_json_lists_only_the_grids_that_exist_in_size_order() {
        let prefix = "2026/01/02/clip-ab12cd34ef56/";
        let json = storyboard_json(&[5, 3], prefix).unwrap();

        assert_eq!(json.len(), 2);
        assert_eq!(json["3x3"].path, format!("{prefix}storyboard_3x3.jpg"));
        assert_eq!(json["5x5"].path, format!("{prefix}storyboard_5x5.jpg"));
        assert_eq!(
            storyboard_json(&[5, 4, 3], prefix)
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["3x3", "4x4", "5x5"]
        );
    }

    #[test]
    fn storyboard_json_is_none_when_no_grid_exists() {
        let prefix = "2026/01/02/clip-ab12cd34ef56/";

        assert_eq!(storyboard_json(&[], prefix), None);
        assert_eq!(storyboard_json(&[2, 6], prefix), None);
    }
}
