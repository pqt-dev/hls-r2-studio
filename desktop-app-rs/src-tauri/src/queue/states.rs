//! Job state groups and the translation key of each state label (port of
//! desktop-app/src/main/queue/jobStates.ts).

use crate::dto::JobState;

/// A pipeline / register / resume call may be in flight for a job in one of these states.
pub fn is_running_state(state: JobState) -> bool {
    matches!(
        state,
        JobState::Transcoding
            | JobState::Thumbnail
            | JobState::Storyboard
            | JobState::Uploading
            | JobState::Registering
    )
}

/// Terminal states: the job can be removed from the list (and retried, except `done`).
pub fn is_final_state(state: JobState) -> bool {
    matches!(
        state,
        JobState::Done | JobState::Failed | JobState::Cancelled | JobState::Interrupted
    )
}

/// Files are on R2 but registering did not finish.
pub fn is_attention_state(state: JobState) -> bool {
    matches!(state, JobState::RegisterFailed | JobState::NeedsSignIn)
}

/// Upload paused: temp files are kept on disk until Resume / Start over / Remove.
pub fn is_paused_upload(state: JobState) -> bool {
    state == JobState::UploadInterrupted
}

/// `RETRYABLE_STATES`.
pub fn is_retryable_state(state: JobState) -> bool {
    matches!(
        state,
        JobState::Failed | JobState::Cancelled | JobState::Interrupted
    )
}

/// The TS state string (`'upload_interrupted'`, ...).
pub fn state_name(state: JobState) -> &'static str {
    match state {
        JobState::Waiting => "waiting",
        JobState::Transcoding => "transcoding",
        JobState::Thumbnail => "thumbnail",
        JobState::Storyboard => "storyboard",
        JobState::Uploading => "uploading",
        JobState::Registering => "registering",
        JobState::Done => "done",
        JobState::Failed => "failed",
        JobState::Cancelled => "cancelled",
        JobState::Interrupted => "interrupted",
        JobState::RegisterFailed => "register_failed",
        JobState::NeedsSignIn => "needs_sign_in",
        JobState::UploadInterrupted => "upload_interrupted",
    }
}

/// `STAGE_KEYS[state]`, e.g. `job.state.uploading`.
pub fn stage_key(state: JobState) -> String {
    format!("job.state.{}", state_name(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [JobState; 13] = [
        JobState::Waiting,
        JobState::Transcoding,
        JobState::Thumbnail,
        JobState::Storyboard,
        JobState::Uploading,
        JobState::Registering,
        JobState::Done,
        JobState::Failed,
        JobState::Cancelled,
        JobState::Interrupted,
        JobState::RegisterFailed,
        JobState::NeedsSignIn,
        JobState::UploadInterrupted,
    ];

    #[test]
    fn state_names_match_the_serialized_dto_values() {
        for state in ALL {
            assert_eq!(
                serde_json::to_value(state).unwrap(),
                serde_json::json!(state_name(state))
            );
            assert_eq!(stage_key(state), format!("job.state.{}", state_name(state)));
        }
    }

    #[test]
    fn groups_match_the_ts_lists() {
        let running: Vec<_> = ALL.into_iter().filter(|s| is_running_state(*s)).collect();
        let fin: Vec<_> = ALL.into_iter().filter(|s| is_final_state(*s)).collect();
        let attention: Vec<_> = ALL.into_iter().filter(|s| is_attention_state(*s)).collect();
        let retry: Vec<_> = ALL.into_iter().filter(|s| is_retryable_state(*s)).collect();

        assert_eq!(running.len(), 5);
        assert_eq!(
            fin,
            [
                JobState::Done,
                JobState::Failed,
                JobState::Cancelled,
                JobState::Interrupted
            ]
        );
        assert_eq!(attention, [JobState::RegisterFailed, JobState::NeedsSignIn]);
        assert_eq!(
            retry,
            [JobState::Failed, JobState::Cancelled, JobState::Interrupted]
        );
        assert!(is_paused_upload(JobState::UploadInterrupted));
        assert!(!is_paused_upload(JobState::Uploading));
    }
}
