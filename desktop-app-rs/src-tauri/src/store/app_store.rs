//! The app document (`store.json` in the user data dir). Port of
//! desktop-app/src/main/store/appStore.ts: same file name, schema version, defaults, migration
//! and shape validation, so an Electron data dir loads unchanged.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

use super::file_ops::FileOps;
use super::json_store::{JsonStore, JsonStoreOptions, DEFAULT_DEBOUNCE};
use super::model::{AppData, AppSettings};

pub const APP_SCHEMA_VERSION: i64 = 1;
pub const STORE_FILE_NAME: &str = "store.json";

pub type AppStore = JsonStore<AppData>;
pub type OnWriteError = Arc<dyn Fn(&std::io::Error) + Send + Sync>;

pub struct AppStoreOptions {
    /// Directory of the store file (the user data dir).
    pub dir: PathBuf,
    /// Default temporary root, e.g. `<temp dir>/hls-r2-studio`.
    pub default_tmp_root: String,
    pub debounce: Option<Duration>,
    pub file_ops: Option<Arc<dyn FileOps>>,
    pub on_error: Option<OnWriteError>,
}

pub fn create_default_app_data(default_tmp_root: &str) -> AppData {
    AppData {
        schema_version: APP_SCHEMA_VERSION,
        settings: AppSettings {
            site_url: String::new(),
            tmp_root: default_tmp_root.to_string(),
            max_concurrent: 1.into(),
            username: None,
            extra: Map::new(),
        },
        jobs: Vec::new(),
        extra: Map::new(),
    }
}

const JOB_STATES: [&str; 13] = [
    "waiting",
    "transcoding",
    "thumbnail",
    "storyboard",
    "uploading",
    "registering",
    "done",
    "failed",
    "cancelled",
    "interrupted",
    "register_failed",
    "needs_sign_in",
    "upload_interrupted",
];

fn is_nullable_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null | Value::String(_)))
}

fn is_nullable_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null | Value::Object(_)))
}

/// A property that may be absent but, when present, must satisfy `check`.
fn absent_or(value: Option<&Value>, check: impl Fn(&Value) -> bool) -> bool {
    match value {
        None => true,
        Some(v) => check(v),
    }
}

fn is_valid_job(job: &Value) -> bool {
    let Some(job) = job.as_object() else {
        return false;
    };
    let get = |key: &str| job.get(key);

    get("id").is_some_and(Value::is_string)
        && get("sourcePath").is_some_and(Value::is_string)
        && get("sizeBytes").is_some_and(Value::is_number)
        && get("state")
            .and_then(Value::as_str)
            .is_some_and(|s| JOB_STATES.contains(&s))
        && is_nullable_string(get("publicId"))
        && is_nullable_string(get("prefix"))
        && is_nullable_string(get("errorMessage"))
        && is_nullable_object(get("errorDetail"))
        && get("createdAt").is_some_and(Value::is_string)
        && get("updatedAt").is_some_and(Value::is_string)
        && is_nullable_string(get("startedAt"))
        && is_nullable_string(get("finishedAt"))
        && is_nullable_object(get("registered"))
        && absent_or(get("registerPayload"), |v| is_nullable_object(Some(v)))
        && absent_or(get("siteOrigin"), Value::is_string)
        && absent_or(get("tmpDir"), Value::is_string)
        && absent_or(get("registerStarted"), Value::is_boolean)
        && absent_or(get("mode"), |v| v.as_str() == Some("resume"))
        && absent_or(get("thumbnailUrl"), Value::is_string)
}

/// Structural check of a parsed store file (current schema). Does not repair anything.
pub fn is_valid_app_data(data: &Value) -> bool {
    let Some(root) = data.as_object() else {
        return false;
    };

    if !root.get("schemaVersion").is_some_and(Value::is_number) {
        return false;
    }

    let Some(settings) = root.get("settings").and_then(Value::as_object) else {
        return false;
    };

    if !(settings.get("siteUrl").is_some_and(Value::is_string)
        && settings.get("tmpRoot").is_some_and(Value::is_string)
        && settings.get("maxConcurrent").is_some_and(Value::is_number)
        && absent_or(settings.get("username"), Value::is_string))
    {
        return false;
    }

    root.get("jobs")
        .and_then(Value::as_array)
        .is_some_and(|jobs| jobs.iter().all(is_valid_job))
}

