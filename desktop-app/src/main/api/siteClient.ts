/** HTTP client for the site API (spec 3.5). Only the main process uses it. */
import type { AppConfig } from '../../shared/appConfig';
import type { Logger } from '../logger';
import type { RegisteredVideo, RegisterClient } from '../pipeline/deps';
import type { RegisterPayload, RegisterFailure } from '../pipeline/register';
import { RegisterRequestError } from '../pipeline/registerClient';
import { normalizeSiteUrl, SiteUrlError } from './siteUrl';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30000;
/** Responses larger than this are treated as invalid (the API only returns tiny JSON). */
const MAX_BODY_BYTES = 1024 * 1024;

/** Failure of a site API call. Messages are safe English text (never contain tokens). */
export class SiteApiError extends Error {
    /** HTTP status, or null when no response was received. */
    readonly status: number | null;
    /** `error` field of the JSON body (e.g. `r2_not_configured`), or a client-side code. */
    readonly code: string | null;
    readonly retryAfterSeconds: number | null;
    /** True when there was no usable HTTP answer (offline, DNS, timeout, redirect, TLS...). */
    readonly network: boolean;

    constructor(init: {
        message: string;
        status?: number | null;
        code?: string | null;
        retryAfterSeconds?: number | null;
        network?: boolean;
        cause?: unknown;
    }) {
        super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
        this.name = 'SiteApiError';
        this.status = init.status ?? null;
        this.code = init.code ?? null;
        this.retryAfterSeconds = init.retryAfterSeconds ?? null;
        this.network = init.network ?? false;
    }
}

export interface SiteClientOptions {
    fetch: FetchFn;
    /** Current site URL from settings (validated again on every request). */
    getBaseUrl: () => string;
    getToken: () => string | null;
    userAgent: string;
    timeoutMs?: number;
    /** True in development builds: allows http://localhost and http://127.0.0.1. */
    allowInsecureLocalhost?: boolean;
    /** Called once for ANY 401 on an authenticated call whose token is still the current one. */
    onUnauthorized?: () => void;
    logger?: Logger;
}

export interface LoginResult {
    token: string;
    username: string;
}

export interface SiteClient extends RegisterClient {
    login(username: string, password: string, deviceName: string): Promise<LoginResult>;
    logout(): Promise<void>;
    getConfig(): Promise<AppConfig>;
}

interface RawResponse {
    status: number;
    body: unknown;
    retryAfterSeconds: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}

function parseRetryAfter(header: string | null): number | null {
    if (header === null || !/^\d{1,6}$/.test(header.trim())) return null;

    return Number(header.trim());
}

function errorCodeOf(body: unknown): string | null {
    return isRecord(body) && typeof body['error'] === 'string' ? body['error'] : null;
}

