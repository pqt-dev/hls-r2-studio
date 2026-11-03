import { describe, expect, it } from 'vitest';
import { normalizeSiteUrl, SiteUrlError } from './siteUrl';

describe('normalizeSiteUrl', () => {
    it('accepts https and returns the origin only', () => {
        expect(normalizeSiteUrl(' https://Example.com/ ', false)).toBe('https://example.com');
        expect(normalizeSiteUrl('https://example.com:8443/a/b?x=1#h', false)).toBe(
            'https://example.com:8443',
        );
    });

    it('rejects empty, malformed and non-http(s) URLs', () => {
        for (const bad of ['', '  ', 'not a url', 'ftp://example.com', 'javascript:alert(1)']) {
            expect(() => normalizeSiteUrl(bad, true)).toThrow(SiteUrlError);
        }
    });

    it('rejects credentials in the URL', () => {
        expect(() => normalizeSiteUrl('https://user:pw@example.com', false)).toThrow(/user name/);
        expect(() => normalizeSiteUrl('https://user@example.com', false)).toThrow(SiteUrlError);
    });

    it('rejects http unless localhost is allowed', () => {
        expect(() => normalizeSiteUrl('http://example.com', true)).toThrow(SiteUrlError);
        expect(() => normalizeSiteUrl('http://localhost:8000', false)).toThrow(SiteUrlError);
        expect(normalizeSiteUrl('http://localhost:8000/x', true)).toBe('http://localhost:8000');
        expect(normalizeSiteUrl('http://127.0.0.1', true)).toBe('http://127.0.0.1');
        expect(() => normalizeSiteUrl('http://localhost.evil.com', true)).toThrow(SiteUrlError);
    });
});
