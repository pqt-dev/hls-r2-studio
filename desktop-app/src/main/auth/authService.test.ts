import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/appConfig';
import type { AuthState } from '../../shared/ipc';
import { SiteApiError } from '../api/siteClient';
import { createConfigService } from '../config/configService';
import { TokenVault } from '../secure';
import { createMemoryStore, fakeBackend, recordingLogger } from '../testing/memoryStore';
import { createAuthService, deviceNameOf, type AuthClient } from './authService';

const CONFIG: AppConfig = {
    r2: {
        access_key_id: 'a',
        secret_access_key: 's',
        bucket: 'b',
        endpoint: 'https://e',
        url: 'https://u',
    },
    transcode: { resolution: '720', segment_seconds: 6, fps: null },
};

function setup(
    opts: {
        login?: AuthClient['login'];
        logout?: AuthClient['logout'];
        getConfig?: () => Promise<AppConfig>;
        /** Site URL stored by an earlier session. */
        siteUrl?: string;
        /** The built-in site of this build (null = not configured). Default https://s.example.com. */
        builtIn?: string | null;
        token?: string;
    } = {},
) {
    const dir = mkdtempSync(join(tmpdir(), 'hls-auth-'));
    const vault = new TokenVault({ dir, backend: fakeBackend() });
    const store = createMemoryStore();
    if (opts.siteUrl !== undefined) {
        store.update((d) => {
            d.settings.siteUrl = opts.siteUrl ?? '';
        });
    }
    const client = {
        login: vi.fn(opts.login ?? (() => Promise.resolve({ token: '1|tok', username: 'admin' }))),
        logout: vi.fn(opts.logout ?? (() => Promise.resolve())),
    };
    const getConfig = vi.fn(opts.getConfig ?? (() => Promise.resolve(CONFIG)));
    const config = createConfigService({ getConfig });
    const logger = recordingLogger();
    const auth = createAuthService({
        client,
        vault,
        store,
        config,
        hostname: () => 'MY-PC',
        siteUrl: opts.builtIn === undefined ? 'https://s.example.com' : opts.builtIn,
        allowInsecureLocalhost: false,
        logger,
    });
    const states: AuthState[] = [];
    auth.subscribe((s) => states.push(s));

    return { auth, client, vault, store, config, getConfig, states, logger, dir };
}

describe('deviceNameOf', () => {
    it('truncates to 100 chars and falls back when empty', () => {
        expect(deviceNameOf('a'.repeat(150))).toHaveLength(100);
        expect(deviceNameOf('  ')).toBe('Desktop app');
        expect(deviceNameOf('PC')).toBe('PC');
    });
});

