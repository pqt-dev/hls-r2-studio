//! The local activity log of a job ("behind the scenes" lines shown in the Queue "View
//! details" dialog). This module is the ONLY place that owns the English texts and decides when
//! a line is written; the queue only reports events (`ActivityEvent`) from inside the store
//! mutation it already performs for the state change, so no extra write is ever scheduled.
//!
//! Local only: nothing here calls the site. Texts never contain a path (only what the caller
//! passes as a message, which is redacted here again).

use super::states::{is_final_state, is_paused_upload};
use crate::dto::{ActivityEntryDto, ActivityLevel, JobState};
use crate::logger::{redact_string, RedactOptions};
use crate::pipeline::progress_model::{stage_weight, PipelineStage};
use crate::store::{ActivityEntry, JobRecord};

/// Lines kept per job; the oldest are dropped first.
pub const MAX_ACTIVITY: usize = 200;
/// Longest message copied into a line (characters).
const MAX_MESSAGE_CHARS: usize = 500;

pub const ADDED: &str = "Added to the queue";
pub const START_TRANSCODING: &str = "Start transcoding\u{2026}";

/// Something that happened to a job and may deserve a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityEvent<'a> {
    /// The job state moves from `from` to `to` (a pipeline step starts / the previous one ends).
    Transition {
        from: JobState,
        to: JobState,
    },
    /// The progress of a stage crossed this 10% mark (10..=90).
    Mark(MarkKind, u32),
    /// The user asked to resume a paused upload.
    ResumeRequested,
    /// The paused upload actually starts again.
    Resuming,
    /// The kept files could not be used; the job is processed again from the start.
    ResumeUnavailable,
    /// The user asked to retry (`paused`: the job was a paused upload, i.e. "Start over").
    RetryRequested {
        paused: bool,
    },
    NetworkWait,
    NetworkRestored,
    /// Cancelling a register retry only stopped that attempt.
    RegisterCancelled,
    Done,
    /// The job (or run) ended in `state`; `message` is the stored, user-facing reason.
    Ended {
        state: JobState,
        message: Option<&'a str>,
    },
}

/// A stage whose progress is logged at 10% marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkKind {
    Transcode,
    Upload,
}

impl MarkKind {
    pub const ALL: [MarkKind; 2] = [MarkKind::Transcode, MarkKind::Upload];

    /// The job state in which the marks of this stage are written.
    fn state(self) -> JobState {
        match self {
            MarkKind::Transcode => JobState::Transcoding,
            MarkKind::Upload => JobState::Uploading,
        }
    }

    /// The stage and the stages before it (their weights give where the stage starts inside the
    /// overall progress).
    fn stages(self) -> (&'static [PipelineStage], PipelineStage) {
        match self {
            MarkKind::Transcode => (&[], PipelineStage::Transcoding),
            MarkKind::Upload => (
                &[
                    PipelineStage::Transcoding,
                    PipelineStage::Thumbnail,
                    PipelineStage::Storyboard,
                ],
                PipelineStage::Upload,
            ),
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            MarkKind::Transcode => "Transcoding: ",
            MarkKind::Upload => "Uploading to R2: ",
        }
    }
}

/// A fresh log for a job that was just added.
pub fn initial(now: &str) -> Vec<ActivityEntry> {
    vec![entry(now, ActivityLevel::Info, ADDED.to_string())]
}

fn entry(now: &str, level: ActivityLevel, text: String) -> ActivityEntry {
    ActivityEntry {
        at: now.to_string(),
        level,
        text,
    }
}

fn start_text(state: JobState) -> Option<&'static str> {
    match state {
        JobState::Transcoding => Some(START_TRANSCODING),
        JobState::Thumbnail => Some("Start generating thumbnail\u{2026}"),
        JobState::Storyboard => Some("Start generating storyboard\u{2026}"),
        JobState::Uploading => Some("Start uploading to R2\u{2026}"),
        JobState::Registering => Some("Registering the video on the site\u{2026}"),
        _ => None,
    }
}

fn finish_text(state: JobState) -> Option<&'static str> {
    match state {
        JobState::Transcoding => Some("Transcode finished"),
        JobState::Thumbnail => Some("Thumbnail generated"),
        JobState::Storyboard => Some("Storyboard generated"),
        JobState::Uploading => Some("Upload to R2 finished"),
        _ => None,
    }
}

