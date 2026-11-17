//! Test helper: a logger that keeps every entry in memory (`recordingLogger` in the TS tests).

use std::sync::Mutex;

use serde_json::Value;

use super::{Log, LogLevel};

#[derive(Default)]
pub struct RecordingLogger {
    pub entries: Mutex<Vec<(LogLevel, String, Option<Value>)>>,
}

impl RecordingLogger {
    /// Every message and field, as one searchable text.
    pub fn text(&self) -> String {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(level, message, meta)| {
                format!(
                    "{level:?} {message} {}",
                    meta.as_ref().map(Value::to_string).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn messages(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, message, _)| message.clone())
            .collect()
    }
}

impl Log for RecordingLogger {
    fn log(&self, level: LogLevel, message: &str, meta: Option<Value>) {
        self.entries
            .lock()
            .unwrap()
            .push((level, message.to_string(), meta));
    }
}
