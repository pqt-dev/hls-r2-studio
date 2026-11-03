import { describe, expect, it, vi } from 'vitest';
import { createQuitCoordinator } from './quitCoordinator';

function setup(active: boolean, answer = true) {
    const state = { active };
    const order: string[] = [];
    const deps = {
        hasActiveJobs: () => state.active,
        confirm: vi.fn(() => {
            order.push('confirm');

            return Promise.resolve(answer);
        }),
        shutdown: vi.fn(() => {
            order.push('shutdown');
            state.active = false;

            return Promise.resolve();
        }),
        flush: vi.fn(() => {
            order.push('flush');

            return Promise.resolve();
        }),
        quit: vi.fn(() => order.push('quit')),
    };
    const coordinator = createQuitCoordinator(deps);
    const event = () => ({ preventDefault: vi.fn() });

    return { coordinator, deps, order, event };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('quitCoordinator', () => {
    it('lets the window close freely when nothing runs', () => {
        const t = setup(false);
        const e = t.event();
        t.coordinator.handleWindowClose(e, vi.fn());

        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(t.deps.confirm).not.toHaveBeenCalled();
    });

    it('asks before closing the window while jobs run, and closes after confirmation', async () => {
        const t = setup(true);
        const e = t.event();
        const close = vi.fn();
        t.coordinator.handleWindowClose(e, close);
        await tick();

        expect(e.preventDefault).toHaveBeenCalled();
        expect(t.deps.confirm).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);

        // The re-issued close is not blocked again.
        const second = t.event();
        t.coordinator.handleWindowClose(second, close);
        expect(second.preventDefault).not.toHaveBeenCalled();
    });

    it('keeps the window open when the user declines', async () => {
        const t = setup(true, false);
        const close = vi.fn();
        t.coordinator.handleWindowClose(t.event(), close);
        await tick();

        expect(close).not.toHaveBeenCalled();
    });

    it('quit with running jobs: confirm, abort/cleanup, flush, then quit', async () => {
        const t = setup(true);
        const e = t.event();
        t.coordinator.handleBeforeQuit(e);
        await tick();

        expect(e.preventDefault).toHaveBeenCalled();
        expect(t.order).toEqual(['confirm', 'shutdown', 'flush', 'quit']);

        const again = t.event();
        t.coordinator.handleBeforeQuit(again);
        expect(again.preventDefault).not.toHaveBeenCalled();
    });

    it('quit without jobs does not ask but still flushes', async () => {
        const t = setup(false);
        t.coordinator.handleBeforeQuit(t.event());
        await tick();

        expect(t.order).toEqual(['shutdown', 'flush', 'quit']);
    });

    it('declining the quit cancels it', async () => {
        const t = setup(true, false);
        t.coordinator.handleBeforeQuit(t.event());
        await tick();

        expect(t.deps.shutdown).not.toHaveBeenCalled();
        expect(t.deps.quit).not.toHaveBeenCalled();
    });

    it('still quits when shutdown throws', async () => {
        const t = setup(false);
        t.deps.shutdown.mockRejectedValueOnce(new Error('x'));
        t.coordinator.handleBeforeQuit(t.event());
        await tick();

        expect(t.deps.quit).toHaveBeenCalled();
    });
});
