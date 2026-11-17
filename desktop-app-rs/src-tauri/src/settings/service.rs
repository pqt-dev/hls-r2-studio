//! Settings service backed by the app store. Port of
//! desktop-app/src/main/settings/settingsService.ts (same rules, same English error texts).
//! Nothing is saved until `set` succeeds.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::path_rules::{classify_tmp_root, is_absolute_native, normalize, TmpRootProblem};
use crate::dto::{JobState, SettingsDto, SettingsResult};
use crate::store::model::JobMode;
use crate::store::AppStore;

pub const MIN_CONCURRENT: i64 = 1;
pub const MAX_CONCURRENT: i64 = 2;

/// Longest `tmpRoot` accepted from the renderer (`expectString(.., 4096)` in the Electron IPC layer).
fn tmp_root_error(problem: TmpRootProblem) -> &'static str {
    match problem {
        TmpRootProblem::Empty | TmpRootProblem::NotAbsolute => {
            "The temporary folder must be an absolute path."
        }
        TmpRootProblem::Unc => {
            "The temporary folder cannot be a network (UNC) path. Choose a folder on a local drive."
        }
        TmpRootProblem::Device => {
            "The temporary folder cannot be a device path. Choose a folder on a local drive."
        }
    }
}

/// `SettingsPatch`. `max_concurrent` is a float so non-integers reach the range check; any
/// non-numeric value is carried as NaN (also rejected there).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsPatch {
    pub tmp_root: Option<String>,
    pub max_concurrent: Option<f64>,
}

/// Creates the directory when needed and verifies it is a writable directory. Windows: the
/// directory attribute "read-only" says nothing about writability, so a real probe file is written
/// (and removed) instead of trusting metadata.
pub fn ensure_dir_writable(path: &str) -> io::Result<()> {
    let dir = Path::new(path);

    std::fs::create_dir_all(dir)?;

    if !std::fs::metadata(dir)?.is_dir() {
        return Err(io::Error::other("not a directory"));
    }

    let probe = dir.join(format!(".hls-write-test-{}", std::process::id()));

    std::fs::write(&probe, b"")?;
    std::fs::remove_file(&probe)
}

type Check = Box<dyn Fn() -> bool + Send + Sync>;
type IsAbsolute = Box<dyn Fn(&str) -> bool + Send + Sync>;
type EnsureDir = Box<dyn Fn(&str) -> io::Result<()> + Send + Sync>;

pub struct SettingsServiceOptions {
    pub store: Arc<AppStore>,
    /// The built-in site origin (fixed at build time), empty when this build has none.
    pub get_site_url: Box<dyn Fn() -> String + Send + Sync>,
    pub has_active_jobs: Check,
    /// True while an upload is paused (`upload_interrupted`): its temp files are needed to resume.
    pub has_paused_uploads: Option<Check>,
    /// Override of the platform's absolute-path check (tests).
    pub is_absolute_path: Option<IsAbsolute>,
    /// Creates the directory when needed and verifies it is writable; `Err` if not.
    pub ensure_dir: EnsureDir,
    /// Called after any change so the queue can re-evaluate.
    pub on_changed: Box<dyn Fn() + Send + Sync>,
}

pub struct SettingsService {
    options: SettingsServiceOptions,
    /// Serializes `set` (validate-then-apply must not interleave).
    gate: Mutex<()>,
}

/// True while a job is paused for resume (`isPausedUpload || waiting + mode resume`), derived
/// from the store the same way the queue does.
pub fn store_has_paused_uploads(store: &AppStore) -> bool {
    store.read(|data| {
        data.jobs.iter().any(|job| {
            job.state == JobState::UploadInterrupted
                || (job.state == JobState::Waiting && job.mode == Some(JobMode::Resume))
        })
    })
}

impl SettingsService {
    pub fn new(options: SettingsServiceOptions) -> Self {
        Self {
            options,
            gate: Mutex::new(()),
        }
    }

    pub fn get(&self) -> SettingsDto {
        let (tmp_root, max_concurrent) = self
            .options
            .store
            .read(|d| (d.settings.tmp_root.clone(), d.settings.max_concurrent_u32()));

        SettingsDto {
            site_url: (self.options.get_site_url)(),
            tmp_root,
            max_concurrent,
        }
    }

