import { describe, expect, it, vi } from 'vitest';
import { IpcChannels, IpcEvents } from '../../shared/ipc';
import type { AuthState, JobDto, QueueSummary } from '../../shared/ipc';
import type { JobRecord } from '../../shared/types';
import { createHandlers, type HandlerDeps } from './handlers';
import type { NoticesOutcome } from './notices';
import { isEmbedUrlOfSite, MAX_ADD_PATHS } from './jobsHandlers';
import { wirePushEvents } from './pushEvents';
import { createSenderGuard } from './senderGuard';
import {
    expectInt,
    expectJobId,
    expectNoArgs,
    expectOneOf,
    expectPlainObject,
    expectSingleObject,
    expectString,
    expectStringArray,
    IpcValidationError,
} from './validate';

describe('validators', () => {
    it('expectNoArgs rejects extra arguments', () => {
        expect(() => expectNoArgs([])).not.toThrow();
        expect(() => expectNoArgs([1])).toThrow(IpcValidationError);
    });

    it('expectString checks type and length', () => {
        expect(expectString('abc', 'x')).toBe('abc');
        expect(() => expectString(5, 'x')).toThrow(IpcValidationError);
        expect(() => expectString('a'.repeat(11), 'x', 10)).toThrow(IpcValidationError);
    });

    it('expectPlainObject rejects null, arrays and primitives', () => {
        expect(expectPlainObject({ a: 1 }, 'x')).toEqual({ a: 1 });
        for (const bad of [null, [], 'str', 1, undefined]) {
            expect(() => expectPlainObject(bad, 'x')).toThrow(IpcValidationError);
        }
    });

    it('expectInt enforces integers in range', () => {
        expect(expectInt(2, 'n', 1, 2)).toBe(2);
        for (const bad of [0, 3, 1.5, '1', NaN, null]) {
            expect(() => expectInt(bad, 'n', 1, 2)).toThrow(IpcValidationError);
        }
    });

    it('expectOneOf and expectStringArray', () => {
        expect(expectOneOf('a', 'k', ['a', 'b'])).toBe('a');
        expect(() => expectOneOf('c', 'k', ['a', 'b'])).toThrow(IpcValidationError);
        expect(() => expectOneOf(1, 'k', ['a'])).toThrow(IpcValidationError);

        expect(expectStringArray(['a', 'b'], 'p', 5)).toEqual(['a', 'b']);
        expect(() => expectStringArray('a', 'p', 5)).toThrow(IpcValidationError);
        expect(() => expectStringArray(['a', 1], 'p', 5)).toThrow(IpcValidationError);
        expect(() => expectStringArray(['a', 'b', 'c'], 'p', 2)).toThrow(IpcValidationError);
        expect(() => expectStringArray(['a'.repeat(11)], 'p', 2, 10)).toThrow(IpcValidationError);
    });

    it('expectJobId accepts safe ids only', () => {
        expect(expectJobId('a1-b_2')).toBe('a1-b_2');
        for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 5]) {
            expect(() => expectJobId(bad)).toThrow(IpcValidationError);
        }
    });

    it('expectSingleObject rejects missing, extra and unknown keys', () => {
        expect(expectSingleObject([{ id: 'a' }], 'x', ['id'])).toEqual({ id: 'a' });
        expect(() => expectSingleObject([], 'x', ['id'])).toThrow(IpcValidationError);
        expect(() => expectSingleObject([{}, {}], 'x', ['id'])).toThrow(IpcValidationError);
        expect(() => expectSingleObject([{ id: 'a', evil: 1 }], 'x', ['id'])).toThrow(
            IpcValidationError,
        );
        expect(() => expectSingleObject(['a'], 'x', ['id'])).toThrow(IpcValidationError);
    });
});

/** Passes whether the handler throws synchronously or returns a rejected promise. */
async function expectInvalid(run: () => unknown): Promise<void> {
    await expect(Promise.resolve().then(run)).rejects.toBeInstanceOf(IpcValidationError);
}

const EMBED = 'https://site.example.com/embed/abc123';

function job(partial: Partial<JobRecord> = {}): JobRecord {
    return {
        id: 'j1',
        sourcePath: '/v/a.mp4',
        sizeBytes: 1,
        state: 'done',
        publicId: 'abc123',
        prefix: null,
        errorMessage: null,
        errorDetail: null,
        createdAt: '',
        updatedAt: '',
        startedAt: null,
        finishedAt: null,
        registered: { id: 1, public_id: 'abc123', embed_url: EMBED },
        ...partial,
    };
}