/// Lines of a state transition: the end of the step that was running, then the start of the new
/// one. Moving into the same state, or out of a non-step state (waiting, paused, attention),
/// only writes what applies.
pub fn transition_lines(from: JobState, to: JobState) -> Vec<&'static str> {
    if from == to {
        return Vec::new();
    }

    let mut lines = Vec::new();

    if let (Some(done), Some(_)) = (finish_text(from), start_text(to)) {
        lines.push(done);
    }

    if let Some(start) = start_text(to) {
        lines.push(start);
    }

    lines
}

fn clean(message: Option<&str>) -> Option<String> {
    let text = redact_string(message?.trim(), &RedactOptions::default());
    let text = text.trim();

    if text.is_empty() {
        return None;
    }

    Some(text.chars().take(MAX_MESSAGE_CHARS).collect())
}

fn with_reason(prefix: &str, message: Option<&str>) -> String {
    match clean(message) {
        Some(reason) => format!("{prefix}: {reason}"),
        None => prefix.to_string(),
    }
}

/// The line for a job that ended in `state`, or `None` for a state that is not an ending.
fn ended_line(state: JobState, message: Option<&str>) -> Option<(ActivityLevel, String)> {
    Some(match state {
        JobState::Failed => (ActivityLevel::Error, with_reason("Failed", message)),
        JobState::Cancelled => (ActivityLevel::Info, "Cancelled".to_string()),
        JobState::Interrupted => (ActivityLevel::Error, with_reason("Interrupted", message)),
        JobState::UploadInterrupted => (
            ActivityLevel::Error,
            with_reason("Upload interrupted", message),
        ),
        JobState::RegisterFailed => (
            ActivityLevel::Error,
            with_reason("Registering failed", message),
        ),
        JobState::NeedsSignIn => (
            ActivityLevel::Info,
            with_reason("Waiting for sign-in to finish registering", message),
        ),
        _ => return None,
    })
}

/// Appends `text` and drops the oldest lines beyond `MAX_ACTIVITY`.
fn push(job: &mut JobRecord, now: &str, level: ActivityLevel, text: String) {
    job.activity.push(entry(now, level, text));

    if job.activity.len() > MAX_ACTIVITY {
        let extra = job.activity.len() - MAX_ACTIVITY;

        job.activity.drain(..extra);
    }
}

/// Applies `event` to the job's log. Called inside the queue's existing store mutation.
pub fn record(job: &mut JobRecord, now: &str, event: ActivityEvent<'_>) {
    let info = ActivityLevel::Info;

    match event {
        ActivityEvent::Transition { from, to } => {
            for line in transition_lines(from, to) {
                push(job, now, info, line.to_string());
            }
        }
        ActivityEvent::Mark(kind, mark) => {
            if job.state == kind.state() && mark > logged_mark(kind, &job.activity) {
                push(job, now, info, format!("{}{mark}%", kind.prefix()));
            }
        }
        ActivityEvent::ResumeRequested => push(job, now, info, "Resume requested".into()),
        ActivityEvent::Resuming => push(job, now, info, "Resuming the upload".into()),
        ActivityEvent::ResumeUnavailable => push(
            job,
            now,
            info,
            "The saved upload files are no longer available: processing the video again".into(),
        ),
        ActivityEvent::RetryRequested { paused } => push(
            job,
            now,
            info,
            if paused {
                "Start over: processing the video again with a new video ID"
            } else {
                "Retry: processing the video again with a new video ID"
            }
            .into(),
        ),
        ActivityEvent::NetworkWait => push(
            job,
            now,
            info,
            "Waiting for the network to come back\u{2026}".into(),
        ),
        ActivityEvent::NetworkRestored => push(
            job,
            now,
            info,
            "The network is back: continuing the upload".into(),
        ),
        ActivityEvent::RegisterCancelled => {
            push(job, now, info, "Registering was cancelled".into());
        }
        ActivityEvent::Done => push(job, now, info, "Finished: the video is ready".into()),
        ActivityEvent::Ended { state, message } => {
            if let Some((level, text)) = ended_line(state, message) {
                push(job, now, level, text);
            }
        }
    }
}