    fn is_absolute(&self, path: &str) -> bool {
        match &self.options.is_absolute_path {
            Some(f) => f(path),
            None => is_absolute_native(path),
        }
    }

    pub fn set(&self, patch: &SettingsPatch) -> SettingsResult {
        let _gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        let current = self.get();
        let busy = (self.options.has_active_jobs)();
        let mut tmp_root: Option<String> = None;

        if let Some(value) = patch.max_concurrent {
            let in_range = value.fract() == 0.0
                && value >= MIN_CONCURRENT as f64
                && value <= MAX_CONCURRENT as f64;

            if !in_range {
                return SettingsResult::Err(format!(
                    "Parallel jobs must be between {MIN_CONCURRENT} and {MAX_CONCURRENT}."
                ));
            }
        }

        if let Some(raw) = &patch.tmp_root {
            let candidate = raw.trim();

            if let Some(problem) = classify_tmp_root(candidate, &|p| self.is_absolute(p)) {
                return SettingsResult::Err(tmp_root_error(problem).to_string());
            }

            let normalized = normalize(candidate);

            if normalized != normalize(&current.tmp_root) {
                if busy {
                    return SettingsResult::Err(
                        "Wait for the running jobs to finish before changing the temporary folder."
                            .to_string(),
                    );
                }

                if self
                    .options
                    .has_paused_uploads
                    .as_ref()
                    .is_some_and(|f| f())
                {
                    return SettingsResult::Err(
                        "Some uploads are paused and their temporary files are needed to resume them. Resume or remove them before changing the temporary folder."
                            .to_string(),
                    );
                }

                if (self.options.ensure_dir)(&normalized).is_err() {
                    return SettingsResult::Err(
                        "The temporary folder cannot be created or is not writable.".to_string(),
                    );
                }
            }

            tmp_root = Some(normalized);
        }

        // Everything is valid: apply.
        if tmp_root.is_some() || patch.max_concurrent.is_some() {
            self.options.store.update(|draft| {
                if let Some(path) = tmp_root {
                    draft.settings.tmp_root = path;
                }

                if let Some(n) = patch.max_concurrent {
                    draft.settings.max_concurrent = serde_json::Number::from(n as i64);
                }
            });
        }

        (self.options.on_changed)();

        SettingsResult::Ok(self.get())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::store::testing::create_memory_store;

    const TMP: &str = "/tmp/hls";

    /// Absolute on every platform for the test paths (the TS tests rely on a POSIX host).
    fn any_absolute(p: &str) -> bool {
        p.starts_with('/') || p.as_bytes().get(1) == Some(&b':')
    }

    struct Setup {
        service: SettingsService,
        store: Arc<AppStore>,
        ensured: Arc<Mutex<Vec<String>>>,
        changed: Arc<AtomicUsize>,
    }

    fn setup(busy: bool, paused: bool, ensure_fails: bool) -> Setup {
        let store = Arc::new(create_memory_store(TMP));
        let ensured = Arc::new(Mutex::new(Vec::new()));
        let changed = Arc::new(AtomicUsize::new(0));
        let (ensured_in, changed_in) = (Arc::clone(&ensured), Arc::clone(&changed));

        let service = SettingsService::new(SettingsServiceOptions {
            store: Arc::clone(&store),
            get_site_url: Box::new(|| "https://built-in.example.com".to_string()),
            has_active_jobs: Box::new(move || busy),
            has_paused_uploads: Some(Box::new(move || paused)),
            is_absolute_path: Some(Box::new(any_absolute)),
            ensure_dir: Box::new(move |p| {
                ensured_in.lock().unwrap().push(p.to_string());

                if ensure_fails {
                    Err(io::Error::other("EACCES"))
                } else {
                    Ok(())
                }
            }),
            on_changed: Box::new(move || {
                changed_in.fetch_add(1, Ordering::SeqCst);
            }),
        });

        Setup {
            service,
            store,
            ensured,
            changed,
        }
    }

    fn patch(tmp: Option<&str>, n: Option<f64>) -> SettingsPatch {
        SettingsPatch {
            tmp_root: tmp.map(str::to_string),
            max_concurrent: n,
        }
    }

    fn error_of(result: SettingsResult) -> String {
        match result {
            SettingsResult::Err(e) => e,
            SettingsResult::Ok(_) => panic!("expected an error"),
        }
    }

    // ---- with paused uploads ----

    #[test]
    fn paused_uploads_refuse_a_different_temp_folder() {
        let t = setup(false, true, false);
        let error = error_of(t.service.set(&patch(Some("/data/other"), None)));

        assert!(error.contains("paused") && error.contains("temporary folder"));
        assert!(t.ensured.lock().unwrap().is_empty());
        assert_eq!(t.service.get().tmp_root, TMP);
    }

    #[test]
    fn paused_uploads_still_allow_unchanged_values_and_unrelated_settings() {
        let t = setup(false, true, false);
        let result = t.service.set(&patch(Some(TMP), Some(2.0)));

        assert!(matches!(&result, SettingsResult::Ok(s) if s.max_concurrent == 2));
    }

    // ---- service ----

    #[test]
    fn returns_the_built_in_site_url_read_only_with_the_stored_settings() {
        assert_eq!(
            setup(false, false, false).service.get(),
            SettingsDto {
                site_url: "https://built-in.example.com".into(),
                tmp_root: TMP.into(),
                max_concurrent: 1
            }
        );
    }

    #[test]
    fn never_takes_the_site_url_from_the_stored_settings_or_from_a_patch() {
        let t = setup(false, false, false);
        t.store
            .update(|d| d.settings.site_url = "https://old.example.com".into());

        // A patch has no site URL field (the IPC layer rejects a `siteUrl` key outright).
        let result = t.service.set(&patch(None, Some(2.0)));

        assert!(
            matches!(&result, SettingsResult::Ok(s) if s.site_url == "https://built-in.example.com")
        );
        assert_eq!(t.store.get().settings.site_url, "https://old.example.com");
    }

    #[test]
    fn applies_valid_changes() {
        let t = setup(false, false, false);
        let result = t.service.set(&patch(Some("/data/tmp"), Some(2.0)));

        assert!(matches!(
            &result,
            SettingsResult::Ok(s) if s.tmp_root == normalize("/data/tmp") && s.max_concurrent == 2
        ));
        assert_eq!(*t.ensured.lock().unwrap(), vec![normalize("/data/tmp")]);
        assert_eq!(t.changed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_change_is_persisted_in_the_store_document() {
        let t = setup(false, false, false);
        t.service.set(&patch(None, Some(2.0)));

        assert_eq!(t.store.get().settings.max_concurrent, 2.into());
    }

    #[test]
    fn rejects_out_of_range_parallel_jobs_without_changing_anything() {
        let t = setup(false, false, false);

        for value in [0.0, 3.0, 1.5, -1.0, f64::NAN] {
            let error = error_of(t.service.set(&patch(None, Some(value))));

            assert_eq!(error, "Parallel jobs must be between 1 and 2.");
        }

        assert_eq!(t.store.get().settings.max_concurrent, 1.into());
        assert_eq!(t.changed.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn rejects_relative_or_empty_temp_folders_and_unwritable_ones() {
        let t = setup(false, false, false);

        assert!(matches!(
            t.service.set(&patch(Some("relative/dir"), None)),
            SettingsResult::Err(_)
        ));
        assert!(matches!(
            t.service.set(&patch(Some("  "), None)),
            SettingsResult::Err(_)
        ));

        let bad = setup(false, false, true);

        assert_eq!(
            error_of(bad.service.set(&patch(Some("/root/nope"), None))),
            "The temporary folder cannot be created or is not writable."
        );
        assert_eq!(bad.store.get().settings.tmp_root, TMP);
    }

    #[test]
    fn refuses_to_move_the_temp_folder_while_jobs_are_running() {
        let t = setup(true, false, false);

        assert!(matches!(
            t.service.set(&patch(Some("/other"), None)),
            SettingsResult::Err(_)
        ));
        // Unchanged values and the parallel job count remain allowed.
        assert!(matches!(
            t.service.set(&patch(Some(TMP), None)),
            SettingsResult::Ok(_)
        ));
        assert!(matches!(
            t.service.set(&patch(None, Some(2.0))),
            SettingsResult::Ok(_)
        ));
        assert_eq!(
            error_of(t.service.set(&patch(Some("/other"), None))),
            "Wait for the running jobs to finish before changing the temporary folder."
        );
    }

    #[test]
    fn unc_and_device_paths_are_refused_by_set_with_a_clear_message() {
        let t = setup(false, false, false);

        for path in ["\\\\srv\\share", "\\\\?\\C:\\x"] {
            let error = error_of(t.service.set(&patch(Some(path), None)));

            assert!(error.contains("cannot be a"), "{error}");
        }

        assert!(t.ensured.lock().unwrap().is_empty());
        assert_eq!(t.store.get().settings.tmp_root, TMP);
    }

    #[test]
    fn the_temp_folder_is_trimmed_and_normalized() {
        let t = setup(false, false, false);
        let result = t.service.set(&patch(Some("  /data//tmp/../x  "), None));

        assert!(matches!(
            &result,
            SettingsResult::Ok(s) if s.tmp_root == normalize("/data//tmp/../x")
        ));
    }

    #[test]
    fn a_valid_value_is_not_saved_when_a_later_check_fails() {
        let t = setup(false, false, false);
        let result = t.service.set(&patch(Some("relative"), Some(2.0)));

        assert!(matches!(result, SettingsResult::Err(_)));
        assert_eq!(t.store.get().settings.max_concurrent, 1.into());
    }

    // ---- patch parsing and helpers ----

    #[test]
    fn paused_uploads_are_derived_from_the_store() {
        let store = create_memory_store(TMP);

        assert!(!store_has_paused_uploads(&store));

        let mut job = crate::store::history::tests_support::job("a", JobState::Waiting);
        store.update(|d| d.jobs.push(job.clone()));
        assert!(!store_has_paused_uploads(&store));

        job.mode = Some(JobMode::Resume);
        store.update(|d| d.jobs = vec![job.clone()]);
        assert!(store_has_paused_uploads(&store));

        job.mode = None;
        job.state = JobState::UploadInterrupted;
        store.update(|d| d.jobs = vec![job]);
        assert!(store_has_paused_uploads(&store));
    }

    #[test]
    fn ensure_dir_creates_nested_directories_and_rejects_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");

        ensure_dir_writable(nested.to_str().unwrap()).unwrap();
        assert!(nested.is_dir());
        assert_eq!(std::fs::read_dir(&nested).unwrap().count(), 0);

        let file = dir.path().join("f");
        std::fs::write(&file, "x").unwrap();
        assert!(ensure_dir_writable(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn out_of_range_stored_values_fall_back_to_one_in_the_dto() {
        let t = setup(false, false, false);
        t.store.update(|d| d.settings.max_concurrent = 99.into());

        assert_eq!(t.service.get().max_concurrent, 99);
        t.store
            .update(|d| d.settings.max_concurrent = serde_json::Number::from_f64(2.5).unwrap());
        assert_eq!(t.service.get().max_concurrent, 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_paths_with_either_slash_are_accepted_and_normalized() {
        let store = Arc::new(create_memory_store("C:\\Temp\\hls"));
        let service = SettingsService::new(SettingsServiceOptions {
            store,
            get_site_url: Box::new(String::new),
            has_active_jobs: Box::new(|| false),
            has_paused_uploads: None,
            is_absolute_path: None,
            ensure_dir: Box::new(|_| Ok(())),
            on_changed: Box::new(|| ()),
        });
        let result = service.set(&patch(Some("D:/data//tmp"), None));

        assert!(matches!(&result, SettingsResult::Ok(s) if s.tmp_root == "D:\\data\\tmp"));
        assert!(matches!(
            service.set(&patch(Some("\\\\server\\share\\tmp"), None)),
            SettingsResult::Err(_)
        ));
        assert!(matches!(
            service.set(&patch(Some("\\data\\tmp"), None)),
            SettingsResult::Err(_)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn ensure_dir_works_with_backslash_paths_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let nested = format!("{}\\x y\\z", dir.path().display());

        ensure_dir_writable(&nested).unwrap();
        assert!(std::path::Path::new(&nested).is_dir());
    }
}
