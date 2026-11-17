//! Local-only overall progress model (spec 4.4): weighted stages that never go backwards.
//! Port of progressModel.ts.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineStage {
    Transcoding,
    Thumbnail,
    Storyboard,
    Upload,
    Register,
}

pub const STAGE_ORDER: [PipelineStage; 5] = [
    PipelineStage::Transcoding,
    PipelineStage::Thumbnail,
    PipelineStage::Storyboard,
    PipelineStage::Upload,
    PipelineStage::Register,
];

pub fn stage_weight(stage: PipelineStage) -> u32 {
    match stage {
        PipelineStage::Transcoding => 70,
        PipelineStage::Thumbnail => 3,
        PipelineStage::Storyboard => 7,
        PipelineStage::Upload => 18,
        PipelineStage::Register => 2,
    }
}

/// Whole-number overall percent (0-100): the weights of the finished stages plus the current
/// stage's share. `stage_fraction` is clamped to [0, 1] (NaN counts as 0); the result is floored
/// and never lower than `previous`, so only a fully completed register stage reaches 100.
pub fn overall_progress(stage: PipelineStage, stage_fraction: f64, previous: u32) -> u32 {
    let fraction = if stage_fraction.is_finite() {
        stage_fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut percent = 0.0;

    for name in STAGE_ORDER {
        if name == stage {
            percent += f64::from(stage_weight(name)) * fraction;
            break;
        }

        percent += f64::from(stage_weight(name));
    }

    previous.max(((percent + 1e-9).floor() as u32).min(100))
}

#[cfg(test)]
mod tests {
    use super::*;
    use PipelineStage::*;

    #[test]
    fn weights_sum_to_100() {
        assert_eq!(
            STAGE_ORDER.iter().map(|s| stage_weight(*s)).sum::<u32>(),
            100
        );
    }

    #[test]
    fn stage_table() {
        for (stage, fraction, expected) in [
            (Transcoding, 0.0, 0),
            (Transcoding, 0.5, 35),
            (Transcoding, 1.0, 70),
            (Thumbnail, 0.0, 70),
            (Thumbnail, 1.0, 73),
            (Storyboard, 0.0, 73),
            (Storyboard, 1.0, 80),
            (Upload, 0.0, 80),
            (Upload, 0.5, 89),
            (Upload, 1.0, 98),
            (Register, 0.0, 98),
            (Register, 0.5, 99),
            (Register, 1.0, 100),
        ] {
            assert_eq!(
                overall_progress(stage, fraction, 0),
                expected,
                "{stage:?} at {fraction}"
            );
        }
    }

    #[test]
    fn floors_so_100_is_only_reached_when_register_is_complete() {
        assert_eq!(overall_progress(Register, 0.99, 0), 99);
        assert_eq!(overall_progress(Transcoding, 0.999, 0), 69);
    }

    #[test]
    fn never_decreases() {
        assert_eq!(overall_progress(Transcoding, 0.1, 50), 50);
        assert_eq!(overall_progress(Upload, 0.2, 60), 83);
    }

    #[test]
    fn clamps_and_sanitizes_the_stage_fraction() {
        assert_eq!(overall_progress(Transcoding, 5.0, 0), 70);
        assert_eq!(overall_progress(Transcoding, -1.0, 0), 0);
        assert_eq!(overall_progress(Transcoding, f64::NAN, 10), 10);
        assert_eq!(overall_progress(Transcoding, f64::INFINITY, 0), 0);
    }

    #[test]
    fn is_monotonic_over_a_simulated_run() {
        let mut previous = 0;

        for stage in STAGE_ORDER {
            for i in 0..=20 {
                let next = overall_progress(stage, f64::from(i) / 20.0, previous);

                assert!(next >= previous);
                previous = next;
            }
        }

        assert_eq!(previous, 100);
    }
}
