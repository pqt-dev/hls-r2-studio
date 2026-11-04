/** Splits upload failures into "the network is the problem" (worth waiting for) and everything else. */

export type UploadErrorClass = 'network' | 'other';

const NETWORK_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ENETUNREACH',
    'ENETDOWN',
    'EHOSTUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_CLOSED',
]);

/** Transport / throttling error names (the SDK uses the S3 error code as the error name). */
const NETWORK_NAMES: ReadonlySet<string> = new Set([
    'TimeoutError',
    'NetworkingError',
    'RequestTimeout',
    'SlowDown',
    'ServiceUnavailable',
    'InternalError',
]);

const NETWORK_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const MAX_DEPTH = 6;

interface ErrorLike {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
    $metadata?: { httpStatusCode?: unknown };
}

/**
 * `network`: Node/undici/AWS SDK transport failures (reset, timeout, DNS, no route), including
 * ones wrapped in `err.cause` / `AggregateError.errors`, and the HTTP answers 408/429/500/502/
 * 503/504 or their S3 error names. `other`: anything else (403, NoSuchBucket, 400, local file
 * errors, ...). An `AbortError` only counts as a network failure when it is the SDK's own
 * timeout; pass the job's `signal` so our own cancellation is never mistaken for it.
 */
export function classifyUploadError(error: unknown, signal?: AbortSignal): UploadErrorClass {
    return inspect(error, signal, 0, new Set<unknown>()) ? 'network' : 'other';
}

function inspect(
    error: unknown,
    signal: AbortSignal | undefined,
    depth: number,
    seen: Set<unknown>,
): boolean {
    if (typeof error !== 'object' || error === null || depth > MAX_DEPTH || seen.has(error)) {
        return false;
    }

    seen.add(error);

    const e = error as ErrorLike;
    const status = e.$metadata?.httpStatusCode;

    if (typeof status === 'number') {
        // The server answered: the status alone decides (a 403 with a network-looking cause is still a 403).
        if (NETWORK_STATUSES.has(status)) return true;
        if (status >= 400) return false;
    }

    if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;

    if (typeof e.name === 'string') {
        if (NETWORK_NAMES.has(e.name)) return true;
        if (e.name === 'AbortError' && signal?.aborted !== true) return true;
    }

    if (inspect(e.cause, signal, depth + 1, seen)) return true;

    if (Array.isArray(e.errors)) {
        return e.errors.some((inner) => inspect(inner, signal, depth + 1, seen));
    }

    return false;
}
