//! Single-file JSON store with atomic writes (temp file + rename), tolerant loading and
//! serialized, debounced saves. Port of desktop-app/src/main/store/jsonStore.ts.
//!
//! Threading: the data lives behind a `Mutex`; one background writer thread per store performs the
//! debounced writes, so two writes never run at the same time and the latest state always wins
//! (the snapshot is taken when the write starts). `flush()` blocks until everything is on disk.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::file_ops::{FileOps, StdFileOps};

pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(200);

type Defaults<T> = Box<dyn Fn() -> T + Send + Sync>;
type Migrate = Box<dyn Fn(&Value, i64) -> Result<Value, String> + Send + Sync>;
type Validate = Box<dyn Fn(&Value) -> bool + Send + Sync>;
type OnError = Arc<dyn Fn(&io::Error) + Send + Sync>;

pub struct JsonStoreOptions<T> {
    pub file_path: PathBuf,
    /// Current schema version written to disk.
    pub schema_version: i64,
    /// Fresh default data (must carry `schemaVersion`). Called each time defaults are needed.
    pub create_defaults: Defaults<T>,
    /// Converts data saved with an older schema into the current shape (a JSON object; its
    /// `schemaVersion` is overwritten). An `Err` is treated as corrupt.
    pub migrate: Option<Migrate>,
    /// Shape check of data of the CURRENT schema (also applied to migrated data). `false`
    /// treats the file as corrupt: it is copied to `.bak` and defaults are used.
    pub validate: Option<Validate>,
    /// Delay before a scheduled write hits the disk. Default 200 ms.
    pub debounce: Duration,
    pub file_ops: Arc<dyn FileOps>,
    /// Called (from the writer thread) when a background write fails.
    pub on_error: Option<OnError>,
}

impl<T> JsonStoreOptions<T> {
    pub fn new(
        file_path: PathBuf,
        schema_version: i64,
        create_defaults: impl Fn() -> T + Send + Sync + 'static,
    ) -> Self {
        Self {
            file_path,
            schema_version,
            create_defaults: Box::new(create_defaults),
            migrate: None,
            validate: None,
            debounce: DEFAULT_DEBOUNCE,
            file_ops: Arc::new(StdFileOps),
            on_error: None,
        }
    }
}

struct State<T> {
    data: T,
    /// When set, the writer writes at this instant (reset on every update = debounce).
    deadline: Option<Instant>,
    writing: bool,
    shutdown: bool,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    cv: Condvar,
    file_path: PathBuf,
    schema_version: i64,
    create_defaults: Defaults<T>,
    migrate: Option<Migrate>,
    validate: Option<Validate>,
    debounce: Duration,
    file_ops: Arc<dyn FileOps>,
    on_error: Option<OnError>,
}

impl<T> Shared<T> {
    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct JsonStore<T: Serialize + DeserializeOwned + Clone + Send + 'static> {
    shared: Arc<Shared<T>>,
    writer: Option<JoinHandle<()>>,
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os: OsString = path.as_os_str().to_owned();
    os.push(suffix);

    PathBuf::from(os)
}

