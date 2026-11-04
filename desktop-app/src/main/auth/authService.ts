/** Sign-in state machine (spec 4.3 / 4.5): login, logout, restore at startup, 401 handling. */
import type { AuthState } from '../../shared/ipc';
import type { AppStore } from '../store';
import { SiteApiError } from '../api/siteClient';
import { normalizeSiteUrl, SITE_URL_NOT_CONFIGURED, SiteUrlError } from '../api/siteUrl';
import { StaleConfigError, type ConfigService } from '../config/configService';
import type { Logger } from '../logger';

export const MAX_DEVICE_NAME_LENGTH = 100;

export interface AuthClient {
    login(
        username: string,
        password: string,
        deviceName: string,
    ): Promise<{ token: string; username: string }>;
    logout(): Promise<void>;
}

export interface TokenStore {
    get(): string | null;
    load(): Promise<string | null>;
    save(token: string): Promise<'persisted' | 'memory-only'>;
    saveMemoryOnly(token: string): Promise<void>;
    clear(): Promise<void>;
}

export interface AuthServiceOptions {
    client: AuthClient;
    vault: TokenStore;
    store: AppStore;
    config: ConfigService;
    hostname: () => string;
    /**
     * The one site this build talks to (normalized origin, see `getBuiltInSiteUrl`), or null when
     * the build has none. The renderer can never choose it.
     */
    siteUrl: string | null;
    /** True in development builds (allows http://localhost). */
    allowInsecureLocalhost: boolean;
    logger: Logger;
}

export type AuthListener = (state: AuthState) => void;

export interface AuthService {
    getState(): AuthState;
    subscribe(listener: AuthListener): () => void;
    /** Fires after the session was cleared (explicit sign-out or any 401). */
    onSignedOut(listener: () => void): () => void;
    /** `staySignedIn` (default true) = keep the token on disk; false = this session only. */
    login(username: string, password: string, staySignedIn?: boolean): Promise<AuthState>;
    logout(): Promise<AuthState>;
    /** Startup: load the saved token and validate it by fetching the config. */
    restore(): Promise<AuthState>;
    /** Re-fetches the site config (settings "Reload config", or recovery from `offline`). */
    reloadConfig(): Promise<AuthState>;
    /** Clears token + config and signs out. Wired to every 401 of the site client. */
    handleUnauthorized(): void;
    /** The built-in site origin, or '' when this build has none. */
    getSiteUrl(): string;
}

export function deviceNameOf(hostname: string): string {
    const name = hostname.trim().slice(0, MAX_DEVICE_NAME_LENGTH).trim();

    return name === '' ? 'Desktop app' : name;
}

export function loginErrorMessage(error: unknown): string {
    if (error instanceof SiteUrlError) return error.message;

    if (error instanceof SiteApiError) {
        if (error.code === 'invalid_site_url') return error.message;
        if (error.network) return error.message;
        if (error.status === 422) return 'Incorrect username or password.';

        if (error.status === 429) {
            const wait = error.retryAfterSeconds;

            return wait === null
                ? 'Too many sign-in attempts. Try again in a minute.'
                : `Too many sign-in attempts. Try again in ${wait} seconds.`;
        }

        if (error.status !== null && error.status >= 500) {
            return 'The site had a temporary problem. Please try again.';
        }

        return error.message;
    }

    return 'Sign-in failed.';
}

