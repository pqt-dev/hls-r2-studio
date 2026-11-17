//! Port of steps/upload.test.ts: the network-wait policy and the 3-attempt policy, over the fake
//! object store and a fake clock that only moves when the upload sleeps.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use super::*;
use crate::logger::testing::RecordingLogger;
use crate::pipeline::testing::fakes::{
    fake_tuning, http_error, net_error, FakeS3, FakeS3Options, FakeSleeper, START_MS,
};

const PREFIX: &str = "2026/03/05/clip-ab12cd34ef56/";

fn write_files(dir: &std::path::Path, segments: usize) {
    std::fs::create_dir_all(dir).unwrap();

    for i in 0..segments {
        std::fs::write(dir.join(format!("segment_{i:03}.ts")), [0u8; 10]).unwrap();
    }

    std::fs::write(dir.join("playlist.m3u8"), "#EXTM3U\n").unwrap();
}

#[derive(Default)]
struct Hooks {
    waits: Mutex<Vec<NetworkWaitInfo>>,
    restored: Mutex<Vec<i64>>,
    clock: Option<Arc<AtomicI64>>,
    throwing: bool,
}

impl NetworkHooks for Hooks {
    fn on_network_wait(&self, info: &NetworkWaitInfo) {
        self.waits.lock().unwrap().push(*info);

        assert!(!self.throwing, "hook failed");
    }

    fn on_network_restored(&self) {
        let now = self.clock.as_ref().map_or(0, |c| c.load(Ordering::SeqCst));

        self.restored.lock().unwrap().push(now);

        assert!(!self.throwing, "hook failed");
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    dir: std::path::PathBuf,
    clock: Arc<AtomicI64>,
    sleeper: Arc<FakeSleeper>,
    hooks: Arc<Hooks>,
    progress: Arc<Mutex<Vec<f64>>>,
    s3: FakeS3,
    cancel: CancellationToken,
    budget: Option<u64>,
}

impl Rig {
    fn new(segments: usize, s3: impl FnOnce(Arc<AtomicI64>) -> FakeS3Options) -> Self {
        Self::with_sleeper(segments, s3, None, false)
    }

    fn with_sleeper(
        segments: usize,
        s3: impl FnOnce(Arc<AtomicI64>) -> FakeS3Options,
        sleeper: Option<FakeSleeper>,
        throwing: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("job");

        write_files(&path, segments);

        let clock = Arc::new(AtomicI64::new(START_MS));
        let sleeper = Arc::new(sleeper.unwrap_or_else(|| FakeSleeper {
            clock: Some(Arc::clone(&clock)),
            ..FakeSleeper::default()
        }));

        Self {
            _dir: dir,
            dir: path,
            s3: FakeS3::new(s3(Arc::clone(&clock))),
            hooks: Arc::new(Hooks {
                clock: Some(Arc::clone(&clock)),
                throwing,
                ..Hooks::default()
            }),
            clock,
            sleeper,
            progress: Arc::default(),
            cancel: CancellationToken::new(),
            budget: None,
        }
    }

    fn context(&self) -> UploadContext {
        let progress = Arc::clone(&self.progress);
        let mut tuning = fake_tuning(&self.clock);

        tuning.stall_budget_ms = self.budget;

        UploadContext {
            store: self.s3.client(),
            bucket: "b".into(),
            prefix: PREFIX.into(),
            dir: self.dir.clone(),
            cancel: self.cancel.clone(),
            sleeper: Arc::clone(&self.sleeper) as Arc<dyn Sleeper>,
            logger: Arc::new(RecordingLogger::default()),
            on_progress: Arc::new(move |f| progress.lock().unwrap().push(f)),
            on_upload_started: Arc::new(|| ()),
            network: Arc::clone(&self.hooks) as Arc<dyn NetworkHooks>,
            tuning,
        }
    }

    async fn run(&self) -> Result<UploadResult, PipelineError> {
        upload_directory(self.context(), || ())
            .await
            .map_err(|fault| match fault {
                Fault::Pipeline(error) => error,
                other => panic!("unexpected fault {other:?}"),
            })
    }

    fn sleeps(&self) -> Vec<u64> {
        self.sleeper.sleeps()
    }

    fn waits(&self) -> Vec<NetworkWaitInfo> {
        self.hooks.waits.lock().unwrap().clone()
    }