function parseJson(text: string): unknown {
    if (text.trim() === '') return null;

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

export function createSiteClient(options: SiteClientOptions): SiteClient {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowInsecure = options.allowInsecureLocalhost ?? false;

    /** One HTTP exchange. Throws SiteApiError for transport problems and redirects. */
    async function send(
        method: 'GET' | 'POST',
        path: string,
        opts: { auth: boolean; body?: unknown },
    ): Promise<RawResponse> {
        let origin: string;

        try {
            origin = normalizeSiteUrl(options.getBaseUrl(), allowInsecure);
        } catch (error) {
            const message = error instanceof SiteUrlError ? error.message : 'Invalid site URL.';
            throw new SiteApiError({ message, code: 'invalid_site_url' });
        }

        const token = options.getToken();

        if (opts.auth && token === null) {
            throw new SiteApiError({
                message: 'You are not signed in.',
                status: 401,
                code: 'not_signed_in',
            });
        }

        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': options.userAgent,
        };

        if (opts.auth && token !== null) headers['Authorization'] = `Bearer ${token}`;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            let response: Response;

            try {
                response = await options.fetch(`${origin}${path}`, {
                    method,
                    headers,
                    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                    // A redirect could carry the Bearer token to another host: never follow.
                    redirect: 'manual',
                    signal: controller.signal,
                });
            } catch (error) {
                options.logger?.warn('Site request failed.', { method, path, error });
                throw new SiteApiError({
                    message: controller.signal.aborted
                        ? 'The site did not respond in time.'
                        : 'Could not reach the site. Check your internet connection.',
                    network: true,
                    code: controller.signal.aborted ? 'timeout' : 'network',
                    cause: error,
                });
            }

            if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
                options.logger?.warn('Site answered with a redirect; refusing to follow.', {
                    method,
                    path,
                    status: response.status,
                });
                throw new SiteApiError({
                    message: 'The site sent an unexpected redirect. Check the site URL.',
                    status: response.status === 0 ? null : response.status,
                    code: 'unexpected_redirect',
                    network: true,
                });
            }

            let text: string;

            try {
                text = await readLimited(response, controller.signal);
            } catch (error) {
                throw new SiteApiError({
                    message: controller.signal.aborted
                        ? 'The site did not respond in time.'
                        : 'The response from the site could not be read.',
                    network: true,
                    code: controller.signal.aborted ? 'timeout' : 'network',
                    cause: error,
                });
            }

            options.logger?.debug('Site request done.', { method, path, status: response.status });

            const raw: RawResponse = {
                status: response.status,
                body: parseJson(text),
                retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
            };

            if (raw.status === 401 && opts.auth && token !== null && options.getToken() === token) {
                options.onUnauthorized?.();
            }

            return raw;
        } finally {
            clearTimeout(timer);
        }
    }

    function httpError(raw: RawResponse, fallback: string): SiteApiError {
        return new SiteApiError({
            message: fallback,
            status: raw.status,
            code: errorCodeOf(raw.body),
            retryAfterSeconds: raw.retryAfterSeconds,
        });
    }

    return {
        async login(username, password, deviceName) {
            const raw = await send('POST', '/api/app/login', {
                auth: false,
                body: { username, password, device_name: deviceName },
            });

            if (raw.status !== 200) {
                throw httpError(raw, `Sign-in failed (HTTP ${raw.status}).`);
            }

            const body = raw.body;
            const user = isRecord(body) ? body['user'] : null;

            if (
                !isRecord(body) ||
                !str(body['token']) ||
                !isRecord(user) ||
                !str(user['username'])
            ) {
                throw new SiteApiError({
                    message: 'The site sent an unexpected sign-in response.',
                    status: raw.status,
                    code: 'invalid_response',
                });
            }

            return { token: body['token'], username: user['username'] };
        },

        async logout() {
            const raw = await send('POST', '/api/app/logout', { auth: true });

            if (raw.status !== 204 && raw.status !== 200) {
                throw httpError(raw, `Sign-out failed (HTTP ${raw.status}).`);
            }
        },

        async getConfig() {
            const raw = await send('GET', '/api/app/config', { auth: true });

            if (raw.status !== 200) {
                throw httpError(raw, `Could not load the site configuration (HTTP ${raw.status}).`);
            }

            const config = parseAppConfig(raw.body);

            if (config === null) {
                throw new SiteApiError({
                    message: 'The site sent an invalid configuration.',
                    status: raw.status,
                    code: 'invalid_response',
                });
            }

            const problem = r2LocationProblem(config.r2, allowInsecure);

            if (problem !== null) {
                options.logger?.warn('Refusing the site config.', { problem });
                throw new SiteApiError({
                    message: problem,
                    status: raw.status,
                    code: 'invalid_r2_location',
                });
            }

            return config;
        },

        async register(payload: RegisterPayload): Promise<RegisteredVideo> {
            let raw: RawResponse;

            try {
                raw = await send('POST', '/api/app/videos', { auth: true, body: payload });
            } catch (error) {
                if (error instanceof SiteApiError) throw new RegisterRequestError(toFailure(error));

                throw new RegisterRequestError({ kind: 'network' });
            }

            if (raw.status === 200 || raw.status === 201) {
                const registered = parseRegistered(raw.body);

                if (registered === null) {
                    // A 2xx without a usable body: the API is idempotent, so retrying is safe.
                    throw new RegisterRequestError(
                        { kind: 'network' },
                        'invalid register response',
                    );
                }

                return registered;
            }

            throw new RegisterRequestError({
                kind: 'http',
                status: raw.status,
                errorCode: errorCodeOf(raw.body),
                retryAfterSeconds: raw.retryAfterSeconds,
            });
        },
    };
}