/// `Number.isInteger` on the stored `schemaVersion`; anything else counts as version 0.
fn stored_version(root: &serde_json::Map<String, Value>) -> i64 {
    match root.get("schemaVersion").and_then(Value::as_f64) {
        Some(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => n as i64,
        _ => 0,
    }
}

impl<T: Serialize + DeserializeOwned + Clone + Send + 'static> JsonStore<T> {
    pub fn new(options: JsonStoreOptions<T>) -> Self {
        let data = (options.create_defaults)();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                data,
                deadline: None,
                writing: false,
                shutdown: false,
            }),
            cv: Condvar::new(),
            file_path: options.file_path,
            schema_version: options.schema_version,
            create_defaults: options.create_defaults,
            migrate: options.migrate,
            validate: options.validate,
            debounce: options.debounce,
            file_ops: options.file_ops,
            on_error: options.on_error,
        });

        let for_thread = Arc::clone(&shared);
        let writer = std::thread::Builder::new()
            .name("json-store-writer".into())
            .spawn(move || writer_loop(&for_thread))
            .expect("spawn the store writer thread");

        Self {
            shared,
            writer: Some(writer),
        }
    }

    /// Loads the file. A missing file yields defaults. A corrupt, unmigratable or newer-version
    /// file is copied to `<file>.bak` and defaults are used instead.
    pub fn load(&self) -> T {
        let s = &self.shared;

        let Ok(raw) = s.file_ops.read(&s.file_path) else {
            let defaults = (s.create_defaults)();
            s.lock().data = defaults.clone();

            return defaults;
        };

        match self.parse(&raw) {
            Ok((data, migrated)) => {
                s.lock().data = data.clone();
                if migrated {
                    self.schedule_save();
                }

                data
            }
            Err(_) => {
                self.keep_backup();
                let defaults = (s.create_defaults)();
                s.lock().data = defaults.clone();

                defaults
            }
        }
    }

    /// Returns the data and whether it was migrated (so a save must be scheduled).
    fn parse(&self, raw: &str) -> Result<(T, bool), String> {
        let s = &self.shared;
        let parsed: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let Value::Object(mut root) = parsed else {
            return Err("Store root must be an object".into());
        };

        let from_version = stored_version(&root);

        if from_version == s.schema_version {
            let value = Value::Object(root);

            if s.validate.as_ref().is_some_and(|v| !v(&value)) {
                return Err("Store data has an invalid shape".into());
            }

            let data = serde_json::from_value(value).map_err(|e| e.to_string())?;

            return Ok((data, false));
        }

        if from_version < s.schema_version {
            if let Some(migrate) = &s.migrate {
                let migrated = migrate(&Value::Object(std::mem::take(&mut root)), from_version)?;
                let Value::Object(mut migrated) = migrated else {
                    return Err("Migrated store data must be an object".into());
                };

                migrated.insert("schemaVersion".into(), Value::from(s.schema_version));
                let value = Value::Object(migrated);

                if s.validate.as_ref().is_some_and(|v| !v(&value)) {
                    return Err("Migrated store data has an invalid shape".into());
                }

                let data = serde_json::from_value(value).map_err(|e| e.to_string())?;

                return Ok((data, true));
            }
        }

        Err(format!("Unsupported schema version {from_version}"))
    }

    /// A copy of the current in-memory data.
    pub fn get(&self) -> T {
        self.shared.lock().data.clone()
    }

    /// Reads the current data without cloning it.
    pub fn read<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        f(&self.shared.lock().data)
    }

    /// Mutates the data in place and schedules a debounced save. Assign through the reference to
    /// replace the whole document.
    pub fn update<R>(&self, mutator: impl FnOnce(&mut T) -> R) -> R {
        let result = {
            let mut state = self.shared.lock();

            mutator(&mut state.data)
        };

        self.schedule_save();

        result
    }

    /// Writes any pending change now and returns when all queued writes are finished.
    pub fn flush(&self) {
        let s = &self.shared;
        let mut state = s.lock();

        if state.deadline.is_some() {
            state.deadline = Some(Instant::now());
            s.cv.notify_all();
        }

        while state.deadline.is_some() || state.writing {
            state = s.cv.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn schedule_save(&self) {
        let s = &self.shared;

        s.lock().deadline = Some(Instant::now() + s.debounce);
        s.cv.notify_all();
    }

    fn keep_backup(&self) {
        let s = &self.shared;
        // Best effort: the original is replaced on the next successful write anyway.
        let _ = s
            .file_ops
            .copy(&s.file_path, &append_suffix(&s.file_path, ".bak"));
    }
}

impl<T: Serialize + DeserializeOwned + Clone + Send + 'static> Drop for JsonStore<T> {
    fn drop(&mut self) {
        self.flush();
        self.shared.lock().shutdown = true;
        self.shared.cv.notify_all();

        if let Some(handle) = self.writer.take() {
            let _ = handle.join();
        }
    }
}

