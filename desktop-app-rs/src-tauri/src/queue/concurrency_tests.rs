//! Races the TS queue could not have (single JS thread) but a multi-threaded runtime can:
//! cancel vs completion, late hooks vs removal, sign-out mid-run, maxConcurrent changes while
//! running, concurrent adds and hook storms during cancel.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Number;

use super::testing::*;
use crate::dto::{ActionResult, JobState};
use crate::ffmpeg::errors::cancelled_error;

async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..2000 {
        if condition() {
            return;
        }

        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_racing_completion_always_ends_consistently() {
    for round in 0..40 {
        let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1)]);
        h.add(&["/v/a.mp4"]).await;
        wait_until("the run", || h.runs().len() == 1).await;
        let run = h.run(0);
        let queue = Arc::clone(&h.queue);

        // Completion and cancel at the same time; the fake also honours the token.
        let completer = tokio::spawn({
            let run = Arc::clone(&run);
            async move {
                if round % 2 == 0 {
                    run.resolve();
                } else {
                    tokio::task::yield_now().await;
                    run.resolve();
                }
            }
        });
        let canceller = tokio::spawn(async move { queue.cancel("job-1").await });
        run.cancel_on_abort(JobState::Uploading);

        completer.await.unwrap();
        let result = canceller.await.unwrap();

        wait_until("the job to settle", || !h.queue.has_active_jobs()).await;

        let job = h.job("job-1");
        assert!(
            matches!(job.state, JobState::Done | JobState::Cancelled),
            "round {round}: {:?}",
            job.state
        );
        // Whatever won, the record is self-consistent.
        if job.state == JobState::Done {
            assert!(job.registered.is_some());
        } else {
            assert_eq!(job.registered, None);
        }
        assert!(matches!(result, ActionResult::Ok | ActionResult::Err(_)));
        assert!(!h.dto("job-1").can_cancel);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn late_hooks_after_completion_and_removal_are_ignored() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)]);
    h.add(&["/v/a.mp4"]).await;
    wait_until("the run", || h.runs().len() == 1).await;
    let run = h.run(0);
    let hooks = Arc::clone(&run.hooks);

    run.resolve();
    wait_until("done", || h.job("job-1").state == JobState::Done).await;

    // A straggling hook of the finished run must not resurrect anything.
    hooks.on_stage(JobState::Uploading);
    hooks.on_progress(99);
    hooks.on_prefix("2026/01/01/x-evil0000000/");
    assert_eq!(h.job("job-1").state, JobState::Done);

    // Progress racing a remove: the hooks storm while the job is removed.
    let storm = {
        let hooks = Arc::clone(&hooks);
        tokio::spawn(async move {
            for i in 0..2000 {
                hooks.on_progress(i % 100);
                hooks.on_stage(JobState::Uploading);
            }
        })
    };
    assert_eq!(h.queue.remove("job-1").await, ActionResult::Ok);
    storm.await.unwrap();

    assert!(h.queue.get_job("job-1").is_none());
    assert!(h.queue.list().is_empty());

    // A NEW job for the same file is not affected by the old run's hooks either.
    h.add(&["/v/b.mp4"]).await;
    wait_until("the second run", || h.runs().len() == 2).await;
    hooks.on_stage(JobState::Registering);
    assert_eq!(h.job("job-2").state, JobState::Transcoding);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sign_out_mid_run_lets_the_run_finish_and_holds_the_rest() {
    let h = Harness::with(|o| o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)]);
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;
    wait_until("the run", || h.runs().len() == 1).await;

    h.set_auth(signed_out(None)).await;
    h.ctx
        .session
        .store(false, std::sync::atomic::Ordering::SeqCst);
    h.set_config(None);

    // The running job keeps its config snapshot and finishes.
    h.run(0).resolve();
    wait_until("done", || h.job("job-1").state == JobState::Done).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    assert_eq!(h.runs().len(), 1);
    assert_eq!(
        h.dto("job-2").waiting_reason.as_deref(),
        Some("Sign in to start processing.")
    );

    // A register after sign-out ends as needs_sign_in; signing in again picks it up.
    h.ctx
        .session
        .store(true, std::sync::atomic::Ordering::SeqCst);
    h.set_config(Some(crate::api::app_config::testing::config()));
    h.set_auth(signed_in(None)).await;
    wait_until("the next run", || h.runs().len() == 2).await;
    h.run(1).reject(register_error(
        crate::ffmpeg::errors::PipelineErrorKind::NeedsSignIn,
        "401",
    ));
    wait_until("needs_sign_in", || {
        h.job("job-2").state == JobState::NeedsSignIn
    })
    .await;

    h.set_auth(signed_out(None)).await;
    h.set_auth(signed_in(None)).await;
    wait_until("the register retry", || h.register_runs().len() == 1).await;
    assert_eq!(h.job("job-2").state, JobState::Registering);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn max_concurrent_changes_apply_live_without_touching_running_jobs() {
    let h = Harness::with(|o| {
        o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2), ("/v/c.mp4", 3)];
    });
    h.add(&["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"]).await;
    wait_until("one run", || h.runs().len() == 1).await;

    // 1 -> 2: a second job starts at once.
    h.store
        .update(|d| d.settings.max_concurrent = Number::from(2));
    h.queue.kick();
    wait_until("two runs", || h.runs().len() == 2).await;

    // 2 -> 1: nothing is cancelled, but no third job starts while two run...
    h.store
        .update(|d| d.settings.max_concurrent = Number::from(1));
    h.queue.kick();
    h.run(0).resolve();
    wait_until("job-1 done", || h.job("job-1").state == JobState::Done).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    assert!(!h.run(1).cancel.is_cancelled());
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.job("job-3").state, JobState::Waiting);

    // ...only once the running count drops below the new limit.
    h.run(1).resolve();
    wait_until("third run", || h.runs().len() == 3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_adds_of_the_same_file_create_one_job() {
    let h = Arc::new(Harness::with(|o| {
        o.auth = signed_out(None);
        o.files = vec![("/v/a.mp4", 1)];
    }));
    let tasks: Vec<_> = (0..16)
        .map(|_| {
            let h = Arc::clone(&h);
            tokio::spawn(async move { h.add(&["/v/a.mp4"]).await.added })
        })
        .collect();
    let mut added = 0;

    for task in tasks {
        added += task.await.unwrap();
    }

    assert_eq!(added, 1);
    assert_eq!(h.store.read(|d| d.jobs.len()), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hook_storms_during_cancel_and_shutdown_do_not_deadlock() {
    let h = Harness::with(|o| {
        o.max_concurrent = 2;
        o.files = vec![("/v/a.mp4", 1), ("/v/b.mp4", 2)];
    });
    h.add(&["/v/a.mp4", "/v/b.mp4"]).await;
    wait_until("two runs", || h.runs().len() == 2).await;

    let storms: Vec<_> = h
        .runs()
        .into_iter()
        .map(|run| {
            tokio::spawn(async move {
                for i in 0..500u32 {
                    run.hooks.on_progress(i % 100);
                    run.hooks
                        .on_network_wait(&crate::pipeline::steps::upload::NetworkWaitInfo {
                            since: 0,
                            attempt: 1,
                            next_retry_in_ms: 1,
                            budget_remaining_ms: 1,
                        });
                    run.hooks.on_network_restored();
                    tokio::task::yield_now().await;
                }

                run.reject(cancelled_error(JobState::Uploading));
            })
        })
        .collect();

    let queue = Arc::clone(&h.queue);
    let cancel = tokio::spawn(async move { queue.cancel("job-1").await });
    let list = {
        let queue = Arc::clone(&h.queue);
        tokio::spawn(async move {
            for _ in 0..200 {
                let _ = queue.list();
                let _ = queue.summary();
                tokio::task::yield_now().await;
            }
        })
    };

    tokio::time::timeout(Duration::from_secs(10), async {
        cancel.await.unwrap();
        list.await.unwrap();

        for storm in storms {
            storm.await.unwrap();
        }

        h.queue.shutdown().await;
    })
    .await
    .expect("no deadlock");

    assert!(!h.queue.has_active_jobs());
    assert_eq!(h.job("job-1").state, JobState::Cancelled);
}
