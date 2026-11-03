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
