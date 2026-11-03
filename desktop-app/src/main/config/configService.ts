/** Holds the latest site config IN MEMORY ONLY. The R2 secret never leaves this object. */
import type { AppConfig } from '../../shared/appConfig';
import type { PublicConfig } from '../../shared/ipc';
import { SiteApiError } from '../api/siteClient';

/**
 * Thrown by `refresh()` when the config was cleared (sign-out, 401, site change) while the
 * request was in flight. The fetched config is dropped and never stored.
 */
export class StaleConfigError extends Error {
    constructor() {
        super('The site config was discarded because the session changed.');
        this.name = 'StaleConfigError';
    }
}

export interface ConfigFetcher {
    getConfig(): Promise<AppConfig>;
}

export interface ConfigService {
    /** Full config including R2 credentials. For main-process consumers (queue) only. */
    getConfig(): AppConfig | null;
    /** Safe view for IPC: no credentials. */
    getPublic(): PublicConfig | null;
    /**
     * Fetches the config. A 409 `r2_not_configured` is a normal state (`r2Configured: false`);
     * any other failure is thrown as a SiteApiError and leaves the previous config untouched.
     * If `clear()` ran while the request was pending, the result is discarded and a
     * {@link StaleConfigError} is thrown.
     */
    refresh(): Promise<PublicConfig>;
    clear(): void;
}

export function createConfigService(fetcher: ConfigFetcher): ConfigService {
    let config: AppConfig | null = null;
    let known = false;
    /** Incremented by every clear(); a refresh that started before it must not store its result. */
    let generation = 0;

    function publicView(): PublicConfig | null {
        if (!known) return null;

        return {
            r2Configured: config !== null,
            transcode: config === null ? null : { ...config.transcode },
        };
    }

    return {
        getConfig: () => config,
        getPublic: publicView,
        async refresh() {
            const started = generation;

            try {
                const fetched = await fetcher.getConfig();

                if (started !== generation) throw new StaleConfigError();

                config = fetched;
                known = true;
            } catch (error) {
                if (error instanceof StaleConfigError) throw error;

                if (started !== generation) throw new StaleConfigError();

                if (
                    error instanceof SiteApiError &&
                    error.status === 409 &&
                    error.code === 'r2_not_configured'
                ) {
                    config = null;
                    known = true;
                } else {
                    throw error;
                }
            }

            return publicView() ?? { r2Configured: false, transcode: null };
        },
        clear() {
            generation++;
            config = null;
            known = false;
        },
    };
}