/// The 10% mark (10..=90) that the overall progress `overall` has reached inside the stage of
/// `kind`, or `None` outside it / at 0-9% / at 100% (the end is the stage's "finished" line).
/// The stage spans `stage_weight(stage)` percent of the overall value starting at the weights of
/// the stages before it, so the stage percent is derived from it.
pub fn mark_of(kind: MarkKind, overall: u32) -> Option<u32> {
    let (before, stage) = kind.stages();
    let start: u32 = before.iter().copied().map(stage_weight).sum();
    let percent = overall.checked_sub(start)? * 100 / stage_weight(stage);
    let mark = percent / 10 * 10;

    (10..=90).contains(&mark).then_some(mark)
}

/// The highest mark of `kind` already written for the current processing attempt (0 = none).
/// Marks of an earlier attempt are not counted: an attempt starts at "Start transcoding…".
/// A resume continues the same attempt, so it never repeats a mark.
pub fn logged_mark(kind: MarkKind, activity: &[ActivityEntry]) -> u32 {
    for line in activity.iter().rev() {
        if line.text == START_TRANSCODING {
            break;
        }

        if let Some(mark) = line
            .text
            .strip_prefix(kind.prefix())
            .and_then(|rest| rest.strip_suffix('%'))
            .and_then(|n| n.parse::<u32>().ok())
        {
            return mark;
        }
    }

    0
}

fn dto(entry: &ActivityEntry) -> ActivityEntryDto {
    ActivityEntryDto {
        at: entry.at.clone(),
        level: entry.level,
        text: entry.text.clone(),
    }
}

