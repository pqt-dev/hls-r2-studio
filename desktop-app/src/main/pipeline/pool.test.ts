import { describe, expect, it } from 'vitest';
import { runPool } from './pool';

describe('runPool', () => {
    it('never exceeds the concurrency and processes every item', async () => {
        let active = 0;
        let peak = 0;
        const seen: number[] = [];

        await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            seen.push(item);
            active--;
        });

        expect(peak).toBe(3);
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('stops starting new items after a failure and waits for in-flight ones', async () => {
        const started: number[] = [];
        let finishedInFlight = false;

        await expect(
            runPool([1, 2, 3, 4, 5, 6], 2, async (item) => {
                started.push(item);
                if (item === 1) throw new Error('boom');
                await new Promise((r) => setTimeout(r, 20));
                finishedInFlight = true;
            }),
        ).rejects.toThrow('boom');

        expect(finishedInFlight).toBe(true);
        expect(started.length).toBeLessThan(6);
    });

    it('handles an empty list', async () => {
        await expect(runPool([], 5, async () => undefined)).resolves.toBeUndefined();
    });
});