function setup(
    opts: {
        job?: JobRecord | undefined;
        siteUrl?: string | undefined;
        picked?: string[] | null;
        pickedDir?: string | null;
        notices?: NoticesOutcome;
    } = {},
) {
    const record = 'job' in opts ? opts.job : job();
    const queue = {
        list: vi.fn((): JobDto[] => []),
        addFiles: vi.fn((paths: readonly string[]) =>
            Promise.resolve({ added: paths.length, rejected: [] }),
        ),
        cancel: vi.fn(() => Promise.resolve({ ok: true as const })),
        retry: vi.fn(() => Promise.resolve({ ok: true as const })),
        retryRegister: vi.fn(() => Promise.resolve({ ok: true as const })),
        remove: vi.fn(() => ({ ok: true as const })),
        clearFinished: vi.fn(() => ({ ok: true as const })),
        getJob: vi.fn(() => record),
    };
    const auth = {
        getState: vi.fn((): AuthState => ({ status: 'signed_out' })),
        login: vi.fn(() => Promise.resolve({ status: 'signed_in' } as AuthState)),
        logout: vi.fn(() => Promise.resolve({ status: 'signed_out' } as AuthState)),
        reloadConfig: vi.fn(() => Promise.resolve({ status: 'signed_in' } as AuthState)),
    };
    const settings = {
        get: vi.fn(() => ({ siteUrl: '', tmpRoot: '/t', maxConcurrent: 1 })),
        set: vi.fn(() =>
            Promise.resolve({
                ok: true as const,
                settings: { siteUrl: '', tmpRoot: '/t', maxConcurrent: 1 },
            }),
        ),
    };
    const clipboard: string[] = [];
    const opened: string[] = [];
    const deps: HandlerDeps = {
        getAppVersion: () => '1.2.3',
        getDiagnostics: () => ({
            appVersion: '1.2.3',
            platform: 'win32',
            ffmpeg: { checked: true, ok: true, version: '9', missing: [] },
        }),
        openLogsFolder: vi.fn(() => Promise.resolve('')),
        openNotices: vi.fn(() => Promise.resolve(opts.notices ?? 'opened')),
        pickDirectory: vi.fn(() =>
            Promise.resolve('pickedDir' in opts ? (opts.pickedDir ?? null) : '/chosen/tmp'),
        ),
        auth,
        settings,
        queue,
        getSiteUrl: () => ('siteUrl' in opts ? opts.siteUrl : 'https://site.example.com'),
        pickVideoFiles: vi.fn(() =>
            Promise.resolve('picked' in opts ? (opts.picked ?? null) : ['/v/a.mp4']),
        ),
        writeClipboard: (text) => void clipboard.push(text),
        openExternal: (url) => {
            opened.push(url);

            return Promise.resolve();
        },
    };
    const handlers = createHandlers(deps);
    const call = (channel: string, ...args: unknown[]) => {
        const handler = handlers[channel];
        if (!handler) throw new Error(`no handler ${channel}`);

        return handler(args);
    };

    return { call, queue, auth, settings, clipboard, opened, deps, handlers };
}

