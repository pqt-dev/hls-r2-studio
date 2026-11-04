import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    getBuiltInSiteUrl,
    normalizeBuiltInSiteUrl,
    normalizeSiteUrl,
    SiteUrlError,
} from './siteUrl';

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

describe('normalizeBuiltInSiteUrl', () => {
    it('normalizes a valid https URL to its origin', () => {
        expect(normalizeBuiltInSiteUrl(' https://Admin.Example.com/x?y=1 ', false)).toBe(
            'https://admin.example.com',
        );
    });

    it('returns null for missing, empty and invalid values instead of throwing', () => {
        for (const bad of [
            undefined,
            '',
            '  ',
            'not a url',
            'http://admin.example.com',
            'https://user:pw@admin.example.com',
        ]) {
            expect(normalizeBuiltInSiteUrl(bad, false)).toBeNull();
        }
    });

    it('allows http://localhost only when insecure localhost is allowed', () => {
        expect(normalizeBuiltInSiteUrl('http://localhost:8000', true)).toBe(
            'http://localhost:8000',
        );
        expect(normalizeBuiltInSiteUrl('http://localhost:8000', false)).toBeNull();
    });
});

describe('getBuiltInSiteUrl', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('falls back to the runtime env var when there is no build-time define', () => {
        expect(getBuiltInSiteUrl(false, { HLS_SITE_URL: 'https://env.example.com/' })).toBe(
            'https://env.example.com',
        );
    });

    it('is null when nothing is configured or the env value is invalid', () => {
        expect(getBuiltInSiteUrl(false, {})).toBeNull();
        expect(getBuiltInSiteUrl(false, { HLS_SITE_URL: 'http://env.example.com' })).toBeNull();
    });

    it('prefers the build-time define over the runtime env var', () => {
        vi.stubGlobal('__HLS_SITE_URL__', 'https://built.example.com');

        expect(getBuiltInSiteUrl(false, { HLS_SITE_URL: 'https://env.example.com' })).toBe(
            'https://built.example.com',
        );
    });

    it('does not fall back to the env var when the build-time define is invalid', () => {
        vi.stubGlobal('__HLS_SITE_URL__', 'http://built.example.com');

        expect(getBuiltInSiteUrl(false, { HLS_SITE_URL: 'https://env.example.com' })).toBeNull();
    });
});
