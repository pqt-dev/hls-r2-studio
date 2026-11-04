/** Site URL rules (spec 4.5): https only, normalized to an origin, no credentials. */

export class SiteUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SiteUrlError';
    }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Returns the origin (`https://host[:port]`) of the site URL. Any path, query and fragment are
 * dropped, credentials are rejected. `http` is accepted ONLY for localhost/127.0.0.1 and only
 * when `allowInsecureLocalhost` is true (development builds).
 */
export function normalizeSiteUrl(raw: string, allowInsecureLocalhost: boolean): string {
    const text = raw.trim();

    if (text === '') throw new SiteUrlError('Enter the site URL.');

    let url: URL;

    try {
        url = new URL(text);
    } catch {
        throw new SiteUrlError('The site URL is not valid.');
    }

    if (url.username !== '' || url.password !== '') {
        throw new SiteUrlError('The site URL must not contain a user name or password.');
    }

    if (url.protocol === 'https:') return url.origin;

    if (url.protocol === 'http:' && allowInsecureLocalhost && LOCAL_HOSTS.has(url.hostname)) {
        return url.origin;
    }

    throw new SiteUrlError('The site URL must start with https://.');
}

/** Shown when this build has no (valid) built-in site URL, e.g. `electron-vite dev` without env. */
export const SITE_URL_NOT_CONFIGURED = 'Site URL is not configured in this build.';

/**
 * Build-time constant injected by `electron-vite build` (see electron.vite.config.ts). It does
 * not exist at all in vitest or `electron-vite dev`, so it is only ever read through `typeof`.
 */
declare const __HLS_SITE_URL__: string | undefined;

/** Normalizes a raw built-in site URL; null when it is missing or not valid. */
export function normalizeBuiltInSiteUrl(
    raw: string | undefined,
    allowInsecureLocalhost: boolean,
): string | null {
    if (raw === undefined || raw.trim() === '') return null;

    try {
        return normalizeSiteUrl(raw, allowInsecureLocalhost);
    } catch {
        return null;
    }
}

/**
 * The ONE place that says which site this app talks to. The value is fixed when the app is built
 * (`HLS_SITE_URL`); without the build-time define (dev, tests) the runtime env var is used.
 * Returns null when nothing valid is configured. The renderer can never influence this.
 */
export function getBuiltInSiteUrl(
    allowInsecureLocalhost: boolean,
    env: Record<string, string | undefined> = process.env,
): string | null {
    const raw = typeof __HLS_SITE_URL__ === 'string' ? __HLS_SITE_URL__ : env['HLS_SITE_URL'];

    return normalizeBuiltInSiteUrl(raw, allowInsecureLocalhost);
}
