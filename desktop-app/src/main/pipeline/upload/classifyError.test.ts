import { describe, expect, it } from 'vitest';
import { classifyUploadError } from './classifyError';

function withCode(code: string, name = 'Error'): Error {
    return Object.assign(new Error(code), { code, name });
}

function http(status: number, name = 'ServiceException'): Error {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

describe('classifyUploadError', () => {
    it.each([
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
    ])('treats the %s code as a network error', (code) => {
        expect(classifyUploadError(withCode(code))).toBe('network');
    });

    it.each([
        'TimeoutError',
        'NetworkingError',
        'RequestTimeout',
        'SlowDown',
        'ServiceUnavailable',
        'InternalError',
    ])('treats the %s error name as a network error', (name) => {
        expect(classifyUploadError(Object.assign(new Error('x'), { name }))).toBe('network');
    });

    it.each([408, 429, 500, 502, 503, 504])('treats HTTP %i as a network error', (status) => {
        expect(classifyUploadError(http(status))).toBe('network');
    });

    it.each([400, 401, 403, 404, 409, 412, 501])('treats HTTP %i as another error', (status) => {
        expect(classifyUploadError(http(status))).toBe('other');
    });

    it.each(['NoSuchBucket', 'AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'])(
        'treats %s as another error',
        (name) => {
            expect(classifyUploadError(http(403, name))).toBe('other');
            expect(classifyUploadError(Object.assign(new Error(name), { name }))).toBe('other');
        },
    );

    it('treats local file and validation errors as other', () => {
        expect(classifyUploadError(withCode('ENOENT'))).toBe('other');
        expect(classifyUploadError(withCode('EACCES'))).toBe('other');
        expect(classifyUploadError(withCode('EMFILE'))).toBe('other');
        expect(classifyUploadError(new TypeError('bad input'))).toBe('other');
        expect(classifyUploadError(new Error('boom'))).toBe('other');
    });

    it('follows err.cause chains', () => {
        const root = withCode('ECONNRESET');
        const wrapped = new Error('fetch failed', { cause: new Error('mid', { cause: root }) });

        expect(classifyUploadError(wrapped)).toBe('network');
        expect(classifyUploadError(new Error('x', { cause: withCode('ENOENT') }))).toBe('other');
    });

    it('looks into AggregateError members (dual stack connect failures)', () => {
        const aggregate = new AggregateError(
            [withCode('ECONNREFUSED'), withCode('ECONNREFUSED')],
            'x',
        );

        expect(classifyUploadError(aggregate)).toBe('network');
    });

    it('lets an HTTP answer decide over a network looking cause', () => {
        const error = Object.assign(new Error('denied', { cause: withCode('ECONNRESET') }), {
            $metadata: { httpStatusCode: 403 },
        });

        expect(classifyUploadError(error)).toBe('other');
    });

    it('survives cyclic causes and non-error values', () => {
        const a: { cause?: unknown } = {};
        a.cause = a;

        expect(classifyUploadError(a)).toBe('other');
        expect(classifyUploadError(null)).toBe('other');
        expect(classifyUploadError(undefined)).toBe('other');
        expect(classifyUploadError('ECONNRESET')).toBe('other');
    });

    describe('AbortError', () => {
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

        it('is a network error when it is the SDK timeout (our signal not aborted)', () => {
            expect(classifyUploadError(abortError)).toBe('network');
            expect(classifyUploadError(abortError, new AbortController().signal)).toBe('network');
        });

        it('is NOT a network error when our own signal was aborted', () => {
            const controller = new AbortController();

            controller.abort();
            expect(classifyUploadError(abortError, controller.signal)).toBe('other');
        });
    });
});
