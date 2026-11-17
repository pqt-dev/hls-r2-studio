//! Bounded concurrency helper (port of pool.ts).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::JoinSet;

/// Runs `worker` for every item with at most `concurrency` in flight (at least 1). Items are
/// handed out in order. After the first failure no new item is started; the call waits for the
/// in-flight workers to settle, then returns that first error.
///
/// The items are cloned into the workers (spawned tasks need owned values); pass `Arc`s or small
/// values. A panicking worker panics the caller, like an unhandled rejection would.
pub async fn run_pool<T, E, F, Fut>(items: Vec<T>, concurrency: usize, worker: F) -> Result<(), E>
where
    T: Clone + Send + Sync + 'static,
    E: Send + 'static,
    F: Fn(T, usize) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<(), E>> + Send + 'static,
{
    let total = items.len();
    let items = Arc::new(items);
    let worker = Arc::new(worker);
    let next = Arc::new(AtomicUsize::new(0));
    let failure: Arc<Mutex<Option<E>>> = Arc::new(Mutex::new(None));
    let lanes = concurrency.max(1).min(total);
    let mut set = JoinSet::new();

    for _ in 0..lanes {
        let (items, worker, next, failure) = (
            Arc::clone(&items),
            Arc::clone(&worker),
            Arc::clone(&next),
            Arc::clone(&failure),
        );

        set.spawn(async move {
            loop {
                if failure.lock().expect("pool failure lock").is_some() {
                    return;
                }

                let index = next.fetch_add(1, Ordering::SeqCst);

                let Some(item) = items.get(index) else { return };

                if let Err(error) = worker(item.clone(), index).await {
                    failure
                        .lock()
                        .expect("pool failure lock")
                        .get_or_insert(error);
                }
            }
        });
    }

    while let Some(joined) = set.join_next().await {
        if let Err(error) = joined {
            if error.is_panic() {
                std::panic::resume_unwind(error.into_panic());
            }
        }
    }

    let first = failure.lock().expect("pool failure lock").take();

    match first {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn never_exceeds_the_concurrency_and_processes_every_item() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));

        let result: Result<(), String> = run_pool((1..=8).collect(), 3, {
            let (active, peak, seen) = (active.clone(), peak.clone(), seen.clone());

            move |item: i32, _index| {
                let (active, peak, seen) = (active.clone(), peak.clone(), seen.clone());

                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    seen.lock().unwrap().push(item);
                    active.fetch_sub(1, Ordering::SeqCst);

                    Ok(())
                }
            }
        })
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(peak.load(Ordering::SeqCst), 3);

        let mut seen = seen.lock().unwrap().clone();

        seen.sort_unstable();

        assert_eq!(seen, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[tokio::test]
    async fn stops_starting_new_items_after_a_failure_and_waits_for_in_flight_ones() {
        let started = Arc::new(Mutex::new(Vec::new()));
        let finished_in_flight = Arc::new(Mutex::new(false));

        let result: Result<(), String> = run_pool((1..=6).collect(), 2, {
            let (started, finished) = (started.clone(), finished_in_flight.clone());

            move |item: i32, _index| {
                let (started, finished) = (started.clone(), finished.clone());

                async move {
                    started.lock().unwrap().push(item);

                    if item == 1 {
                        // Fail after the other lane has started its own item.
                        tokio::time::sleep(Duration::from_millis(2)).await;

                        return Err("boom".to_string());
                    }

                    tokio::time::sleep(Duration::from_millis(20)).await;
                    *finished.lock().unwrap() = true;

                    Ok(())
                }
            }
        })
        .await;

        assert_eq!(result, Err("boom".to_string()));
        assert!(*finished_in_flight.lock().unwrap());
        assert!(started.lock().unwrap().len() < 6);
    }

    #[tokio::test]
    async fn keeps_the_first_error() {
        let result: Result<(), usize> = run_pool(
            vec![1, 2, 3],
            1,
            |_item: i32, index| async move { Err(index) },
        )
        .await;

        assert_eq!(result, Err(0));
    }

    #[tokio::test]
    async fn handles_an_empty_list_and_zero_concurrency() {
        let empty: Result<(), String> =
            run_pool(Vec::<i32>::new(), 5, |_item, _index| async { Ok(()) }).await;

        assert_eq!(empty, Ok(()));

        let count = Arc::new(AtomicUsize::new(0));
        let zero: Result<(), String> = run_pool(vec![1, 2, 3], 0, {
            let count = count.clone();

            move |_item: i32, _index| {
                let count = count.clone();

                async move {
                    count.fetch_add(1, Ordering::SeqCst);

                    Ok(())
                }
            }
        })
        .await;

        assert_eq!(zero, Ok(()));
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }
}
