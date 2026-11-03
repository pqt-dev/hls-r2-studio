/**
 * Runs `worker` for every item with at most `concurrency` in flight. After the first failure no
 * new item is started; the call waits for in-flight workers to settle, then rethrows that error.
 */
export async function runPool<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let next = 0;
    let failure: { error: unknown } | null = null;

    async function lane(): Promise<void> {
        while (failure === null) {
            const index = next++;
            const item = items[index];
            if (index >= items.length || item === undefined) return;

            try {
                await worker(item, index);
            } catch (error) {
                failure ??= { error };
            }
        }
    }

    const lanes = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, lane);
    await Promise.all(lanes);

    if (failure !== null) throw (failure as { error: unknown }).error;
}