describe('login', () => {
    it('signs in, saves the token and the site URL, then loads the config', async () => {
        const t = setup({ builtIn: 'https://site.example.com' });
        const state = await t.auth.login(' admin ', 'pw');

        expect(state).toEqual({
            status: 'signed_in',
            username: 'admin',
            siteUrl: 'https://site.example.com',
            r2Configured: true,
            persisted: true,
        });
        expect(t.client.login).toHaveBeenCalledWith('admin', 'pw', 'MY-PC');
        expect(t.vault.get()).toBe('1|tok');
        expect(t.store.get().settings.siteUrl).toBe('https://site.example.com');
        expect(t.store.get().settings.username).toBe('admin');
        expect(t.config.getConfig()).toEqual(CONFIG);
        expect(t.states.map((s) => s.status)).toEqual(['signing_in', 'signed_in']);
        expect(JSON.stringify(state)).not.toContain('1|tok');
    });

    it('reports r2Configured=false when the site has no R2 settings', async () => {
        const t = setup({
            getConfig: () =>
                Promise.reject(
                    new SiteApiError({ message: 'x', status: 409, code: 'r2_not_configured' }),
                ),
        });
        const state = await t.auth.login('a', 'b');

        expect(state.status).toBe('signed_in');
        expect(state.r2Configured).toBe(false);
    });

    it('maps failures to safe messages and restores the previously stored URL', async () => {
        const cases: [unknown, string][] = [
            [new SiteApiError({ message: 'x', status: 422 }), 'Incorrect username or password.'],
            [
                new SiteApiError({ message: 'x', status: 429, retryAfterSeconds: 30 }),
                'Too many sign-in attempts. Try again in 30 seconds.',
            ],
            [
                new SiteApiError({ message: 'Could not reach the site.', network: true }),
                'Could not reach the site.',
            ],
        ];

        for (const [error, message] of cases) {
            const t = setup({
                login: () => Promise.reject(error),
                siteUrl: 'https://old.example.com',
            });
            const state = await t.auth.login('a', 'b');

            expect(state).toMatchObject({ status: 'signed_out', error: message });
            expect(t.vault.get()).toBeNull();
            expect(t.store.get().settings.siteUrl).toBe('https://old.example.com');
        }
    });

    it('rejects empty credentials without calling the site', async () => {
        const t = setup();

        expect(await t.auth.login('', '')).toMatchObject({
            error: 'Enter your username and password.',
        });
        expect(t.client.login).not.toHaveBeenCalled();
    });

    it('ends signed out when the config call is rejected with 401', async () => {
        const t = setup({
            getConfig: () => Promise.reject(new SiteApiError({ message: 'x', status: 401 })),
        });
        const state = await t.auth.login('a', 'b');

        expect(state.status).toBe('signed_out');
        expect(t.vault.get()).toBeNull();
        expect(t.config.getConfig()).toBeNull();
    });

    it('reports offline (keeping the token) when the config cannot be fetched', async () => {
        const t = setup({
            getConfig: () => Promise.reject(new SiteApiError({ message: 'down', network: true })),
        });
        const state = await t.auth.login('a', 'b');

        expect(state.status).toBe('offline');
        expect(t.vault.get()).toBe('1|tok');
    });

    it('signs out of the previous session before logging in again', async () => {
        const t = setup();
        await t.auth.login('a', 'b');
        await t.auth.login('a', 'b');

        expect(t.client.logout).toHaveBeenCalledTimes(1);
    });
});

describe('built-in site URL', () => {
    it('login always uses the built-in site, whatever the stored URL says', async () => {
        const t = setup({ siteUrl: 'https://old.example.com' });
        const state = await t.auth.login('a', 'b');

        expect(state).toMatchObject({ status: 'signed_in', siteUrl: 'https://s.example.com' });
        expect(t.store.get().settings.siteUrl).toBe('https://s.example.com');
        expect(t.auth.getSiteUrl()).toBe('https://s.example.com');
    });

    it('login ignores any extra argument a caller might pass (the URL is not a parameter)', async () => {
        const t = setup();
        const login = t.auth.login as (...args: unknown[]) => Promise<AuthState>;
        const state = await login('https://evil.example.com', 'a', 'b');

        // 'https://evil.example.com' is taken as the username and 'a' as the password.
        expect(t.client.login).toHaveBeenCalledWith('https://evil.example.com', 'a', 'MY-PC');
        expect(state.siteUrl).toBe('https://s.example.com');
    });

    it('returns a clear error instead of crashing when the build has no site URL', async () => {
        const t = setup({ builtIn: null });

        expect(await t.auth.login('a', 'b')).toEqual({
            status: 'signed_out',
            error: 'Site URL is not configured in this build.',
        });
        expect(t.client.login).not.toHaveBeenCalled();
        expect(t.auth.getSiteUrl()).toBe('');
    });
});

describe('logout', () => {
    it('clears token, config and username even when the request fails', async () => {
        const t = setup({ logout: () => Promise.reject(new Error('offline')) });
        await t.auth.login('a', 'b');
        const signedOut = vi.fn();
        t.auth.onSignedOut(signedOut);

        const state = await t.auth.logout();

        expect(state).toEqual({ status: 'signed_out', siteUrl: 'https://s.example.com' });
        expect(t.vault.get()).toBeNull();
        expect(t.config.getConfig()).toBeNull();
        expect(t.store.get().settings.username).toBeUndefined();
        expect(signedOut).toHaveBeenCalledTimes(1);
    });
});