export function createAuthService(options: AuthServiceOptions): AuthService {
    const { client, vault, store, config, logger } = options;
    const listeners = new Set<AuthListener>();
    const signedOutListeners = new Set<() => void>();
    let state: AuthState = { status: 'signed_out' };
    /** True when the current token is stored on disk (survives a restart). */
    let persisted = false;
    /**
     * Session epoch: incremented synchronously by every logout, session clear, site URL change
     * and 401. Async work (config load, login) captures it at the start and drops its result when
     * the epoch moved, so a late answer can never resurrect a signed-out session.
     */
    let epoch = 0;
    /** Set synchronously at the start of login(); a second concurrent login is ignored. */
    let loginInFlight = false;

    /** Ends the current session in memory right now (before any await). */
    function invalidateSession(): void {
        epoch++;
        config.clear();
    }

    const settings = () => store.get().settings;
    const builtInSiteUrl = options.siteUrl;

    function siteUrlOrUndefined(): string | undefined {
        return builtInSiteUrl ?? undefined;
    }

    /** True when the site stored by an older session is the built-in site (normalized compare). */
    function storedSiteIsBuiltIn(): boolean {
        const stored = settings().siteUrl;

        if (builtInSiteUrl === null || stored === '') return false;

        try {
            return normalizeSiteUrl(stored, options.allowInsecureLocalhost) === builtInSiteUrl;
        } catch {
            return false;
        }
    }

    function setState(next: AuthState): AuthState {
        state = next;

        for (const listener of [...listeners]) {
            try {
                listener(state);
            } catch (error) {
                logger.error('Auth listener failed', { error });
            }
        }

        return state;
    }

    function signedOut(error?: string): AuthState {
        const next: AuthState = { status: 'signed_out' };
        const siteUrl = siteUrlOrUndefined();

        if (siteUrl !== undefined) next.siteUrl = siteUrl;
        if (error !== undefined) next.error = error;

        return setState(next);
    }

    function notifySignedOut(): void {
        for (const listener of [...signedOutListeners]) {
            try {
                listener();
            } catch (error) {
                logger.error('Signed-out listener failed', { error });
            }
        }
    }

    async function clearSession(): Promise<void> {
        invalidateSession();
        persisted = false;

        try {
            await vault.clear();
        } catch (error) {
            logger.error('Could not delete the saved token', { error });
        }
    }

    function setUsername(username: string | undefined): void {
        store.update((draft) => {
            if (username === undefined) delete draft.settings.username;
            else draft.settings.username = username;
        });
    }

    /** After a token exists: fetch the config and derive signed_in / offline / signed_out. */
    async function validate(username: string | undefined): Promise<AuthState> {
        const siteUrl = siteUrlOrUndefined();
        const startEpoch = epoch;
        const startToken = vault.get();
        const base: AuthState = { status: 'signed_in', persisted };

        if (username !== undefined) base.username = username;
        if (siteUrl !== undefined) base.siteUrl = siteUrl;

        /** The session changed (sign-out, 401, site change, another token) while we waited. */
        const superseded = (): boolean => epoch !== startEpoch || vault.get() !== startToken;

        try {
            const view = await config.refresh();

            if (superseded()) return state;

            return setState({ ...base, r2Configured: view.r2Configured });
        } catch (error) {
            if (error instanceof StaleConfigError || superseded()) return state;

            if (error instanceof SiteApiError && error.status === 401) {
                // The client already called handleUnauthorized(); make sure we end signed out.
                if (state.status === 'signed_out') return state;

                await clearSession();

                return signedOut('Your session has expired. Sign in again.');
            }

            logger.warn('Could not load the site config', { error });
            const message =
                error instanceof SiteApiError && !error.network
                    ? 'The site could not provide its configuration right now.'
                    : 'Could not reach the site. Check your internet connection.';

            return setState({ ...base, status: 'offline', error: message });
        }
    }

    const service: AuthService = {
        getState: () => state,

        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },

        onSignedOut(listener) {
            signedOutListeners.add(listener);

            return () => signedOutListeners.delete(listener);
        },

        getSiteUrl: () => builtInSiteUrl ?? '',

        async login(username, password, staySignedIn = true) {
            // Guard FIRST and synchronously: two simultaneous calls must not issue two tokens.
            if (loginInFlight || state.status === 'signing_in') return state;

            loginInFlight = true;

            try {
                return await performLogin(username, password, staySignedIn);
            } finally {
                loginInFlight = false;
            }
        },

        async logout() {
            // Drop the session in memory immediately so an in-flight config load cannot revive it.
            invalidateSession();

            if (vault.get() !== null) {
                try {
                    await client.logout();
                } catch (error) {
                    logger.warn('Sign-out request failed; clearing the local token anyway', {
                        error,
                    });
                }
            }

            await clearSession();
            setUsername(undefined);
            const next = signedOut();
            notifySignedOut();

            return next;
        },

        async restore() {
            const token = await vault.load();
            const siteUrl = siteUrlOrUndefined();

            if (siteUrl === undefined) {
                // Nowhere to send a token to: never keep one around.
                if (token !== null) await clearSession();

                return signedOut(SITE_URL_NOT_CONFIGURED);
            }

            if (!storedSiteIsBuiltIn()) {
                // Saved by a version that let the user pick the site (or for another site): the
                // token must never be sent to the built-in host, so sign in again.
                const hadSession = token !== null;

                if (hadSession) await clearSession();

                if (hadSession || settings().username !== undefined) setUsername(undefined);

                store.update((draft) => {
                    draft.settings.siteUrl = siteUrl;
                });

                return signedOut(
                    hadSession
                        ? 'This app now connects to a fixed site. Sign in again.'
                        : undefined,
                );
            }

            if (token === null) return signedOut();

            // A token found on disk was saved with "stay signed in".
            persisted = true;
            setState({ status: 'signing_in', siteUrl, ...usernameField() });

            return validate(settings().username);
        },

        async reloadConfig() {
            if (vault.get() === null) return signedOut();

            return validate(settings().username);
        },

        handleUnauthorized() {
            if (vault.get() === null && state.status === 'signed_out') return;

            invalidateSession();
            void vault.clear().catch((error: unknown) => {
                logger.error('Could not delete the saved token', { error });
            });
            logger.warn('The site rejected the token; signed out.');
            signedOut('Your session has expired. Sign in again.');
            notifySignedOut();
        },
    };

    async function performLogin(
        username: string,
        password: string,
        staySignedIn: boolean,
    ): Promise<AuthState> {
        if (builtInSiteUrl === null) {
            return setState({ ...signedOutBase(), error: SITE_URL_NOT_CONFIGURED });
        }

        const origin = builtInSiteUrl;

        if (username.trim() === '' || password === '') {
            return setState({ ...signedOutBase(), error: 'Enter your username and password.' });
        }

        // Do not leave a token of the previous session on the server.
        if (vault.get() !== null) {
            await client.logout().catch(() => undefined);
            await clearSession();
        }

        const previousUrl = settings().siteUrl;

        setState({ status: 'signing_in', siteUrl: origin });
        store.update((draft) => {
            draft.settings.siteUrl = origin;
        });

        const loginEpoch = epoch;

        try {
            const result = await client.login(
                username.trim(),
                password,
                deviceNameOf(options.hostname()),
            );

            if (epoch !== loginEpoch) {
                // Signed out / site changed while the request was pending: the new token is unwanted.
                await revokeToken(result.token);

                return state;
            }

            // Another token appeared meanwhile (e.g. a restore): revoke it before overwriting it.
            if (vault.get() !== null) {
                await client.logout().catch(() => undefined);
            }

            if (staySignedIn) {
                persisted = (await vault.save(result.token)) === 'persisted';
            } else {
                await vault.saveMemoryOnly(result.token);
                persisted = false;
            }

            logger.info('Signed in', { siteUrl: origin, persisted });
            setUsername(result.username);

            return await validate(result.username);
        } catch (error) {
            logger.warn('Sign-in failed', { error });

            if (epoch !== loginEpoch) return state;

            store.update((draft) => {
                draft.settings.siteUrl = previousUrl;
            });

            return setState({ ...signedOutBase(), error: loginErrorMessage(error) });
        }
    }

    /** Best-effort revocation of a token that was issued but must not be used. */
    async function revokeToken(token: string): Promise<void> {
        try {
            await vault.saveMemoryOnly(token);
            await client.logout();
        } catch (error) {
            logger.warn('Could not revoke an unwanted token', { error });
        } finally {
            await vault.clear().catch(() => undefined);
        }
    }

    function signedOutBase(): AuthState {
        const siteUrl = siteUrlOrUndefined();

        return siteUrl === undefined ? { status: 'signed_out' } : { status: 'signed_out', siteUrl };
    }

    function usernameField(): { username?: string } {
        const name = settings().username;

        return name === undefined ? {} : { username: name };
    }

    return service;
}