describe('handlers: coverage and validation', () => {
    it('registers a handler for every invoke channel', () => {
        const { handlers } = setup();
        expect(Object.keys(handlers).sort()).toEqual(Object.values(IpcChannels).sort());
    });

    it('rejects unexpected payloads on no-arg channels', async () => {
        const { call } = setup();
        for (const channel of [
            IpcChannels.appGetVersion,
            IpcChannels.diagnosticsGet,
            IpcChannels.appOpenLogsFolder,
            IpcChannels.appOpenNotices,
            IpcChannels.settingsPickDirectory,
            IpcChannels.authGetState,
            IpcChannels.authLogout,
            IpcChannels.authReloadConfig,
            IpcChannels.settingsGet,
            IpcChannels.jobsList,
            IpcChannels.jobsAddFiles,
            IpcChannels.jobsClearFinished,
        ]) {
            await expectInvalid(() => call(channel, 'unexpected'));
        }
    });

    it('rejects malformed payloads on payload channels', async () => {
        const { call, queue } = setup();
        for (const channel of [
            IpcChannels.jobsCancel,
            IpcChannels.jobsRetry,
            IpcChannels.jobsRetryRegister,
            IpcChannels.jobsRemove,
            IpcChannels.jobsOpenEmbed,
        ]) {
            await expectInvalid(() => call(channel));
            await expectInvalid(() => call(channel, 'j1'));
            await expectInvalid(() => call(channel, { id: '../x' }));
            await expectInvalid(() => call(channel, { id: 'j1', extra: 1 }));
        }
        await expectInvalid(() => call(IpcChannels.jobsCopy, { id: 'j1', kind: 'html' }));
        await expectInvalid(() => call(IpcChannels.jobsCopy, { id: 'j1' }));
        await expectInvalid(() => call(IpcChannels.authLogin, { siteUrl: 'x', username: 'a' }));
        await expectInvalid(() =>
            call(IpcChannels.authLogin, { siteUrl: 'x', username: 'a', password: 1 }),
        );
        await expectInvalid(() => call(IpcChannels.settingsSet, { evil: 1 }));
        await expectInvalid(() => call(IpcChannels.settingsSet, { siteUrl: 5 }));
        await expectInvalid(() => call(IpcChannels.settingsSet, { maxConcurrent: '2' }));
        await expectInvalid(() => call(IpcChannels.jobsAddPaths, { paths: 'x' }));
        await expectInvalid(() =>
            call(IpcChannels.jobsAddPaths, { paths: Array(MAX_ADD_PATHS + 1).fill('/a.mp4') }),
        );
        expect(queue.cancel).not.toHaveBeenCalled();
    });
});

describe('handlers: app', () => {
    it('returns version and diagnostics; reports logs folder failures', async () => {
        const t = setup();
        expect(await t.call(IpcChannels.appGetVersion)).toBe('1.2.3');
        expect(await t.call(IpcChannels.diagnosticsGet)).toMatchObject({
            platform: 'win32',
            ffmpeg: { ok: true },
        });
        expect(await t.call(IpcChannels.appOpenLogsFolder)).toEqual({ ok: true });

        vi.mocked(t.deps.openLogsFolder).mockResolvedValueOnce('ENOENT');
        expect(await t.call(IpcChannels.appOpenLogsFolder)).toMatchObject({ ok: false });
    });
});

describe('handlers: notices and directory picker', () => {
    it('open-notices maps the outcome to an ActionResult', async () => {
        expect(await setup().call(IpcChannels.appOpenNotices)).toEqual({ ok: true });
        expect(await setup({ notices: 'not_found' }).call(IpcChannels.appOpenNotices)).toEqual({
            ok: false,
            error: 'Notices file not found.',
        });
        expect(await setup({ notices: 'failed' }).call(IpcChannels.appOpenNotices)).toMatchObject({
            ok: false,
        });
    });

    it('pick-directory returns the chosen absolute path or a cancel', async () => {
        expect(await setup().call(IpcChannels.settingsPickDirectory)).toEqual({
            canceled: false,
            path: '/chosen/tmp',
        });
        expect(await setup({ pickedDir: null }).call(IpcChannels.settingsPickDirectory)).toEqual({
            canceled: true,
        });
        // A relative or empty path is never handed to the renderer.
        for (const bad of ['relative/dir', '']) {
            expect(await setup({ pickedDir: bad }).call(IpcChannels.settingsPickDirectory)).toEqual(
                { canceled: true },
            );
        }
    });
});

describe('handlers: auth and settings', () => {
    it('forwards login credentials and returns the new state', async () => {
        const t = setup();
        const result = await t.call(IpcChannels.authLogin, {
            siteUrl: 'https://s',
            username: 'u',
            password: 'p',
        });

        expect(t.auth.login).toHaveBeenCalledWith('https://s', 'u', 'p', true);
        expect(result).toEqual({ status: 'signed_in' });
    });

    it('passes staySignedIn=false and rejects a non-boolean value', async () => {
        const t = setup();
        await t.call(IpcChannels.authLogin, {
            siteUrl: 'https://s',
            username: 'u',
            password: 'p',
            staySignedIn: false,
        });

        expect(t.auth.login).toHaveBeenCalledWith('https://s', 'u', 'p', false);
        await expectInvalid(() =>
            t.call(IpcChannels.authLogin, {
                siteUrl: 'https://s',
                username: 'u',
                password: 'p',
                staySignedIn: 'no',
            }),
        );
    });

    it('forwards logout, reload and settings calls', async () => {
        const t = setup();
        await t.call(IpcChannels.authLogout);
        await t.call(IpcChannels.authReloadConfig);
        expect(await t.call(IpcChannels.settingsGet)).toMatchObject({ maxConcurrent: 1 });
        await t.call(IpcChannels.settingsSet, { maxConcurrent: 2, tmpRoot: '/x' });

        expect(t.auth.logout).toHaveBeenCalled();
        expect(t.auth.reloadConfig).toHaveBeenCalled();
        expect(t.settings.set).toHaveBeenCalledWith({ maxConcurrent: 2, tmpRoot: '/x' });
    });
});