fn writer_loop<T: Serialize>(s: &Shared<T>) {
    let mut state = s.lock();

    loop {
        match state.deadline {
            None if state.shutdown => return,
            None => state = s.cv.wait(state).unwrap_or_else(|e| e.into_inner()),
            Some(at) => {
                let now = Instant::now();

                if now < at && !state.shutdown {
                    state =
                        s.cv.wait_timeout(state, at - now)
                            .unwrap_or_else(|e| e.into_inner())
                            .0;
                    continue;
                }

                state.deadline = None;
                state.writing = true;
                // Snapshot at write time so the latest state always wins.
                let json = serde_json::to_string_pretty(&state.data)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));

                drop(state);

                let result = json.and_then(|json| write_atomic(s, &json));

                if let (Err(error), Some(on_error)) = (&result, &s.on_error) {
                    on_error(error);
                }

                state = s.lock();
                state.writing = false;
                s.cv.notify_all();
            }
        }
    }
}

fn write_atomic<T>(s: &Shared<T>, json: &str) -> io::Result<()> {
    let ops = &s.file_ops;
    let tmp_path = append_suffix(&s.file_path, ".tmp");

    if let Some(dir) = s.file_path.parent() {
        if !dir.as_os_str().is_empty() {
            ops.create_dir_all(dir)?;
        }
    }

    let written = ops
        .write(&tmp_path, json)
        .and_then(|()| ops.rename(&tmp_path, &s.file_path));

    if written.is_err() {
        let _ = ops.remove(&tmp_path);
    }

    written
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TestData {
        schema_version: i64,
        counter: i64,
        note: String,
    }

    fn defaults() -> TestData {
        TestData {
            schema_version: 2,
            counter: 0,
            note: "default".into(),
        }
    }

    fn options(file: &Path) -> JsonStoreOptions<TestData> {
        let mut o = JsonStoreOptions::new(file.to_path_buf(), 2, defaults);
        o.debounce = Duration::from_millis(5);

        o
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("store.json");

        (dir, file)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();

        v
    }

    fn counter_validator(v: &Value) -> bool {
        v.get("counter").is_some_and(Value::is_number)
    }

    // ---- load ----

    #[test]
    fn returns_defaults_for_a_missing_file() {
        let (_d, file) = setup();

        assert_eq!(JsonStore::new(options(&file)).load(), defaults());
    }

    #[test]
    fn loads_valid_data_of_the_current_version() {
        let (_d, file) = setup();
        fs::write(&file, r#"{"schemaVersion":2,"counter":7,"note":"x"}"#).unwrap();

        assert_eq!(JsonStore::new(options(&file)).load().counter, 7);
    }

    #[test]
    fn keeps_a_corrupt_file_as_bak_and_returns_defaults() {
        let (dir, file) = setup();
        fs::write(&file, "{ not json").unwrap();

        assert_eq!(JsonStore::new(options(&file)).load().note, "default");
        assert_eq!(
            fs::read_to_string(dir.path().join("store.json.bak")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn treats_a_non_object_root_as_corrupt() {
        let (dir, file) = setup();
        fs::write(&file, "[1,2]").unwrap();
        JsonStore::new(options(&file)).load();

        assert_eq!(
            fs::read_to_string(dir.path().join("store.json.bak")).unwrap(),
            "[1,2]"
        );
    }

    #[test]
    fn treats_data_rejected_by_validate_as_corrupt() {
        let (dir, file) = setup();
        let text = r#"{"schemaVersion":2,"counter":"oops","note":"x"}"#;
        fs::write(&file, text).unwrap();
        let mut o = options(&file);
        o.validate = Some(Box::new(counter_validator));

        assert_eq!(JsonStore::new(o).load().note, "default");
        assert_eq!(
            fs::read_to_string(dir.path().join("store.json.bak")).unwrap(),
            text
        );
    }

    #[test]
    fn keeps_valid_data_when_validate_accepts_it() {
        let (_d, file) = setup();
        fs::write(&file, r#"{"schemaVersion":2,"counter":1,"note":"x"}"#).unwrap();
        let mut o = options(&file);
        o.validate = Some(Box::new(|_| true));

        assert_eq!(JsonStore::new(o).load().note, "x");
    }

    #[test]
    fn data_that_does_not_fit_the_type_is_corrupt_too() {
        let (dir, file) = setup();
        fs::write(&file, r#"{"schemaVersion":2,"counter":"oops","note":"x"}"#).unwrap();

        assert_eq!(JsonStore::new(options(&file)).load().note, "default");
        assert!(names(dir.path()).contains(&"store.json.bak".to_string()));
    }

    #[test]
    fn validates_migrated_data_too() {
        let (_d, file) = setup();
        fs::write(&file, r#"{"counter":3}"#).unwrap();
        let mut o = options(&file);
        o.migrate = Some(Box::new(|_, _| {
            Ok(serde_json::json!({"schemaVersion": 0, "counter": "bad", "note": "m"}))
        }));
        o.validate = Some(Box::new(counter_validator));

        assert_eq!(JsonStore::new(o).load().note, "default");
    }

    #[test]
    fn runs_the_migrate_hook_for_older_versions_and_schedules_a_save() {
        let (_d, file) = setup();
        fs::write(&file, r#"{"counter":3}"#).unwrap(); // no schemaVersion => 0
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in_hook = Arc::clone(&seen);
        let mut o = options(&file);
        o.migrate = Some(Box::new(move |old, from| {
            seen_in_hook.lock().unwrap().push(from);

            Ok(serde_json::json!({
                "schemaVersion": 0,
                "counter": old["counter"],
                "note": "migrated"
            }))
        }));
        let store = JsonStore::new(o);
        let data = store.load();

        assert_eq!(*seen.lock().unwrap(), vec![0]);
        assert_eq!(
            data,
            TestData {
                schema_version: 2,
                counter: 3,
                note: "migrated".into()
            }
        );

        store.flush();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], 2);
    }

    #[test]
    fn falls_back_to_defaults_and_backs_up_when_migrate_fails() {
        let (dir, file) = setup();
        fs::write(&file, r#"{"schemaVersion":1}"#).unwrap();
        let mut o = options(&file);
        o.migrate = Some(Box::new(|_, _| Err("nope".into())));

        assert_eq!(JsonStore::new(o).load().note, "default");
        assert!(names(dir.path()).contains(&"store.json.bak".to_string()));
    }

    #[test]
    fn older_version_without_a_migrate_hook_is_backed_up() {
        let (dir, file) = setup();
        fs::write(&file, r#"{"schemaVersion":1,"counter":1,"note":"x"}"#).unwrap();

        assert_eq!(JsonStore::new(options(&file)).load().note, "default");
        assert!(names(dir.path()).contains(&"store.json.bak".to_string()));
    }

    #[test]
    fn backs_up_data_written_by_a_newer_schema_instead_of_using_it() {
        let (dir, file) = setup();
        fs::write(&file, r#"{"schemaVersion":9,"counter":1,"note":"future"}"#).unwrap();

        assert_eq!(JsonStore::new(options(&file)).load().note, "default");
        assert!(names(dir.path()).contains(&"store.json.bak".to_string()));
    }

    // ---- writes ----

    /// Records calls and can slow down or fail operations.
    #[derive(Default)]
    struct SpyOps {
        calls: Mutex<Vec<String>>,
        writes: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        write_delay: Duration,
        fail_rename: bool,
    }

    impl FileOps for SpyOps {
        fn read(&self, path: &Path) -> io::Result<String> {
            StdFileOps.read(path)
        }

        fn write(&self, path: &Path, data: &str) -> io::Result<()> {
            let kind = if path.to_string_lossy().ends_with(".tmp") {
                "tmp"
            } else {
                "final"
            };
            self.calls.lock().unwrap().push(format!("write:{kind}"));
            self.writes.fetch_add(1, Ordering::SeqCst);
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(self.write_delay);
            let result = StdFileOps.write(path, data);
            self.active.fetch_sub(1, Ordering::SeqCst);

            result
        }

        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.calls.lock().unwrap().push(format!(
                "rename:{}->{}",
                from.to_string_lossy().ends_with(".tmp"),
                to.ends_with("store.json")
            ));

            if self.fail_rename {
                return Err(io::Error::other("disk full"));
            }

            StdFileOps.rename(from, to)
        }

        fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
            StdFileOps.copy(from, to)
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            StdFileOps.remove(path)
        }

        fn create_dir_all(&self, path: &Path) -> io::Result<()> {
            StdFileOps.create_dir_all(path)
        }
    }

    fn counter_of(file: &Path) -> i64 {
        let v: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();

        v["counter"].as_i64().unwrap()
    }

    #[test]
    fn writes_atomically_through_a_temp_file_and_leaves_no_temp_file_behind() {
        let (dir, file) = setup();
        let ops = Arc::new(SpyOps::default());
        let mut o = options(&file);
        o.file_ops = ops.clone();
        let store = JsonStore::new(o);
        store.load();
        store.update(|d| d.counter = 1);
        store.flush();

        assert_eq!(
            *ops.calls.lock().unwrap(),
            vec!["write:tmp", "rename:true->true"]
        );
        assert_eq!(names(dir.path()), vec!["store.json"]);
        assert_eq!(counter_of(&file), 1);
    }

    #[test]
    fn writes_two_space_indented_json_without_a_trailing_newline() {
        let (_d, file) = setup();
        let store = JsonStore::new(options(&file));
        store.update(|d| d.counter = 1);
        store.flush();

        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "{\n  \"schemaVersion\": 2,\n  \"counter\": 1,\n  \"note\": \"default\"\n}"
        );
    }

    #[test]
    fn keeps_the_old_file_intact_when_the_write_fails_and_cleans_up_the_temp_file() {
        let (dir, file) = setup();
        fs::write(&file, r#"{"schemaVersion":2,"counter":1,"note":"old"}"#).unwrap();
        let errors = Arc::new(AtomicUsize::new(0));
        let errors_in_hook = Arc::clone(&errors);
        let mut o = options(&file);
        o.file_ops = Arc::new(SpyOps {
            fail_rename: true,
            ..SpyOps::default()
        });
        o.on_error = Some(Arc::new(move |_| {
            errors_in_hook.fetch_add(1, Ordering::SeqCst);
        }));
        let store = JsonStore::new(o);
        store.load();
        store.update(|d| d.counter = 2);
        store.flush();

        assert_eq!(errors.load(Ordering::SeqCst), 1);
        assert_eq!(counter_of(&file), 1);
        assert_eq!(names(dir.path()), vec!["store.json"]);
    }

    #[test]
    fn debounces_rapid_updates_into_one_write_containing_the_latest_state() {
        let (_d, file) = setup();
        let ops = Arc::new(SpyOps::default());
        let mut o = options(&file);
        o.file_ops = ops.clone();
        o.debounce = Duration::from_millis(100);
        let store = JsonStore::new(o);
        store.load();

        for i in 1..=10 {
            store.update(|d| d.counter = i);
        }
        store.flush();

        assert_eq!(ops.writes.load(Ordering::SeqCst), 1);
        assert_eq!(counter_of(&file), 10);
    }

    #[test]
    fn never_runs_two_writes_at_the_same_time() {
        let (_d, file) = setup();
        let ops = Arc::new(SpyOps {
            write_delay: Duration::from_millis(15),
            ..SpyOps::default()
        });
        let mut o = options(&file);
        o.file_ops = ops.clone();
        o.debounce = Duration::from_millis(1);
        let store = JsonStore::new(o);
        store.load();

        for i in 1..=5 {
            store.update(|d| d.counter = i);
            // Let the timer fire while a write is running.
            std::thread::sleep(Duration::from_millis(3));
        }
        store.flush();

        assert_eq!(ops.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(counter_of(&file), 5);
    }

    #[test]
    fn flush_with_nothing_pending_returns_immediately_and_writes_nothing() {
        let (dir, file) = setup();
        let store = JsonStore::new(options(&file));
        store.load();
        store.flush();

        assert!(names(dir.path()).is_empty());
    }

    #[test]
    fn dropping_the_store_writes_pending_changes() {
        let (_d, file) = setup();
        let mut o = options(&file);
        o.debounce = Duration::from_secs(60);
        let store = JsonStore::new(o);
        store.update(|d| d.counter = 4);
        drop(store);

        assert_eq!(counter_of(&file), 4);
    }
}
