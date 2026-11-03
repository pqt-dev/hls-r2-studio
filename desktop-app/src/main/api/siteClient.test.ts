import { describe, expect, it, vi } from 'vitest';
import { RegisterRequestError } from '../pipeline/registerClient';
import type { RegisterPayload } from '../pipeline/register';
import { createSiteClient, SiteApiError, type FetchFn, type SiteClientOptions } from './siteClient';

interface Call {
    url: string;
    init: RequestInit;
}

const CONFIG_BODY = {
    r2: {
        access_key_id: 'AKIA',
        secret_access_key: 'shh',
        bucket: 'b',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        url: 'https://cdn.example.com',
    },
    transcode: { resolution: '720', segment_seconds: 6, fps: null },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function setup(
    respond: (call: Call) => Response | Promise<Response>,
    overrides: Partial<SiteClientOptions> = {},
) {
    const calls: Call[] = [];
    const fetchFn: FetchFn = async (url, init) => {
        const call = { url, init };
        calls.push(call);

        return respond(call);
    };
    const onUnauthorized = vi.fn();
    const client = createSiteClient({
        fetch: fetchFn,
        getBaseUrl: () => 'https://site.example.com/',
        getToken: () => 'tok-123',
        userAgent: 'test-agent',
        onUnauthorized,
        ...overrides,
    });

    return { client, calls, onUnauthorized };
}

function headersOf(call: Call | undefined): Record<string, string> {
    return (call?.init.headers ?? {}) as Record<string, string>;
}

const PAYLOAD = { public_id: 'abcdefghij12' } as RegisterPayload;

describe('login', () => {
    it('posts credentials without a token and returns token + username', async () => {
        const { client, calls } = setup(() =>
            json(200, { token: '1|abc', user: { username: 'admin' } }),
        );

        const result = await client.login('admin', 'pw', 'My PC');

        expect(result).toEqual({ token: '1|abc', username: 'admin' });
        expect(calls[0]?.url).toBe('https://site.example.com/api/app/login');
        expect(calls[0]?.init.method).toBe('POST');
        expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
            username: 'admin',
            password: 'pw',
            device_name: 'My PC',
        });
        expect(headersOf(calls[0])['Authorization']).toBeUndefined();
        expect(headersOf(calls[0])['Accept']).toBe('application/json');
        expect(headersOf(calls[0])['User-Agent']).toBe('test-agent');
        expect(calls[0]?.init.redirect).toBe('manual');
    });

    it('maps 422 and 429 to SiteApiError with status and Retry-After', async () => {
        const a = setup(() => json(422, { message: 'x' }));
        await expect(a.client.login('a', 'b', 'c')).rejects.toMatchObject({ status: 422 });

        const b = setup(() => json(429, {}, { 'Retry-After': '42' }));
        await expect(b.client.login('a', 'b', 'c')).rejects.toMatchObject({
            status: 429,
            retryAfterSeconds: 42,
        });
        // A failed login is not an "expired session".
        expect(a.onUnauthorized).not.toHaveBeenCalled();
    });

    it('rejects an invalid success body', async () => {
        const { client } = setup(() => json(200, { token: '' }));
        await expect(client.login('a', 'b', 'c')).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
});

describe('logout', () => {
    it('sends the bearer token and accepts 204', async () => {
        const { client, calls } = setup(() => new Response(null, { status: 204 }));

        await client.logout();

        expect(headersOf(calls[0])['Authorization']).toBe('Bearer tok-123');
        expect(calls[0]?.url).toBe('https://site.example.com/api/app/logout');
    });

    it('fails on other statuses', async () => {
        const { client } = setup(() => json(500, {}));
        await expect(client.logout()).rejects.toMatchObject({ status: 500 });
    });
});

describe('getConfig', () => {
    it('parses the config', async () => {
        const { client, calls } = setup(() => json(200, CONFIG_BODY));
        const config = await client.getConfig();

        expect(config.r2.bucket).toBe('b');
        expect(config.transcode).toEqual({ resolution: '720', segment_seconds: 6, fps: null });
        expect(calls[0]?.init.method).toBe('GET');
        expect(calls[0]?.init.body).toBeUndefined();
    });

    it('reports 409 r2_not_configured with its code', async () => {
        const { client } = setup(() => json(409, { error: 'r2_not_configured' }));
        await expect(client.getConfig()).rejects.toMatchObject({
            status: 409,
            code: 'r2_not_configured',
        });
    });

    it('rejects malformed config bodies', async () => {
        for (const body of [
            {},
            { r2: {}, transcode: {} },
            { ...CONFIG_BODY, transcode: { resolution: '999', segment_seconds: 6, fps: null } },
        ]) {
            const { client } = setup(() => json(200, body));
            await expect(client.getConfig()).rejects.toMatchObject({ code: 'invalid_response' });
        }
    });

    it('tolerates non-JSON bodies', async () => {
        const { client } = setup(() => new Response('<html>oops</html>', { status: 502 }));
        await expect(client.getConfig()).rejects.toMatchObject({ status: 502, code: null });
    });

    it('calls onUnauthorized on 401 (once, only for the current token)', async () => {
        const a = setup(() => json(401, { message: 'Unauthenticated.' }));
        await expect(a.client.getConfig()).rejects.toMatchObject({ status: 401 });
        expect(a.onUnauthorized).toHaveBeenCalledTimes(1);

        let token = 'old';
        const b = setup(
            () => {
                token = 'new';

                return json(401, {});
            },
            { getToken: () => token },
        );
        await expect(b.client.getConfig()).rejects.toMatchObject({ status: 401 });
        expect(b.onUnauthorized).not.toHaveBeenCalled();
    });

    it.each([
        ['http endpoint', { endpoint: 'http://acct.r2.cloudflarestorage.com' }],
        ['http public url', { url: 'http://cdn.example.com' }],
        ['http localhost when not allowed', { endpoint: 'http://localhost:9000' }],
        ['endpoint with credentials', { endpoint: 'https://u:p@acct.example.com' }],
        ['non-url endpoint', { endpoint: 'not a url' }],
        ['blank bucket', { bucket: '   ' }],
    ])('rejects an unsafe R2 location: %s', async (_name, r2) => {
        const { client } = setup(() =>
            json(200, { ...CONFIG_BODY, r2: { ...CONFIG_BODY.r2, ...r2 } }),
        );

        await expect(client.getConfig()).rejects.toMatchObject({ code: 'invalid_r2_location' });
    });

    it('allows an http://localhost R2 endpoint only when insecure localhost is allowed', async () => {
        const body = {
            ...CONFIG_BODY,
            r2: { ...CONFIG_BODY.r2, endpoint: 'http://127.0.0.1:9000', url: 'http://localhost/x' },
        };
        const { client } = setup(() => json(200, body), { allowInsecureLocalhost: true });

        expect((await client.getConfig()).r2.endpoint).toBe('http://127.0.0.1:9000');
    });

    it('fails with 401 without a request when there is no token', async () => {
        const { client, calls } = setup(() => json(200, CONFIG_BODY), { getToken: () => null });
        await expect(client.getConfig()).rejects.toMatchObject({
            status: 401,
            code: 'not_signed_in',
        });
        expect(calls).toHaveLength(0);
    });
});

describe('register', () => {
    it('returns the registered video on 201 and 200', async () => {
        const body = {
            id: 5,
            public_id: 'abcdefghij12',
            embed_url: 'https://site.example.com/embed/x',
        };

        for (const status of [200, 201]) {
            const { client, calls } = setup(() => json(status, body));
            expect(await client.register(PAYLOAD)).toEqual(body);
            expect(calls[0]?.url).toBe('https://site.example.com/api/app/videos');
            expect(headersOf(calls[0])['Authorization']).toBe('Bearer tok-123');
            expect(headersOf(calls[0])['Content-Type']).toBe('application/json');
        }
    });

    it.each([
        [401, undefined, null],
        [409, 'public_id_conflict', null],
        [422, 'playlist_not_found', null],
        [429, undefined, 7],
        [503, 'storage_unavailable', null],
    ])('throws RegisterRequestError for HTTP %i', async (status, code, retryAfter) => {
        const { client, onUnauthorized } = setup(() =>
            json(
                status,
                code === undefined ? {} : { error: code },
                retryAfter === null ? {} : { 'Retry-After': String(retryAfter) },
            ),
        );

        const error = await client.register(PAYLOAD).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(RegisterRequestError);
        expect((error as RegisterRequestError).failure).toEqual({
            kind: 'http',
            status,
            errorCode: code ?? null,
            retryAfterSeconds: retryAfter,
        });
        expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    });

    it('maps transport failures and bad 2xx bodies to a network failure', async () => {
        const a = setup(() => {
            throw new TypeError('fetch failed');
        });
        const e1 = await a.client.register(PAYLOAD).catch((e: unknown) => e);
        expect((e1 as RegisterRequestError).failure).toEqual({ kind: 'network' });

        const b = setup(() => json(201, { nope: true }));
        const e2 = await b.client.register(PAYLOAD).catch((e: unknown) => e);
        expect((e2 as RegisterRequestError).failure).toEqual({ kind: 'network' });
    });

    it('maps a missing token to an HTTP 401 failure', async () => {
        const { client } = setup(() => json(200, {}), { getToken: () => null });
        const error = await client.register(PAYLOAD).catch((e: unknown) => e);
        expect((error as RegisterRequestError).failure).toMatchObject({
            kind: 'http',
            status: 401,
        });
    });
});

describe('response size limit', () => {
    function streamed(chunks: Uint8Array[], onCancel?: () => void, status = 200): Response {
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                const chunk = chunks[index++];

                if (chunk === undefined) controller.close();
                else controller.enqueue(chunk);
            },
            cancel() {
                onCancel?.();
            },
        });

        return new Response(stream, { status });
    }

    it('reads a normal multi-chunk body', async () => {
        const encoder = new TextEncoder();
        const text = JSON.stringify(CONFIG_BODY);
        const half = Math.floor(text.length / 2);
        const { client } = setup(() =>
            streamed([encoder.encode(text.slice(0, half)), encoder.encode(text.slice(half))]),
        );

        expect((await client.getConfig()).r2.bucket).toBe('b');
    });

    it('aborts as soon as the limit is exceeded without reading the rest', async () => {
        let pulled = 0;
        let cancelled = false;
        const big = new Uint8Array(600 * 1024);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled++;
                controller.enqueue(big);
            },
            cancel() {
                cancelled = true;
            },
        });
        const { client } = setup(() => new Response(stream, { status: 200 }));

        await expect(client.getConfig()).rejects.toMatchObject({
            network: true,
            message: 'The response from the site could not be read.',
        });
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThanOrEqual(3);
    });

    it('accepts a body of exactly 1 MB but rejects one byte more', async () => {
        const exact = new Uint8Array(1024 * 1024).fill(32);
        const ok = setup(() => streamed([exact]));

        await expect(ok.client.getConfig()).rejects.toMatchObject({ code: 'invalid_response' });

        const over = setup(() => streamed([exact, new Uint8Array([32])]));

        await expect(over.client.getConfig()).rejects.toMatchObject({ network: true });
    });
});