describe('handlers: jobs', () => {
    it('add-files opens the dialog in main and enqueues the picked paths', async () => {
        const t = setup({ picked: ['/v/a.mp4', '/v/b.mp4'] });
        expect(await t.call(IpcChannels.jobsAddFiles)).toEqual({
            added: 2,
            rejected: [],
            canceled: false,
        });
        expect(t.queue.addFiles).toHaveBeenCalledWith(['/v/a.mp4', '/v/b.mp4']);
    });

    it('add-files reports a cancelled dialog', async () => {
        const t = setup({ picked: null });
        expect(await t.call(IpcChannels.jobsAddFiles)).toEqual({
            added: 0,
            rejected: [],
            canceled: true,
        });
        expect(t.queue.addFiles).not.toHaveBeenCalled();
    });

    it('add-paths passes dropped paths to the queue, which re-validates them', async () => {
        const t = setup();
        const result = await t.call(IpcChannels.jobsAddPaths, { paths: ['/v/a.mp4'] });

        expect(t.queue.addFiles).toHaveBeenCalledWith(['/v/a.mp4']);
        expect(result).toMatchObject({ added: 1, canceled: false });
    });

    it('routes cancel / retry / retry-register / remove / clear-finished', async () => {
        const t = setup();
        await t.call(IpcChannels.jobsCancel, { id: 'j1' });
        await t.call(IpcChannels.jobsRetry, { id: 'j1' });
        await t.call(IpcChannels.jobsRetryRegister, { id: 'j1' });
        await t.call(IpcChannels.jobsRemove, { id: 'j1' });
        await t.call(IpcChannels.jobsClearFinished);
        await t.call(IpcChannels.jobsList);

        expect(t.queue.cancel).toHaveBeenCalledWith('j1');
        expect(t.queue.retry).toHaveBeenCalledWith('j1');
        expect(t.queue.retryRegister).toHaveBeenCalledWith('j1');
        expect(t.queue.remove).toHaveBeenCalledWith('j1');
        expect(t.queue.clearFinished).toHaveBeenCalled();
        expect(t.queue.list).toHaveBeenCalled();
    });

    it('copy writes the embed URL or the shortcode', async () => {
        const t = setup();
        await t.call(IpcChannels.jobsCopy, { id: 'j1', kind: 'embed-url' });
        await t.call(IpcChannels.jobsCopy, { id: 'j1', kind: 'shortcode' });

        expect(t.clipboard).toEqual([EMBED, '[hls_embed_vl id="abc123"]']);
    });

    it('copy refuses unregistered jobs and unsafe public ids', async () => {
        const none = setup({ job: job({ registered: null }) });
        expect(
            await none.call(IpcChannels.jobsCopy, { id: 'j1', kind: 'embed-url' }),
        ).toMatchObject({ ok: false });

        const unsafe = setup({
            job: job({ registered: { id: 1, public_id: 'a"b', embed_url: EMBED } }),
        });
        expect(
            await unsafe.call(IpcChannels.jobsCopy, { id: 'j1', kind: 'shortcode' }),
        ).toMatchObject({ ok: false });
        expect(unsafe.clipboard).toEqual([]);

        const missing = setup({ job: undefined });
        expect(
            await missing.call(IpcChannels.jobsCopy, { id: 'zz', kind: 'embed-url' }),
        ).toMatchObject({ ok: false });
    });

    it('open-embed opens an https embed URL of the signed-in site only', async () => {
        const ok = setup();
        expect(await ok.call(IpcChannels.jobsOpenEmbed, { id: 'j1' })).toEqual({ ok: true });
        expect(ok.opened).toEqual([EMBED]);

        const otherHost = setup({
            job: job({
                registered: {
                    id: 1,
                    public_id: 'abc123',
                    embed_url: 'https://evil.example.com/embed/abc123',
                },
            }),
        });
        expect(await otherHost.call(IpcChannels.jobsOpenEmbed, { id: 'j1' })).toMatchObject({
            ok: false,
        });

        const http = setup({
            job: job({
                registered: {
                    id: 1,
                    public_id: 'abc123',
                    embed_url: 'http://site.example.com/embed/abc123',
                },
            }),
        });
        expect(await http.call(IpcChannels.jobsOpenEmbed, { id: 'j1' })).toMatchObject({
            ok: false,
        });

        const noSite = setup({ siteUrl: undefined });
        expect(await noSite.call(IpcChannels.jobsOpenEmbed, { id: 'j1' })).toMatchObject({
            ok: false,
        });

        const none = setup({ job: job({ registered: null }) });
        expect(await none.call(IpcChannels.jobsOpenEmbed, { id: 'j1' })).toMatchObject({
            ok: false,
        });

        for (const t of [otherHost, http, noSite, none]) expect(t.opened).toEqual([]);
    });
});