pub fn create_app_store(options: AppStoreOptions) -> AppStore {
    let default_tmp_root = options.default_tmp_root;
    let for_defaults = default_tmp_root.clone();
    let mut o = JsonStoreOptions::new(
        options.dir.join(STORE_FILE_NAME),
        APP_SCHEMA_VERSION,
        move || create_default_app_data(&for_defaults),
    );

    // Only schema version 1 exists today, so there is nothing to migrate yet; future versions add
    // `if from_version < N` steps here. Older/unknown shapes fall back to defaults (as in Electron).
    o.migrate = Some(Box::new(move |_old, _from_version| {
        serde_json::to_value(create_default_app_data(&default_tmp_root)).map_err(|e| e.to_string())
    }));
    o.validate = Some(Box::new(is_valid_app_data));
    o.debounce = options.debounce.unwrap_or(DEFAULT_DEBOUNCE);

    if let Some(ops) = options.file_ops {
        o.file_ops = ops;
    }

    o.on_error = options.on_error;

    JsonStore::new(o)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    fn options(dir: &std::path::Path, tmp: &str) -> AppStoreOptions {
        AppStoreOptions {
            dir: dir.to_path_buf(),
            default_tmp_root: tmp.into(),
            debounce: Some(Duration::from_millis(1)),
            file_ops: None,
            on_error: None,
        }
    }

    #[test]
    fn starts_with_default_settings_and_persists_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = create_app_store(options(dir.path(), "/tmp/hls"));
        let data = store.load();

        assert_eq!(data.schema_version, 1);
        assert_eq!(data.settings.site_url, "");
        assert_eq!(data.settings.tmp_root, "/tmp/hls");
        assert_eq!(data.settings.max_concurrent_u32(), 1);
        assert!(data.jobs.is_empty());

        store.update(|d| d.settings.site_url = "https://example.com".into());
        store.flush();

        let reopened = create_app_store(options(dir.path(), "/tmp/other"));

        assert_eq!(reopened.load().settings.site_url, "https://example.com");
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(STORE_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(saved["schemaVersion"], 1);
    }

    #[test]
    fn store_written_before_the_site_url_became_a_build_time_constant_loads_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let old = json!({
            "schemaVersion": 1,
            "settings": {
                "siteUrl": "https://picked-by-user.example.com",
                "tmpRoot": "/tmp/old",
                "maxConcurrent": 2,
                "username": "alice"
            },
            "jobs": []
        });
        fs::write(dir.path().join(STORE_FILE_NAME), old.to_string()).unwrap();

        let store = create_app_store(options(dir.path(), "/tmp/hls"));

        assert_eq!(serde_json::to_value(store.load()).unwrap(), old);
    }

    #[test]
    fn an_electron_document_round_trips_byte_for_byte_in_shape() {
        let dir = tempfile::tempdir().unwrap();
        let doc = json!({
            "schemaVersion": 1,
            "settings": { "siteUrl": "", "tmpRoot": "C:\\Temp\\hls-r2-studio", "maxConcurrent": 2 },
            "jobs": [{
                "id": "j1", "sourcePath": "D:\\v\\a.mp4", "sizeBytes": 123456789012u64,
                "state": "upload_interrupted", "publicId": "aaaaaaaaaaaa", "prefix": "videos/aaaaaaaaaaaa",
                "errorMessage": null, "errorDetail": { "step": "uploading", "exitCode": null, "stderrTail": [] },
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
                "startedAt": "2026-01-01T00:00:01.000Z", "finishedAt": null,
                "siteOrigin": "https://a.test", "registerPayload": null, "tmpDir": "C:\\Temp\\x",
                "registerStarted": false, "mode": "resume", "registered": null,
                "someFutureField": [1, 2]
            }],
            "futureTopLevel": true
        });
        fs::write(dir.path().join(STORE_FILE_NAME), doc.to_string()).unwrap();

        let store = create_app_store(options(dir.path(), "/tmp/hls"));
        store.load();
        store.update(|_| ());
        store.flush();

        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(STORE_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(saved, doc);
    }

    fn settings() -> Value {
        json!({ "siteUrl": "", "tmpRoot": "/tmp/x", "maxConcurrent": 1 })
    }

    fn job() -> Value {
        json!({
            "id": "j1", "sourcePath": "/v/a.mp4", "sizeBytes": 10, "state": "done",
            "publicId": null, "prefix": null, "errorMessage": null, "errorDetail": null,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "startedAt": null, "finishedAt": null, "registered": null
        })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;

        base
    }

    fn doc(jobs: Vec<Value>) -> Value {
        json!({ "schemaVersion": 1, "settings": settings(), "jobs": jobs })
    }

    #[test]
    fn accepts_valid_data_optional_fields_and_old_job_records_without_site_origin() {
        assert!(is_valid_app_data(&doc(vec![])));

        let with_username = json!({
            "schemaVersion": 1,
            "settings": with(settings(), "username", json!("a")),
            "jobs": [
                job(),
                with(with(job(), "siteOrigin", json!("https://a.test")), "registerPayload", Value::Null)
            ]
        });
        assert!(is_valid_app_data(&with_username));
    }

    #[test]
    fn accepts_upload_interrupted_jobs_with_the_new_optional_fields() {
        let mut paused = with(job(), "state", json!("upload_interrupted"));
        paused["tmpDir"] = json!("/tmp/hls/aaaaaaaaaaaa");
        paused["registerStarted"] = json!(false);
        paused["mode"] = json!("resume");
        paused["registerPayload"] = json!({ "public_id": "aaaaaaaaaaaa" });

        assert!(is_valid_app_data(&doc(vec![paused])));
    }

    #[test]
    fn rejects_malformed_documents() {
        let mut missing_id = job();
        missing_id.as_object_mut().unwrap().remove("id");

        let cases: Vec<(&str, Value)> = vec![
            ("non-object", json!(5)),
            (
                "missing jobs",
                json!({ "schemaVersion": 1, "settings": settings() }),
            ),
            (
                "missing settings",
                json!({ "schemaVersion": 1, "jobs": [] }),
            ),
            (
                "jobs not an array",
                json!({ "schemaVersion": 1, "settings": settings(), "jobs": {} }),
            ),
            (
                "bad schemaVersion",
                json!({ "schemaVersion": "1", "settings": settings(), "jobs": [] }),
            ),
            (
                "bad settings type",
                json!({ "schemaVersion": 1, "settings": with(settings(), "maxConcurrent", json!("1")), "jobs": [] }),
            ),
            ("bad tmpDir", doc(vec![with(job(), "tmpDir", json!(5))])),
            (
                "bad registerStarted",
                doc(vec![with(job(), "registerStarted", json!("yes"))]),
            ),
            ("bad mode", doc(vec![with(job(), "mode", json!("other"))])),
            ("bad job state", doc(vec![with(job(), "state", json!("x"))])),
            ("job missing id", doc(vec![missing_id])),
            ("job is null", doc(vec![Value::Null])),
            (
                "bad siteOrigin",
                doc(vec![with(job(), "siteOrigin", json!(5))]),
            ),
        ];

        for (name, data) in cases {
            assert!(!is_valid_app_data(&data), "{name}");
        }
    }

    #[test]
    fn backs_up_a_file_without_jobs_or_settings_and_starts_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let text = json!({ "schemaVersion": 1 }).to_string();
        fs::write(dir.path().join(STORE_FILE_NAME), &text).unwrap();

        let store = create_app_store(options(dir.path(), "/tmp/hls"));
        let data = store.load();

        assert!(data.jobs.is_empty());
        assert_eq!(data.settings.tmp_root, "/tmp/hls");
        assert_eq!(
            fs::read_to_string(dir.path().join(format!("{STORE_FILE_NAME}.bak"))).unwrap(),
            text
        );
    }

    #[test]
    fn a_file_without_schema_version_is_migrated_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE_NAME), r#"{"jobs":[]}"#).unwrap();

        let store = create_app_store(options(dir.path(), "/tmp/hls"));

        assert_eq!(store.load(), create_default_app_data("/tmp/hls"));
        store.flush();
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(STORE_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(saved["schemaVersion"], 1);
    }
}
