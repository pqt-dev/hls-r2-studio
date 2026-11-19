import { describe, expect, it, vi } from 'vitest';
import { IpcChannels, IpcEvents } from '../../shared/ipc';
import { setPendingDrop, PENDING_DROP_TTL_MS } from './lib/dropBridge';
import { commandName, createTauriApi, eventName } from './tauriApi';
import type { InvokeFn, ListenFn } from './tauriApi';

function setup(response: unknown = { ok: true }) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const call: InvokeFn = vi.fn((command, args) => {
        calls.push([command, args]);

        return Promise.resolve(response);
    });
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    const subscribeTo: ListenFn = vi.fn((event, handler) => {
        handlers.set(event, handler);

        return Promise.resolve(unlisten);
    });

    return { api: createTauriApi(call, subscribeTo), calls, handlers, unlisten };
}

describe('name mapping', () => {
    it('turns every channel into a valid command identifier', () => {
        for (const channel of Object.values(IpcChannels)) {
            expect(commandName(channel)).toMatch(/^[a-z]+(_[a-z]+)+$|^[a-z]+_[a-z]+$/);
        }
        expect(commandName('app:get-version')).toBe('app_get_version');
        expect(commandName('jobs:retry-register')).toBe('jobs_retry_register');
    });

    it('turns every event into a Tauri-safe event name', () => {
        expect(Object.values(IpcEvents).map(eventName)).toEqual([
            'auth-changed',
            'jobs-updated',
            'queue-summary',
        ]);
    });
});

describe('createTauriApi', () => {
    it('invokes commands with the same payload shapes as the Electron preload', async () => {
        const { api, calls } = setup();

        await api.app.getVersion();
        await api.auth.login('u', 'p');
        await api.auth.login('u', 'p', true);
        await api.settings.set({ maxConcurrent: 2 });
        await api.jobs.cancel('j1');
        await api.jobs.clearFinished();
        await api.videos.list();
        await api.videos.list({ page: 2, q: 'a' });
        await api.videos.get(7);
        await api.videos.copyLink(7, 'playlist-url');
        await api.videos.openEmbed(7);
        await api.videos.updateTitle(7, 'New');
        await api.videos.delete(7);
        await api.videos.bulkDelete([1, 2]);
        await api.videos.setImage(7);
        await api.videos.removeImage(7);
        await api.overview.get();
        await api.logs.get();
        await api.logs.get({ type: 'error', page: 2, perPage: 10 });

        expect(calls).toEqual([
            ['app_get_version', undefined],
            ['auth_login', { payload: { username: 'u', password: 'p' } }],
            ['auth_login', { payload: { username: 'u', password: 'p', staySignedIn: true } }],
            ['settings_set', { payload: { maxConcurrent: 2 } }],
            ['jobs_cancel', { payload: { id: 'j1' } }],
            ['jobs_clear_finished', undefined],
            ['videos_list', { payload: {} }],
            ['videos_list', { payload: { page: 2, q: 'a' } }],
            ['videos_get', { payload: { id: 7 } }],
            ['videos_copy_link', { payload: { id: 7, kind: 'playlist-url' } }],
            ['videos_open_embed', { payload: { id: 7 } }],
            ['videos_update_title', { payload: { id: 7, title: 'New' } }],
            ['videos_delete', { payload: { id: 7 } }],
            ['videos_bulk_delete', { payload: { ids: [1, 2] } }],
            ['videos_set_image', { payload: { id: 7 } }],
            ['videos_remove_image', { payload: { id: 7 } }],
            ['overview_get', undefined],
            ['logs_get', { payload: {} }],
            ['logs_get', { payload: { type: 'error', page: 2, perPage: 10 } }],
        ]);
    });

    it('subscribes to dash-named events and unsubscribes', async () => {
        const { api, handlers, unlisten } = setup();
        const listener = vi.fn();
        const stop = api.jobs.onSummary(listener);

        await Promise.resolve();
        handlers.get('queue-summary')?.({ payload: { total: 1 } });
        expect(listener).toHaveBeenCalledWith({ total: 1 });

        stop();
        expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it('rejects dropped files whose path is unknown instead of guessing', async () => {
        const { api, calls } = setup();
        const result = await api.jobs.addDroppedFiles([{ name: 'a.mp4' }]);

        expect(result).toEqual({
            added: 0,
            rejected: [{ name: 'a.mp4', reason: 'The file location could not be read' }],
            canceled: false,
        });
        expect(calls).toEqual([]);
    });

    describe('pending drop fallback', () => {
        const paths = ['/v/a.mp4', '/v/b.mov'];

        const added = { added: 2, rejected: [], canceled: false };

        it('uses the paths of the Tauri drop when the files are unregistered, once', async () => {
            const { api, calls } = setup(added);

            setPendingDrop(paths);
            await api.jobs.addDroppedFiles([{ name: 'a.mp4' }, { name: 'b.mov' }]);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.[1]).toEqual({ payload: { paths } });

            // Consumed: a later drop without paths adds nothing.
            const again = await api.jobs.addDroppedFiles([]);

            expect(again).toEqual({ added: 0, rejected: [], canceled: false });
            expect(calls).toHaveLength(1);
        });

        it('uses them for an empty file list', async () => {
            const { api, calls } = setup(added);

            setPendingDrop(paths);
            await api.jobs.addDroppedFiles([]);
            expect(calls).toHaveLength(1);
        });

        it('ignores them when older than 5 seconds', async () => {
            const { api, calls } = setup();

            setPendingDrop(paths, Date.now() - PENDING_DROP_TTL_MS - 1);

            const result = await api.jobs.addDroppedFiles([]);

            expect(result).toEqual({ added: 0, rejected: [], canceled: false });
            expect(calls).toEqual([]);
        });

        it('returns an empty result (nothing to toast) for an empty list without a pending drop', async () => {
            const { api, calls } = setup();

            expect(await api.jobs.addDroppedFiles([])).toEqual({
                added: 0,
                rejected: [],
                canceled: false,
            });
            expect(calls).toEqual([]);
        });
    });
});