/// The log shown to the renderer. A job stored before the log existed has none: a temporary
/// log is built from its timestamps and state (never written back to the store).
pub fn to_dto_entries(job: &JobRecord) -> Vec<ActivityEntryDto> {
    if !job.activity.is_empty() {
        return job.activity.iter().map(dto).collect();
    }

    let mut lines = vec![ActivityEntryDto {
        at: job.created_at.clone(),
        level: ActivityLevel::Info,
        text: ADDED.to_string(),
    }];

    if let Some(started) = &job.started_at {
        lines.push(ActivityEntryDto {
            at: started.clone(),
            level: ActivityLevel::Info,
            text: "Started".to_string(),
        });
    }

    let ending = if job.state == JobState::Done {
        Some((ActivityLevel::Info, "Finished".to_string()))
    } else {
        ended_line(job.state, job.error_message.as_deref())
    };
    let at = if is_final_state(job.state) {
        job.finished_at.as_ref()
    } else if is_paused_upload(job.state) || job.error_message.is_some() {
        Some(&job.updated_at)
    } else {
        None
    };

    if let (Some((level, text)), Some(at)) = (ending, at) {
        lines.push(ActivityEntryDto {
            at: at.clone(),
            level,
            text,
        });
    }

    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::history::tests_support::job;

    const NOW: &str = "2026-01-01T00:00:00.000Z";

    fn texts(job: &JobRecord) -> Vec<&str> {
        job.activity.iter().map(|l| l.text.as_str()).collect()
    }

    #[test]
    fn transitions_map_to_start_and_finish_lines() {
        use JobState::*;

        assert_eq!(
            transition_lines(Waiting, Transcoding),
            ["Start transcoding\u{2026}"]
        );
        assert_eq!(
            transition_lines(Transcoding, Thumbnail),
            ["Transcode finished", "Start generating thumbnail\u{2026}"]
        );
        assert_eq!(
            transition_lines(Thumbnail, Storyboard),
            ["Thumbnail generated", "Start generating storyboard\u{2026}"]
        );
        assert_eq!(
            transition_lines(Storyboard, Uploading),
            ["Storyboard generated", "Start uploading to R2\u{2026}"]
        );
        assert_eq!(
            transition_lines(Uploading, Registering),
            [
                "Upload to R2 finished",
                "Registering the video on the site\u{2026}"
            ]
        );
        // Same state, or no step before it: only what applies.
        assert!(transition_lines(Transcoding, Transcoding).is_empty());
        assert_eq!(
            transition_lines(RegisterFailed, Registering),
            ["Registering the video on the site\u{2026}"]
        );
        assert!(transition_lines(Uploading, Failed).is_empty());
    }

    #[test]
    fn upload_marks_are_derived_from_the_overall_progress() {
        assert_eq!(mark_of(MarkKind::Upload, 0), None);
        assert_eq!(mark_of(MarkKind::Upload, 80), None);
        assert_eq!(mark_of(MarkKind::Upload, 81), None);
        assert_eq!(mark_of(MarkKind::Upload, 82), Some(10));
        assert_eq!(mark_of(MarkKind::Upload, 89), Some(50));
        assert_eq!(mark_of(MarkKind::Upload, 97), Some(90));
        assert_eq!(mark_of(MarkKind::Upload, 98), None);

        // Walking the overall value through the stage reaches every mark exactly once.
        let mut seen = Vec::new();

        for overall in 80..=98 {
            if let Some(mark) = mark_of(MarkKind::Upload, overall) {
                if seen.last() != Some(&mark) {
                    seen.push(mark);
                }
            }
        }

        assert_eq!(seen, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    #[test]
    fn transcode_marks_are_derived_from_the_overall_progress() {
        let mark = |overall| mark_of(MarkKind::Transcode, overall);

        assert_eq!(mark(0), None);
        assert_eq!(mark(6), None);
        assert_eq!(mark(7), Some(10));
        assert_eq!(mark(35), Some(50));
        assert_eq!(mark(69), Some(90));
        assert_eq!(mark(70), None);
        assert_eq!(mark(97), None);

        let mut seen = Vec::new();

        for overall in 0..=100 {
            if let Some(m) = mark(overall) {
                if seen.last() != Some(&m) {
                    seen.push(m);
                }
            }
        }

        assert_eq!(seen, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    #[test]
    fn transcode_marks_are_written_once_per_attempt_and_only_while_transcoding() {
        let mut record = job("a", JobState::Transcoding);
        let mark = |job: &mut JobRecord, m| {
            super::record(job, NOW, ActivityEvent::Mark(MarkKind::Transcode, m));
        };

        record.activity = vec![entry(
            NOW,
            ActivityLevel::Info,
            START_TRANSCODING.to_string(),
        )];

        for m in [10, 10, 30, 20, 40] {
            mark(&mut record, m);
        }

        assert_eq!(
            texts(&record),
            [
                START_TRANSCODING,
                "Transcoding: 10%",
                "Transcoding: 30%",
                "Transcoding: 40%"
            ]
        );
        assert_eq!(logged_mark(MarkKind::Transcode, &record.activity), 40);
        // Upload marks are tracked separately.
        assert_eq!(logged_mark(MarkKind::Upload, &record.activity), 0);

        // A new attempt writes them again from the start.
        record_event(
            &mut record,
            ActivityEvent::Transition {
                from: JobState::Waiting,
                to: JobState::Transcoding,
            },
        );
        assert_eq!(logged_mark(MarkKind::Transcode, &record.activity), 0);
        mark(&mut record, 10);
        assert_eq!(texts(&record).last().copied(), Some("Transcoding: 10%"));

        // Outside the transcoding state a transcode mark is ignored.
        let mut other = job("b", JobState::Uploading);

        mark(&mut other, 50);
        assert!(other.activity.is_empty());
    }

    #[test]
    fn a_mark_is_written_once_and_never_again_after_a_resume() {
        let mut record = job("a", JobState::Uploading);

        record.activity = vec![entry(
            NOW,
            ActivityLevel::Info,
            START_TRANSCODING.to_string(),
        )];

        for mark in [10, 20, 20, 10, 30] {
            record_mark(&mut record, mark);
        }

        assert_eq!(
            texts(&record),
            [
                START_TRANSCODING,
                "Uploading to R2: 10%",
                "Uploading to R2: 20%",
                "Uploading to R2: 30%"
            ]
        );

        // A resume (same attempt) does not repeat what was logged.
        record.state = JobState::UploadInterrupted;
        record_event(&mut record, ActivityEvent::Resuming);
        record.state = JobState::Uploading;

        for mark in [20, 30, 40] {
            record_mark(&mut record, mark);
        }

        assert_eq!(logged_mark(MarkKind::Upload, &record.activity), 40);
        assert_eq!(texts(&record).last().copied(), Some("Uploading to R2: 40%"));
        assert_eq!(
            texts(&record).iter().filter(|t| t.ends_with("30%")).count(),
            1
        );

        // A new attempt (retry / start over) logs the marks again.
        record_event(
            &mut record,
            ActivityEvent::Transition {
                from: JobState::Waiting,
                to: JobState::Transcoding,
            },
        );
        assert_eq!(logged_mark(MarkKind::Upload, &record.activity), 0);
        record_mark(&mut record, 10);
        assert_eq!(texts(&record).last().copied(), Some("Uploading to R2: 10%"));
    }

    fn record_mark(job: &mut JobRecord, mark: u32) {
        record_event(job, ActivityEvent::Mark(MarkKind::Upload, mark));
    }

    fn record_event(job: &mut JobRecord, event: ActivityEvent<'_>) {
        super::record(job, NOW, event);
    }

    #[test]
    fn a_mark_outside_the_upload_state_is_ignored() {
        let mut record = job("a", JobState::Registering);

        record_mark(&mut record, 50);

        assert!(record.activity.is_empty());
    }

    #[test]
    fn the_log_is_capped_at_200_lines_dropping_the_oldest() {
        let mut record = job("a", JobState::Uploading);

        for i in 0..250 {
            push(&mut record, NOW, ActivityLevel::Info, format!("line {i}"));
        }

        assert_eq!(record.activity.len(), MAX_ACTIVITY);
        assert_eq!(record.activity[0].text, "line 50");
        assert_eq!(record.activity[199].text, "line 249");
    }

    #[test]
    fn endings_have_the_right_level_and_a_redacted_reason() {
        let mut record = job("a", JobState::Failed);

        record_event(
            &mut record,
            ActivityEvent::Ended {
                state: JobState::Failed,
                message: Some("ffmpeg stopped"),
            },
        );
        record_event(
            &mut record,
            ActivityEvent::Ended {
                state: JobState::Cancelled,
                message: Some("The job was cancelled."),
            },
        );
        record_event(
            &mut record,
            ActivityEvent::Ended {
                state: JobState::UploadInterrupted,
                message: Some("Upload stopped: the network was unavailable"),
            },
        );
        record_event(
            &mut record,
            ActivityEvent::Ended {
                state: JobState::Waiting,
                message: Some("ignored"),
            },
        );
        record_event(&mut record, ActivityEvent::Done);

        let lines: Vec<(ActivityLevel, &str)> = record
            .activity
            .iter()
            .map(|l| (l.level, l.text.as_str()))
            .collect();

        assert_eq!(
            lines,
            [
                (ActivityLevel::Error, "Failed: ffmpeg stopped"),
                (ActivityLevel::Info, "Cancelled"),
                (
                    ActivityLevel::Error,
                    "Upload interrupted: Upload stopped: the network was unavailable"
                ),
                (ActivityLevel::Info, "Finished: the video is ready"),
            ]
        );

        let mut secret = job("b", JobState::Failed);

        record_event(
            &mut secret,
            ActivityEvent::Ended {
                state: JobState::Failed,
                message: Some("rejected 12|abcdef1234567890abcdef12 and Bearer abcdefghijklmnop"),
            },
        );

        assert!(!secret.activity[0].text.contains("abcdef1234567890abcdef12"));
        assert!(!secret.activity[0].text.contains("abcdefghijklmnop"));
    }

    #[test]
    fn a_job_without_a_log_gets_a_temporary_one_that_is_not_stored() {
        let mut failed = job("f", JobState::Failed);

        failed.started_at = Some("2026-01-01T00:00:01.000Z".into());
        failed.finished_at = Some("2026-01-01T00:00:09.000Z".into());
        failed.error_message = Some("boom".into());

        let lines = to_dto_entries(&failed);
        let view: Vec<(&str, ActivityLevel, &str)> = lines
            .iter()
            .map(|l| (l.at.as_str(), l.level, l.text.as_str()))
            .collect();

        assert_eq!(
            view,
            [
                ("2026-01-01T00:00:00.000Z", ActivityLevel::Info, ADDED),
                ("2026-01-01T00:00:01.000Z", ActivityLevel::Info, "Started"),
                (
                    "2026-01-01T00:00:09.000Z",
                    ActivityLevel::Error,
                    "Failed: boom"
                ),
            ]
        );
        assert!(failed.activity.is_empty());

        let mut done = job("d", JobState::Done);

        done.finished_at = Some("2026-01-01T00:00:09.000Z".into());

        assert_eq!(to_dto_entries(&done).last().unwrap().text, "Finished");

        let waiting = job("w", JobState::Waiting);

        assert_eq!(to_dto_entries(&waiting).len(), 1);

        // A stored log is returned as it is.
        let mut stored = job("s", JobState::Done);

        stored.activity = initial(NOW);

        assert_eq!(to_dto_entries(&stored).len(), 1);
    }
}
