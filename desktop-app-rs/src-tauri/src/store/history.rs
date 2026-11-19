//! History cap. Port of desktop-app/src/main/store/history.ts.

use crate::dto::JobState;

use super::model::JobRecord;

pub const MAX_DONE_HISTORY: usize = 200;

/// Keeps every job that is not `done` and at most `max` of the most recent `done` jobs
/// (the slice is in creation order, oldest first). Order is preserved.
pub fn cap_history(jobs: &[JobRecord], max: usize) -> Vec<JobRecord> {
    let mut done_seen = 0usize;
    let mut keep = vec![true; jobs.len()];

    for (i, job) in jobs.iter().enumerate().rev() {
        if job.state == JobState::Done {
            done_seen += 1;
            if done_seen > max {
                keep[i] = false;
            }
        }
    }

    jobs.iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(job, _)| job.clone())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests_support {
    use serde_json::{Map, Number};

    use super::*;

    pub(crate) fn job(id: &str, state: JobState) -> JobRecord {
        JobRecord {
            id: id.into(),
            source_path: format!("/v/{id}.mp4"),
            size_bytes: Number::from(1),
            state,
            public_id: None,
            prefix: None,
            error_message: None,
            error_detail: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            started_at: None,
            finished_at: None,
            site_origin: None,
            register_payload: None,
            tmp_dir: None,
            register_started: None,
            mode: None,
            registered: None,
            thumbnail_url: None,
            extra: Map::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::job;
    use super::*;

    fn ids(jobs: &[JobRecord]) -> Vec<&str> {
        jobs.iter().map(|j| j.id.as_str()).collect()
    }

    #[test]
    fn keeps_everything_under_the_cap() {
        let jobs = vec![job("a", JobState::Done), job("b", JobState::Failed)];

        assert_eq!(cap_history(&jobs, 5), jobs);
    }

    #[test]
    fn drops_the_oldest_done_jobs_beyond_the_cap_and_keeps_order() {
        let jobs: Vec<_> = ["1", "2", "3", "4"]
            .iter()
            .map(|id| job(id, JobState::Done))
            .collect();

        assert_eq!(ids(&cap_history(&jobs, 2)), ["3", "4"]);
    }

    #[test]
    fn never_drops_non_done_jobs() {
        let jobs = vec![
            job("1", JobState::Done),
            job("2", JobState::Failed),
            job("3", JobState::Waiting),
            job("4", JobState::Done),
            job("5", JobState::Transcoding),
        ];

        assert_eq!(ids(&cap_history(&jobs, 1)), ["2", "3", "4", "5"]);
    }

    #[test]
    fn defaults_to_200_done_entries() {
        let jobs: Vec<_> = (0..250)
            .map(|i| job(&i.to_string(), JobState::Done))
            .collect();
        let capped = cap_history(&jobs, MAX_DONE_HISTORY);

        assert_eq!(capped.len(), 200);
        assert_eq!(capped[0].id, "50");
    }

    #[test]
    fn does_not_mutate_the_input() {
        let jobs = vec![job("1", JobState::Done), job("2", JobState::Done)];
        cap_history(&jobs, 1);

        assert_eq!(jobs.len(), 2);
    }
}
