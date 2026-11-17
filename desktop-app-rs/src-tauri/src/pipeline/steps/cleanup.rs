//! Best-effort removal of everything under an R2 prefix (after a failed or cancelled job).
//! Port of steps/cleanup.ts over the [`ObjectStore`] trait (production: `pipeline::s3::R2Client`
//! created with the `Cleanup` purpose).

use serde_json::json;

use crate::logger::Log;
use crate::pipeline::deps::ObjectStore;
use crate::pipeline::prefix::is_valid_prefix;

pub const DELETE_BATCH_SIZE: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteResult {
    /// False when the prefix was refused or an error stopped the cleanup.
    pub ok: bool,
    pub deleted: usize,
}

/// The 12 character public id at the end of `.../<slug>-<publicId>/`, or `None`.
fn public_id_of(prefix: &str) -> Option<&str> {
    let body = prefix.strip_suffix('/')?;
    let cut = body.len().checked_sub(12)?;
    let (head, id) = (body.get(..cut)?, body.get(cut..)?);

    (head.ends_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
    .then_some(id)
}

/// Lists the prefix page by page and deletes each page in one batch (max 1000 keys). Never
/// fails: errors are logged and reported through the result. Refuses any prefix that does not
/// pass the strict `YYYY/MM/DD/<slug>-<publicId>/` check, so an empty or short prefix can never
/// wipe a bucket.
pub async fn delete_r2_prefix(
    store: &dyn ObjectStore,
    bucket: &str,
    prefix: &str,
    logger: Option<&dyn Log>,
) -> DeleteResult {
    let valid = public_id_of(prefix).is_some_and(|id| is_valid_prefix(prefix, id));

    if !valid {
        if let Some(logger) = logger {
            logger.error("Refusing to delete an invalid R2 prefix.", None);
        }

        return DeleteResult {
            ok: false,
            deleted: 0,
        };
    }

    let mut deleted = 0;
    let mut token: Option<String> = None;

    loop {
        let page = match store
            .list_page(
                bucket,
                prefix,
                Some(DELETE_BATCH_SIZE),
                token.as_deref(),
                None,
            )
            .await
        {
            Ok(page) => page,
            Err(error) => return stopped(logger, &error.to_string(), deleted),
        };
        let keys: Vec<String> = page
            .keys()
            .filter(|k| k.starts_with(prefix))
            .map(str::to_string)
            .collect();

        if !keys.is_empty() {
            match store.delete_keys(bucket, &keys).await {
                Ok(failures) => {
                    deleted += keys.len().saturating_sub(failures);

                    if failures > 0 {
                        if let Some(logger) = logger {
                            logger.warn(
                                "Some R2 objects could not be deleted.",
                                Some(json!({ "failures": failures })),
                            );
                        }
                    }
                }
                Err(error) => return stopped(logger, &error.to_string(), deleted),
            }
        }

        token = page.next_token;

        if token.is_none() {
            return DeleteResult { ok: true, deleted };
        }
    }
}

fn stopped(logger: Option<&dyn Log>, error: &str, deleted: usize) -> DeleteResult {
    if let Some(logger) = logger {
        logger.warn(
            "Cleaning up the R2 prefix failed (best effort).",
            Some(json!({ "error": error })),
        );
    }

    DeleteResult { ok: false, deleted }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logger::testing::RecordingLogger;
    use crate::pipeline::deps::{ListPage, ListedObject, PutFileRequest, StoreError};
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;

    const PREFIX: &str = "2026/03/05/my-video-ab12cd34ef56/";

    /// Pages of keys; `delete_failures` per delete call; optional errors.
    struct FakeStore {
        pages: Vec<Vec<String>>,
        failures_per_delete: usize,
        fail_list_at: Option<usize>,
        fail_delete: bool,
        listed: Mutex<Vec<Option<String>>>,
        deleted_batches: Mutex<Vec<Vec<String>>>,
    }

    impl FakeStore {
        fn new(pages: Vec<Vec<String>>) -> Self {
            Self {
                pages,
                failures_per_delete: 0,
                fail_list_at: None,
                fail_delete: false,
                listed: Mutex::default(),
                deleted_batches: Mutex::default(),
            }
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for FakeStore {
        async fn list_page(
            &self,
            _bucket: &str,
            _prefix: &str,
            max_keys: Option<usize>,
            token: Option<&str>,
            _cancel: Option<&CancellationToken>,
        ) -> Result<ListPage, StoreError> {
            assert_eq!(max_keys, Some(1000));

            let index = token.map_or(0, |t| t.parse::<usize>().unwrap());

            self.listed.lock().unwrap().push(token.map(str::to_string));

            if self.fail_list_at == Some(index) {
                return Err(StoreError::Http {
                    status: 403,
                    code: Some("AccessDenied".into()),
                });
            }

            Ok(ListPage {
                objects: self.pages[index]
                    .iter()
                    .map(|key| ListedObject {
                        key: key.clone(),
                        size: Some(1),
                    })
                    .collect(),
                next_token: (index + 1 < self.pages.len()).then(|| (index + 1).to_string()),
            })
        }

        async fn delete_keys(&self, _bucket: &str, keys: &[String]) -> Result<usize, StoreError> {
            if self.fail_delete {
                return Err(StoreError::Network("boom".into()));
            }

            self.deleted_batches.lock().unwrap().push(keys.to_vec());

            Ok(self.failures_per_delete)
        }

        async fn put_file(
            &self,
            _request: PutFileRequest<'_>,
            _cancel: &CancellationToken,
        ) -> Result<(), StoreError> {
            unreachable!("the cleanup never uploads")
        }
    }

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| format!("{PREFIX}{n}")).collect()
    }

    #[tokio::test]
    async fn deletes_every_page_in_batches() {
        let store = FakeStore::new(vec![keys(&["a", "b"]), keys(&["c"])]);
        let result = delete_r2_prefix(&store, "bucket", PREFIX, None).await;

        assert_eq!(
            result,
            DeleteResult {
                ok: true,
                deleted: 3
            }
        );
        assert_eq!(store.deleted_batches.lock().unwrap().len(), 2);
        assert_eq!(
            *store.listed.lock().unwrap(),
            vec![None, Some("1".to_string())]
        );
    }

    #[tokio::test]
    async fn an_empty_listing_is_ok() {
        let store = FakeStore::new(vec![vec![]]);

        assert_eq!(
            delete_r2_prefix(&store, "b", PREFIX, None).await,
            DeleteResult {
                ok: true,
                deleted: 0
            }
        );
        assert!(store.deleted_batches.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn never_deletes_keys_outside_the_prefix() {
        let mut page = keys(&["a"]);

        page.push("other/x".into());

        let store = FakeStore::new(vec![page]);
        let result = delete_r2_prefix(&store, "b", PREFIX, None).await;

        assert_eq!(result.deleted, 1);
        assert_eq!(store.deleted_batches.lock().unwrap()[0], keys(&["a"]));
    }

    #[tokio::test]
    async fn refuses_invalid_prefixes_without_touching_the_store() {
        for prefix in [
            "",
            "/",
            "2026/",
            "2026/03/05/video/",
            "x/2026/03/05/v-ab12cd34ef56/",
            "2026/03/05/-ab12cd34ef56/",
        ] {
            let store = FakeStore::new(vec![keys(&["a"])]);
            let logger = RecordingLogger::default();
            let result = delete_r2_prefix(&store, "b", prefix, Some(&logger)).await;

            assert_eq!(
                result,
                DeleteResult {
                    ok: false,
                    deleted: 0
                },
                "{prefix:?}"
            );
            assert!(store.listed.lock().unwrap().is_empty());
            assert!(logger.text().contains("Refusing to delete"));
        }
    }

    #[tokio::test]
    async fn counts_partial_delete_failures() {
        let mut store = FakeStore::new(vec![keys(&["a", "b", "c"])]);

        store.failures_per_delete = 2;

        let logger = RecordingLogger::default();
        let result = delete_r2_prefix(&store, "b", PREFIX, Some(&logger)).await;

        assert_eq!(
            result,
            DeleteResult {
                ok: true,
                deleted: 1
            }
        );
        assert!(logger.text().contains("could not be deleted"));
    }

    #[tokio::test]
    async fn a_list_error_stops_the_cleanup_and_reports_what_was_deleted() {
        let mut store = FakeStore::new(vec![keys(&["a"]), keys(&["b"])]);

        store.fail_list_at = Some(1);

        let logger = RecordingLogger::default();
        let result = delete_r2_prefix(&store, "b", PREFIX, Some(&logger)).await;

        assert_eq!(
            result,
            DeleteResult {
                ok: false,
                deleted: 1
            }
        );
        assert!(logger.text().contains("best effort"));
    }

    #[tokio::test]
    async fn a_delete_error_stops_the_cleanup() {
        let mut store = FakeStore::new(vec![keys(&["a"])]);

        store.fail_delete = true;

        assert_eq!(
            delete_r2_prefix(&store, "b", PREFIX, None).await,
            DeleteResult {
                ok: false,
                deleted: 0
            }
        );
    }

    #[test]
    fn extracts_the_public_id() {
        assert_eq!(public_id_of(PREFIX), Some("ab12cd34ef56"));
        assert_eq!(public_id_of("abc/"), None);
        assert_eq!(public_id_of("x-ABCDEFGHIJKL/"), None);
        assert_eq!(public_id_of("x_ab12cd34ef56/"), None);
        assert_eq!(public_id_of("x-ab12cd34ef56"), None);
    }
}