/** A site error that carries a status becomes an HTTP failure; everything else is "network". */
function toFailure(error: SiteApiError): RegisterFailure {
    if (error.status === 401 && error.code === 'not_signed_in') {
        return { kind: 'http', status: 401, errorCode: error.code };
    }

    return { kind: 'network' };
}

/**
 * Reads the body chunk by chunk and aborts as soon as more than MAX_BODY_BYTES arrived, so a huge
 * (or endless) response is never buffered in memory.
 */
export async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('aborted');

    const body = response.body;

    if (body === null) {
        const text = await response.text();

        if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
            throw new Error('response too large');
        }

        return text;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    try {
        for (;;) {
            if (signal.aborted) throw new Error('aborted');

            const { done, value } = await reader.read();

            if (done) break;

            received += value.byteLength;

            if (received > MAX_BODY_BYTES) {
                throw new Error('response too large');
            }

            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }

    const decoder = new TextDecoder();
    let text = '';

    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });

    return text + decoder.decode();
}

const LOCAL_R2_HOSTS = new Set(['localhost', '127.0.0.1']);

function locationProblem(
    raw: string,
    label: string,
    allowInsecureLocalhost: boolean,
): string | null {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return `The R2 ${label} sent by the site is not a valid URL.`;
    }

    if (url.username !== '' || url.password !== '') {
        return `The R2 ${label} sent by the site must not contain credentials.`;
    }

    if (url.protocol === 'https:') return null;

    if (url.protocol === 'http:' && allowInsecureLocalhost && LOCAL_R2_HOSTS.has(url.hostname)) {
        return null;
    }

    return `The R2 ${label} sent by the site must use https://.`;
}

/**
 * The R2 credentials are sent to `endpoint`, so it must be https (http only for localhost in
 * development builds, like the site URL). The public `url` must be https too. Null = fine.
 */
export function r2LocationProblem(
    r2: AppConfig['r2'],
    allowInsecureLocalhost: boolean,
): string | null {
    if (r2.bucket.trim() === '') return 'The site did not provide an R2 bucket name.';

    return (
        locationProblem(r2.endpoint, 'endpoint', allowInsecureLocalhost) ??
        locationProblem(r2.url, 'public URL', allowInsecureLocalhost)
    );
}

function parseRegistered(body: unknown): RegisteredVideo | null {
    if (!isRecord(body)) return null;

    const { id, public_id: publicId, embed_url: embedUrl } = body;

    if (typeof id !== 'number' || !Number.isInteger(id) || !str(publicId) || !str(embedUrl)) {
        return null;
    }

    return { id, public_id: publicId, embed_url: embedUrl };
}

/** Strictly validates `GET /api/app/config`; returns null when anything is missing or mistyped. */
export function parseAppConfig(body: unknown): AppConfig | null {
    if (!isRecord(body)) return null;

    const r2 = body['r2'];
    const transcode = body['transcode'];

    if (!isRecord(r2) || !isRecord(transcode)) return null;

    const { access_key_id: key, secret_access_key: secret, bucket, endpoint, url } = r2;

    if (!str(key) || !str(secret) || !str(bucket) || !str(endpoint) || !str(url)) return null;

    const resolution =
        typeof transcode['resolution'] === 'number'
            ? String(transcode['resolution'])
            : transcode['resolution'];
    const segment = transcode['segment_seconds'];
    const fps = transcode['fps'] ?? null;

    if (resolution !== '480' && resolution !== '720' && resolution !== '1080') return null;
    if (typeof segment !== 'number' || !Number.isFinite(segment) || segment < 1) return null;
    if (fps !== null && (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)) return null;

    return {
        r2: { access_key_id: key, secret_access_key: secret, bucket, endpoint, url },
        transcode: { resolution, segment_seconds: segment, fps },
    };
}