describe('safety rules', () => {
    it('refuses to follow redirects and never retries elsewhere', async () => {
        const { client, calls } = setup(
            () =>
                new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
        );

        const error = await client.getConfig().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SiteApiError);
        expect(error).toMatchObject({ code: 'unexpected_redirect', status: 302, network: true });
        expect(calls).toHaveLength(1);
    });

    it('refuses insecure and invalid base URLs without sending anything', async () => {
        for (const url of [
            'http://site.example.com',
            'http://localhost:8000',
            '',
            'https://u:p@x.com',
        ]) {
            const { client, calls } = setup(() => json(200, CONFIG_BODY), {
                getBaseUrl: () => url,
            });
            await expect(client.getConfig()).rejects.toMatchObject({ code: 'invalid_site_url' });
            expect(calls).toHaveLength(0);
        }
    });

    it('allows http://localhost only with allowInsecureLocalhost', async () => {
        const { client, calls } = setup(() => json(200, CONFIG_BODY), {
            getBaseUrl: () => 'http://localhost:8000/ignored/path',
            allowInsecureLocalhost: true,
        });

        await client.getConfig();

        expect(calls[0]?.url).toBe('http://localhost:8000/api/app/config');
    });

    it('times out through the abort signal', async () => {
        vi.useFakeTimers();

        try {
            const { client } = setup(
                ({ init }) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                    }),
                { timeoutMs: 1000 },
            );

            const pending = client.getConfig().catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(1001);
            const error = await pending;

            expect(error).toMatchObject({ code: 'timeout', network: true });
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports network errors as network failures', async () => {
        const { client } = setup(() => {
            throw new TypeError('fetch failed');
        });
        await expect(client.getConfig()).rejects.toMatchObject({ network: true, code: 'network' });
    });

    it('never puts the token or password into error messages', async () => {
        const { client } = setup(() => json(500, { error: 'boom', token: 'tok-123' }));
        const error = (await client.getConfig().catch((e: unknown) => e)) as Error;
        expect(error.message).not.toContain('tok-123');
    });
});