describe('restore', () => {
    async function withSavedToken(opts: Parameters<typeof setup>[0] = {}) {
        const t = setup({ siteUrl: 'https://s.example.com', ...opts });
        await t.vault.save('1|saved');
        // Simulate a fresh start: the token is only on disk.
        const fresh = new TokenVault({ dir: t.dir, backend: fakeBackend() });
        return { ...t, fresh };
    }

    it('is signed out without a token', async () => {
        const t = setup({ siteUrl: 'https://s.example.com' });
        expect((await t.auth.restore()).status).toBe('signed_out');
    });

    it('validates the saved token by fetching the config', async () => {
        const t = setup({ siteUrl: 'https://s.example.com' });
        await t.vault.save('1|saved');
        t.store.update((d) => {
            d.settings.username = 'admin';
        });

        const state = await t.auth.restore();

        expect(state).toEqual({
            status: 'signed_in',
            username: 'admin',
            siteUrl: 'https://s.example.com',
            r2Configured: true,
            persisted: true,
        });
        expect(t.getConfig).toHaveBeenCalledTimes(1);
    });

    it('clears the token on 401 and reports signed out', async () => {
        const t = await withSavedToken({
            getConfig: () => Promise.reject(new SiteApiError({ message: 'x', status: 401 })),
        });
        const state = await t.auth.restore();

        expect(state.status).toBe('signed_out');
        expect(t.vault.get()).toBeNull();
    });

    it('keeps the token and reports offline on a network failure', async () => {
        const t = await withSavedToken({
            getConfig: () => Promise.reject(new SiteApiError({ message: 'down', network: true })),
        });
        const state = await t.auth.restore();

        expect(state).toMatchObject({ status: 'offline' });
        expect(t.vault.get()).toBe('1|saved');
    });

    it('recovers from offline with reloadConfig()', async () => {
        let fail = true;
        const t = setup({
            siteUrl: 'https://s.example.com',
            getConfig: () =>
                fail
                    ? Promise.reject(new SiteApiError({ message: 'down', network: true }))
                    : Promise.resolve(CONFIG),
        });
        await t.vault.save('1|saved');

        expect((await t.auth.restore()).status).toBe('offline');
        fail = false;
        expect((await t.auth.reloadConfig()).status).toBe('signed_in');
    });

    it('discards a token when no site URL is stored', async () => {
        const t = setup();
        await t.vault.save('1|saved');

        expect((await t.auth.restore()).status).toBe('signed_out');
        expect(t.vault.get()).toBeNull();
        expect(t.getConfig).not.toHaveBeenCalled();
    });

    it('accepts a stored URL that only differs in form from the built-in one', async () => {
        const t = setup({ siteUrl: 'https://S.example.com/admin/' });
        await t.vault.save('1|saved');

        expect((await t.auth.restore()).status).toBe('signed_in');
        expect(t.vault.get()).toBe('1|saved');
    });

    it('treats a token saved for a different site as signed out and drops it', async () => {
        const t = setup({ siteUrl: 'https://old.example.com' });
        await t.vault.save('1|saved');
        t.store.update((d) => {
            d.settings.username = 'admin';
        });

        const state = await t.auth.restore();

        expect(state).toEqual({
            status: 'signed_out',
            siteUrl: 'https://s.example.com',
            error: 'This app now connects to a fixed site. Sign in again.',
        });
        expect(t.vault.get()).toBeNull();
        expect(existsSync(join(t.dir, 'token.bin'))).toBe(false);
        expect(t.config.getConfig()).toBeNull();
        expect(t.store.get().settings.username).toBeUndefined();
        expect(t.store.get().settings.siteUrl).toBe('https://s.example.com');
        // The token is never sent anywhere: no config fetch, no sign-out request to either host.
        expect(t.getConfig).not.toHaveBeenCalled();
        expect(t.client.logout).not.toHaveBeenCalled();
    });

    it('treats an unparseable stored URL as a different site', async () => {
        const t = setup({ siteUrl: 'garbage' });
        await t.vault.save('1|saved');

        expect((await t.auth.restore()).status).toBe('signed_out');
        expect(t.vault.get()).toBeNull();
    });

    it('adopts the built-in URL silently when there was no session (fresh install)', async () => {
        const t = setup({ siteUrl: 'https://old.example.com' });

        expect(await t.auth.restore()).toEqual({
            status: 'signed_out',
            siteUrl: 'https://s.example.com',
        });
        expect(t.store.get().settings.siteUrl).toBe('https://s.example.com');
    });

    it('drops a saved token when the build has no site URL', async () => {
        const t = setup({ siteUrl: 'https://s.example.com', builtIn: null });
        await t.vault.save('1|saved');

        expect(await t.auth.restore()).toEqual({
            status: 'signed_out',
            error: 'Site URL is not configured in this build.',
        });
        expect(t.vault.get()).toBeNull();
        expect(t.getConfig).not.toHaveBeenCalled();
    });
});