describe('isEmbedUrlOfSite', () => {
    it('compares hosts (including ports) and requires https on both', () => {
        expect(isEmbedUrlOfSite('https://a.com/x', 'https://a.com')).toBe(true);
        expect(isEmbedUrlOfSite('https://a.com:8443/x', 'https://a.com:8443')).toBe(true);
        expect(isEmbedUrlOfSite('https://a.com:8443/x', 'https://a.com')).toBe(false);
        expect(isEmbedUrlOfSite('https://a.com.evil.com/x', 'https://a.com')).toBe(false);
        expect(isEmbedUrlOfSite('https://user@a.com/x', 'https://a.com')).toBe(true); // rejected later by openExternalHttps
        expect(isEmbedUrlOfSite('not a url', 'https://a.com')).toBe(false);
        expect(isEmbedUrlOfSite('https://a.com/x', 'http://a.com')).toBe(false);
    });
});

describe('sender guard', () => {
    const location = { indexFileUrl: 'file:///app/renderer/index.html' };
    const frame = { url: 'file:///app/renderer/index.html' };
    const contents = { mainFrame: frame };
    const guard = (main: typeof contents | null) => createSenderGuard(() => main, location);
    const event = (sender: unknown, senderFrame: unknown) =>
        ({ sender, senderFrame }) as unknown as Parameters<ReturnType<typeof guard>>[0];

    it('accepts only the top frame of the app window showing the app page', () => {
        expect(guard(contents)(event(contents, frame))).toBe(true);
    });

    it('rejects other web contents, sub frames, foreign pages and a missing window', () => {
        expect(guard(contents)(event({ mainFrame: frame }, frame))).toBe(false);
        expect(guard(contents)(event(contents, { url: frame.url }))).toBe(false);
        const foreign = { url: 'https://evil.example.com/' };
        expect(guard({ mainFrame: foreign })(event({ mainFrame: foreign }, foreign))).toBe(false);
        expect(guard(contents)(event(contents, null))).toBe(false);
        expect(guard(null)(event(contents, frame))).toBe(false);
    });
});

describe('push events', () => {
    it('forwards auth, jobs and summary changes and can be unsubscribed', () => {
        const authListeners: ((s: AuthState) => void)[] = [];
        const jobListeners: ((j: JobDto[]) => void)[] = [];
        const summaryListeners: ((s: QueueSummary) => void)[] = [];
        const sent: [string, unknown][] = [];
        const unwire = wirePushEvents(
            {
                auth: {
                    subscribe: (l) =>
                        (authListeners.push(l), () => authListeners.pop()) as () => void,
                },
                queue: {
                    subscribe: (l) =>
                        (jobListeners.push(l), () => jobListeners.pop()) as () => void,
                    subscribeSummary: (l) =>
                        (summaryListeners.push(l), () => summaryListeners.pop()) as () => void,
                },
            },
            (channel, payload) => sent.push([channel, payload]),
        );

        authListeners[0]?.({ status: 'signed_out' });
        jobListeners[0]?.([]);
        summaryListeners[0]?.({
            running: 0,
            waiting: 0,
            attention: 0,
            done: 0,
            failed: 0,
            total: 0,
            blockedReason: null,
        });

        expect(sent.map(([c]) => c)).toEqual([
            IpcEvents.authChanged,
            IpcEvents.jobsUpdated,
            IpcEvents.queueSummary,
        ]);

        unwire();
        expect(authListeners).toHaveLength(0);
        expect(jobListeners).toHaveLength(0);
        expect(summaryListeners).toHaveLength(0);
    });
});