    fn restored(&self) -> usize {
        self.hooks.restored.lock().unwrap().len()
    }
}

fn fail_put(
    f: impl Fn(&str, usize) -> Option<StoreError> + Send + Sync + 'static,
) -> FakeS3Options {
    FakeS3Options {
        fail_put: Some(Box::new(f)),
        ..FakeS3Options::default()
    }
}

#[tokio::test]
async fn keeps_retrying_a_network_failure_with_growing_delays_and_then_succeeds() {
    let r = Rig::new(0, |_| fail_put(|_, attempt| (attempt <= 7).then(net_error)));

    r.run().await.unwrap();

    assert_eq!(
        r.sleeps(),
        vec![2000, 5000, 10000, 20000, 30000, 60000, 60000]
    );
    assert!(r.s3.has(&format!("{PREFIX}playlist.m3u8")));
    assert_eq!(r.s3.put_keys().len(), 8);
    assert_eq!(r.restored(), 1);
    assert_eq!(
        r.waits()[0],
        NetworkWaitInfo {
            since: START_MS,
            attempt: 1,
            next_retry_in_ms: 2000,
            budget_remaining_ms: NETWORK_STALL_BUDGET_MS,
        }
    );
}

#[tokio::test]
async fn does_not_spend_the_3_attempt_budget_on_network_failures() {
    let r = Rig::new(1, |_| {
        fail_put(|key, attempt| (key.ends_with(".ts") && attempt <= 10).then(net_error))
    });

    r.run().await.unwrap();

    assert_eq!(
        r.s3.put_keys()
            .iter()
            .filter(|k| k.ends_with(".ts"))
            .count(),
        11
    );
}

#[tokio::test]
async fn throttles_on_network_wait_and_reports_the_restore_once() {
    let r = Rig::new(0, |_| fail_put(|_, attempt| (attempt <= 7).then(net_error)));

    r.run().await.unwrap();

    let waits = r.waits();

    assert!(waits.len() < 7);

    for pair in waits.windows(2) {
        let gap = pair[0].budget_remaining_ms - pair[1].budget_remaining_ms;

        assert!(gap >= NETWORK_WAIT_NOTIFY_INTERVAL_MS);
    }
}

#[tokio::test]
async fn does_not_call_on_network_restored_when_no_wait_happened() {
    let r = Rig::new(2, |_| FakeS3Options::default());
    let result = r.run().await.unwrap();

    assert!(r.waits().is_empty());
    assert_eq!(r.restored(), 0);
    assert_eq!(r.progress.lock().unwrap().last(), Some(&1.0));
    assert_eq!(
        result.files,
        ["segment_000.ts", "segment_001.ts", "playlist.m3u8"]
    );
}

#[tokio::test]
async fn survives_panicking_status_hooks() {
    let r = Rig::with_sleeper(
        0,
        |_| fail_put(|_, attempt| (attempt <= 1).then(net_error)),
        None,
        true,
    );

    r.run().await.unwrap();

    assert_eq!(r.waits().len(), 1);
    assert_eq!(r.restored(), 1);
    assert!(r.s3.has(&format!("{PREFIX}playlist.m3u8")));
}

#[tokio::test]
async fn throws_upload_interrupted_when_the_whole_stall_budget_is_used_up() {
    let r = Rig::new(0, |_| {
        fail_put(|_, _| Some(StoreError::Network("ETIMEDOUT".into())))
    });
    let failure = r.run().await.unwrap_err();

    assert_eq!(failure.kind, PipelineErrorKind::UploadInterrupted);
    assert_eq!(failure.step, JobState::Uploading);
    assert!(failure.resumable);
    assert_eq!(
        failure.message,
        "Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online."
    );
    assert_eq!(r.sleeps().iter().sum::<u64>(), NETWORK_STALL_BUDGET_MS);
    assert_eq!(r.restored(), 0);
    // Nothing was ever uploaded, and the step never deletes anything.
    assert!(r
        .s3
        .requests()
        .iter()
        .all(|q| q.kind == crate::pipeline::testing::fakes::S3RequestKind::Put));
}

#[tokio::test]
async fn a_success_resets_the_stall_budget() {
    let minutes = |n: i64| START_MS + n * 60_000;
    // The segment succeeds after 25 min of outage, the playlist after another 25 min: 50 min in
    // total, which only works when the success in between reset the budget.
    let r = Rig::new(1, move |clock| {
        let segment_up = Arc::new(AtomicI64::new(i64::MAX));

        fail_put(move |key, _| {
            let now = clock.load(Ordering::SeqCst);

            if key.ends_with(".ts") {
                if now < minutes(25) {
                    return Some(net_error());
                }

                segment_up.fetch_min(now, Ordering::SeqCst);

                return None;
            }

            (now < segment_up.load(Ordering::SeqCst) + 25 * 60_000).then(net_error)
        })
    });

    r.run().await.unwrap();

    assert!(r.s3.has(&format!("{PREFIX}playlist.m3u8")));
    assert!((r.clock.load(Ordering::SeqCst) - START_MS) as u64 > NETWORK_STALL_BUDGET_MS);
    assert_eq!(r.restored(), 2);
}

#[tokio::test]
async fn without_a_success_in_between_the_same_50_min_outage_is_interrupted() {
    let r = Rig::new(0, |clock| {
        fail_put(move |_, _| {
            (clock.load(Ordering::SeqCst) < START_MS + 50 * 60_000).then(net_error)
        })
    });

    assert_eq!(
        r.run().await.unwrap_err().kind,
        PipelineErrorKind::UploadInterrupted
    );
}

#[tokio::test]
async fn shares_one_stall_budget_between_the_concurrent_files() {
    let single = Rig::new(0, |_| fail_put(|_, _| Some(net_error())));

    single.run().await.unwrap_err();

    let single_attempts = single.s3.put_keys().len();
    // Under the fake clock the 5 waits of a round run one after another (5x the time), so with a
    // shared budget the whole step makes about as many attempts as ONE file did alone.
    let many = Rig::new(5, |_| fail_put(|_, _| Some(net_error())));
    let failure = many.run().await.unwrap_err();

    assert_eq!(failure.kind, PipelineErrorKind::UploadInterrupted);
    assert!(many.s3.put_keys().len() < single_attempts * 2);

    let mut since: Vec<i64> = many.waits().iter().map(|w| w.since).collect();

    since.dedup();

    assert_eq!(since.len(), 1);
}

#[tokio::test]
async fn stops_the_other_waiting_files_as_soon_as_one_file_is_interrupted() {
    let r = Rig::new(5, |_| fail_put(|_, _| Some(net_error())));

    r.run().await.unwrap_err();

    let settled = r.s3.put_keys().len();

    tokio::time::sleep(Duration::from_millis(20)).await;

    assert_eq!(r.s3.put_keys().len(), settled);
}

#[tokio::test]
async fn aborts_a_wait_immediately_when_the_job_is_cancelled() {
    let r = Rig::with_sleeper(
        0,
        |_| fail_put(|_, _| Some(net_error())),
        Some(FakeSleeper {
            block: true,
            ..FakeSleeper::default()
        }),
        false,
    );
    let sleeper = Arc::clone(&r.sleeper);
    let cancel = r.cancel.clone();

    tokio::spawn(async move {
        sleeper.waiting.notified().await;
        cancel.cancel();
    });

    let failure = r.run().await.unwrap_err();

    assert_eq!(failure.kind, PipelineErrorKind::Cancelled);
    assert_eq!(r.s3.put_keys().len(), 1);
}

#[tokio::test]
async fn http_403_gets_3_attempts_with_1_s_and_2_s_waits_and_then_fails() {
    let r = Rig::new(0, |_| {
        fail_put(|_, _| Some(http_error(403, "AccessDenied")))
    });
    let failure = r.run().await.unwrap_err();

    assert_eq!(failure.kind, PipelineErrorKind::Failed);
    assert_eq!(
        failure.message,
        "Uploading to R2 failed. Check the R2 settings and your connection."
    );
    assert_eq!(r.sleeps(), vec![1000, 2000]);
    assert_eq!(r.s3.put_keys().len(), 3);
    assert!(r.waits().is_empty());
}

#[tokio::test]
async fn a_transient_non_network_failure_is_still_retried() {
    let r = Rig::new(0, |_| {
        fail_put(|_, attempt| (attempt == 1).then(|| http_error(400, "BadDigest")))
    });

    r.run().await.unwrap();

    assert_eq!(r.sleeps(), vec![1000]);
}

#[tokio::test]
async fn stays_within_the_old_budget_even_when_the_network_flaps_in_between() {
    let r = Rig::new(0, |_| {
        fail_put(|_, attempt| match attempt {
            1 => Some(net_error()),
            2..=4 => Some(http_error(403, "AccessDenied")),
            _ => None,
        })
    });
    let failure = r.run().await.unwrap_err();

    assert_eq!(failure.kind, PipelineErrorKind::Failed);
    assert_eq!(r.sleeps(), vec![2000, 1000, 2000]);
}

#[tokio::test]
async fn a_missing_playlist_fails_before_any_upload() {
    let r = Rig::new(1, |_| FakeS3Options::default());

    std::fs::remove_file(r.dir.join("playlist.m3u8")).unwrap();

    let failure = r.run().await.unwrap_err();

    assert_eq!(
        failure.message,
        "The playlist file is missing, so nothing can be uploaded."
    );
    assert!(r.s3.put_keys().is_empty());
}

#[tokio::test]
async fn uploads_the_playlist_strictly_last_with_content_types_and_sizes() {
    let r = Rig::new(7, |_| FakeS3Options::default());

    std::fs::write(r.dir.join("thumbnail.jpg"), [1u8; 33]).unwrap();
    std::fs::write(r.dir.join("candidate_0001.jpg"), [1u8; 3]).unwrap();
    r.run().await.unwrap();

    let keys = r.s3.put_keys();

    assert_eq!(keys.len(), 9);
    assert_eq!(keys.last().unwrap(), &format!("{PREFIX}playlist.m3u8"));
    assert_eq!(r.s3.objects()[&format!("{PREFIX}thumbnail.jpg")], 33);
    assert_eq!(r.s3.objects()[&format!("{PREFIX}segment_006.ts")], 10);

    let requests = r.s3.requests();
    let type_of = |name: &str| {
        requests
            .iter()
            .find(|q| q.keys[0].ends_with(name))
            .and_then(|q| q.content_type.clone())
    };

    assert_eq!(
        type_of("playlist.m3u8").as_deref(),
        Some("application/vnd.apple.mpegurl")
    );
    assert_eq!(type_of("segment_000.ts").as_deref(), Some("video/mp2t"));
    assert_eq!(type_of("thumbnail.jpg").as_deref(), Some("image/jpeg"));

    let progress = r.progress.lock().unwrap().clone();

    assert_eq!(progress.len(), 9);
    assert!(progress.windows(2).all(|w| w[0] <= w[1]));
}

#[tokio::test]
async fn never_has_more_than_5_uploads_in_flight() {
    struct Gate {
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    let gate = Arc::new(Gate {
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
    });

    struct Slow {
        inner: Arc<dyn ObjectStore>,
        gate: Arc<Gate>,
    }

    #[async_trait::async_trait]
    impl ObjectStore for Slow {
        async fn list_page(
            &self,
            bucket: &str,
            prefix: &str,
            max_keys: Option<usize>,
            token: Option<&str>,
            cancel: Option<&CancellationToken>,
        ) -> Result<crate::pipeline::deps::ListPage, StoreError> {
            self.inner
                .list_page(bucket, prefix, max_keys, token, cancel)
                .await
        }

        async fn delete_keys(&self, bucket: &str, keys: &[String]) -> Result<usize, StoreError> {
            self.inner.delete_keys(bucket, keys).await
        }

        async fn put_file(
            &self,
            request: PutFileRequest<'_>,
            cancel: &CancellationToken,
        ) -> Result<(), StoreError> {
            let now = self.gate.active.fetch_add(1, Ordering::SeqCst) + 1;

            self.gate.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;

            let result = self.inner.put_file(request, cancel).await;

            self.gate.active.fetch_sub(1, Ordering::SeqCst);
            result
        }
    }

    let r = Rig::new(12, |_| FakeS3Options::default());
    let mut ctx = r.context();

    ctx.store = Arc::new(Slow {
        inner: r.s3.client(),
        gate: Arc::clone(&gate),
    });
    upload_directory(ctx, || ()).await.unwrap();

    assert_eq!(gate.peak.load(Ordering::SeqCst), UPLOAD_CONCURRENCY);
    assert_eq!(
        r.s3.put_keys().last().unwrap(),
        &format!("{PREFIX}playlist.m3u8")
    );
}