describe('handleUnauthorized', () => {
    it('clears token + config, emits signed out and notifies listeners', async () => {
        const t = setup();
        await t.auth.login('a', 'b');
        const signedOut = vi.fn();
        t.auth.onSignedOut(signedOut);

        t.auth.handleUnauthorized();

        expect(t.auth.getState()).toMatchObject({
            status: 'signed_out',
            error: 'Your session has expired. Sign in again.',
        });
        expect(t.vault.get()).toBeNull();
        expect(t.config.getConfig()).toBeNull();
        expect(signedOut).toHaveBeenCalledTimes(1);

        t.auth.handleUnauthorized();
        expect(signedOut).toHaveBeenCalledTimes(1);
    });
});

describe('secrets', () => {
    it('never logs the token or the password', async () => {
        const t = setup({
            login: () => Promise.resolve({ token: '1|supersecrettoken', username: 'admin' }),
        });
        await t.auth.login('admin', 'hunter2-password');

        const text = JSON.stringify(t.logger.entries);
        expect(text).not.toContain('supersecrettoken');
        expect(text).not.toContain('hunter2-password');
    });
});

describe('stay signed in', () => {
    it('true (default): token file is written and the state says persisted', async () => {
        const t = setup();
        const state = await t.auth.login('a', 'b');

        expect(state.persisted).toBe(true);
        expect(existsSync(join(t.dir, 'token.bin'))).toBe(true);
    });

    it('false: token stays in memory only, no file, state says not persisted', async () => {
        const t = setup();
        const state = await t.auth.login('a', 'b', false);

        expect(state.status).toBe('signed_in');
        expect(state.persisted).toBe(false);
        expect(t.vault.get()).toBe('1|tok');
        expect(existsSync(join(t.dir, 'token.bin'))).toBe(false);
    });

    it('false removes a previously persisted token file', async () => {
        const t = setup();
        await t.auth.login('a', 'b', true);
        expect(existsSync(join(t.dir, 'token.bin'))).toBe(true);

        await t.auth.login('a', 'b', false);

        expect(existsSync(join(t.dir, 'token.bin'))).toBe(false);
        expect(t.vault.get()).toBe('1|tok');
    });

    it('restore() finds no token after a memory-only session', async () => {
        const t = setup();
        await t.auth.login('a', 'b', false);

        const fresh = new TokenVault({ dir: t.dir, backend: fakeBackend() });
        expect(await fresh.load()).toBeNull();
    });

    it('restore() of a saved token reports persisted', async () => {
        const t = setup({ siteUrl: 'https://s.example.com' });
        await t.vault.save('1|saved');

        expect((await t.auth.restore()).persisted).toBe(true);
    });

    it('logout clears memory and disk in both modes', async () => {
        for (const stay of [true, false]) {
            const t = setup();
            await t.auth.login('a', 'b', stay);
            await t.auth.logout();

            expect(t.vault.get()).toBeNull();
            expect(existsSync(join(t.dir, 'token.bin'))).toBe(false);
        }
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('session races (in-flight config load)', () => {
    async function pendingRestore() {
        const pending = deferred<AppConfig>();
        const t = setup({ siteUrl: 'https://s.example.com', getConfig: () => pending.promise });

        await t.vault.save('1|saved');

        const restoring = t.auth.restore();

        await tick();

        expect(t.auth.getState().status).toBe('signing_in');
        expect(t.getConfig).toHaveBeenCalledTimes(1);

        return { t, pending, restoring };
    }

    it('sign-out while the config is loading leaves the app signed out with no config', async () => {
        const { t, pending, restoring } = await pendingRestore();

        await t.auth.logout();
        pending.resolve(CONFIG);
        await restoring;
        await tick();

        expect(t.auth.getState().status).toBe('signed_out');
        expect(t.config.getConfig()).toBeNull();
        expect(t.config.getPublic()).toBeNull();
        expect(t.vault.get()).toBeNull();
        expect(t.states.some((s) => s.status === 'signed_in')).toBe(false);
    });

    it('sign-out while a slow sign-out request is still pending also wins', async () => {
        const logoutPending = deferred<void>();
        const pending = deferred<AppConfig>();
        const t = setup({
            siteUrl: 'https://s.example.com',
            getConfig: () => pending.promise,
            logout: () => logoutPending.promise,
        });

        await t.vault.save('1|saved');

        const restoring = t.auth.restore();

        await tick();

        const loggingOut = t.auth.logout();

        await tick();
        pending.resolve(CONFIG);
        await restoring;

        expect(t.config.getConfig()).toBeNull();
        expect(t.states.some((s) => s.status === 'signed_in')).toBe(false);

        logoutPending.resolve();
        await loggingOut;

        expect(t.auth.getState().status).toBe('signed_out');
    });

    it('a 401 (handleUnauthorized) while the config is loading stays signed out', async () => {
        const { t, pending, restoring } = await pendingRestore();

        t.auth.handleUnauthorized();
        pending.resolve(CONFIG);
        await restoring;
        await tick();

        expect(t.auth.getState()).toMatchObject({
            status: 'signed_out',
            error: 'Your session has expired. Sign in again.',
        });
        expect(t.config.getConfig()).toBeNull();
        expect(t.states.some((s) => s.status === 'signed_in')).toBe(false);
    });

    it('a failed (offline) load that finishes after sign-out does not change the state', async () => {
        const { t, pending, restoring } = await pendingRestore();

        await t.auth.logout();
        pending.reject(new SiteApiError({ message: 'x', network: true }));
        await restoring;

        expect(t.auth.getState().status).toBe('signed_out');
        expect(t.states.some((s) => s.status === 'offline')).toBe(false);
    });

    it('a normal load with no interference still ends signed in', async () => {
        const { t, pending, restoring } = await pendingRestore();

        pending.resolve(CONFIG);

        expect((await restoring).status).toBe('signed_in');
        expect(t.config.getConfig()).toEqual(CONFIG);
    });

    it('sign-out during login() revokes the freshly issued token and stays signed out', async () => {
        const loginPending = deferred<{ token: string; username: string }>();
        const t = setup({ login: () => loginPending.promise });
        const logging = t.auth.login('a', 'b');

        await tick();
        await t.auth.logout();
        loginPending.resolve({ token: '1|late', username: 'admin' });

        const result = await logging;

        expect(result.status).toBe('signed_out');
        expect(t.vault.get()).toBeNull();
        expect(t.client.logout).toHaveBeenCalled();
        expect(t.getConfig).not.toHaveBeenCalled();
    });
});

describe('concurrent login', () => {
    it('ignores a second simultaneous login() and issues only one token', async () => {
        const loginPending = deferred<{ token: string; username: string }>();
        const t = setup({ login: () => loginPending.promise });

        const first = t.auth.login('a', 'b');
        const second = t.auth.login('a', 'b');

        loginPending.resolve({ token: '1|only', username: 'admin' });

        const [a, b] = await Promise.all([first, second]);

        expect(t.client.login).toHaveBeenCalledTimes(1);
        expect(a.status).toBe('signed_in');
        expect(b.status).not.toBe('signed_in');
        expect(t.vault.get()).toBe('1|only');
    });

    it('also ignores a second login while the previous token is being revoked', async () => {
        const logoutPending = deferred<void>();
        const t = setup({ logout: () => logoutPending.promise });

        await t.vault.save('1|old');

        const first = t.auth.login('a', 'b');
        const second = t.auth.login('a', 'b');

        await tick();
        logoutPending.resolve();
        await Promise.all([first, second]);

        expect(t.client.login).toHaveBeenCalledTimes(1);
    });

    it('allows a new login after the previous one finished', async () => {
        const t = setup();

        await t.auth.login('a', 'b');
        await t.auth.login('a', 'b');

        expect(t.client.login).toHaveBeenCalledTimes(2);
    });

    it('revokes a token that appears (restore race) before it is overwritten', async () => {
        const loginPending = deferred<{ token: string; username: string }>();
        const t = setup({ login: () => loginPending.promise });
        const logging = t.auth.login('a', 'b');

        await tick();
        await t.vault.save('1|restored');
        loginPending.resolve({ token: '1|new', username: 'admin' });
        await logging;

        expect(t.client.logout).toHaveBeenCalledTimes(1);
        expect(t.vault.get()).toBe('1|new');
    });
});
