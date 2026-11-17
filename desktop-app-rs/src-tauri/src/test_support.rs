//! Async test helpers shared by the config and auth tests (`deferred()` and `tick()` of the TS
//! tests).

use std::future::Future;
use std::sync::Arc;

use tokio::sync::watch;

/// A value that is provided later; any number of waiters get a clone of it.
pub struct Deferred<T> {
    tx: watch::Sender<Option<T>>,
}

impl<T: Clone + Send + Sync + 'static> Deferred<T> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            tx: watch::Sender::new(None),
        })
    }

    pub fn resolve(&self, value: T) {
        self.tx.send_replace(Some(value));
    }

    pub fn wait(&self) -> impl Future<Output = T> + Send + 'static {
        let mut rx = self.tx.subscribe();

        async move {
            let value = rx
                .wait_for(Option::is_some)
                .await
                .expect("deferred dropped");

            value.clone().expect("checked by wait_for")
        }
    }
}

/// Lets every spawned task run until it waits on something (the TS `setTimeout(0)` tick).
pub async fn tick() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}
