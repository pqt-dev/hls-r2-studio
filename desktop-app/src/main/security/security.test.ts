import { describe, expect, it, vi } from 'vitest';
import { buildCsp } from '../../shared/csp';
import { openExternalHttps } from './external';
import { buildAppLocation, isAppUrl } from './navigation';
import { hardenSession } from './session';

describe('isAppUrl', () => {
    const dev = { devServerUrl: 'http://localhost:5173' };
    const prod = { indexFileUrl: 'file:///C:/app/resources/out/renderer/index.html' };

    it('allows the dev server origin', () => {
        expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
        expect(isAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    });

    it('rejects other origins and garbage', () => {
        expect(isAppUrl('https://evil.example/', dev)).toBe(false);
        expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
        expect(isAppUrl('not a url', dev)).toBe(false);
        expect(isAppUrl('', dev)).toBe(false);
    });

    it('allows only the packaged index.html', () => {
        expect(isAppUrl('file:///C:/app/resources/out/renderer/index.html', prod)).toBe(true);
        expect(isAppUrl('file:///C:/app/resources/out/renderer/index.html#/x', prod)).toBe(true);
        expect(isAppUrl('file:///C:/Windows/system.ini', prod)).toBe(false);
        expect(isAppUrl('https://example.com/', prod)).toBe(false);
    });
});

describe('buildAppLocation', () => {
    const indexFileUrl = 'file:///C:/app/resources/out/renderer/index.html';

    it('uses the dev server URL only when not packaged', () => {
        const dev = buildAppLocation({
            isPackaged: false,
            rendererUrlEnv: 'http://localhost:5173',
            indexFileUrl,
        });

        expect(dev.devServerUrl).toBe('http://localhost:5173');
        expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
    });

    it('ignores ELECTRON_RENDERER_URL in a packaged app, including the navigation allow-list', () => {
        const prod = buildAppLocation({
            isPackaged: true,
            rendererUrlEnv: 'https://evil.example',
            indexFileUrl,
        });

        expect(prod.devServerUrl).toBeUndefined();
        expect(isAppUrl('https://evil.example/', prod)).toBe(false);
        expect(isAppUrl(indexFileUrl, prod)).toBe(true);
    });
});

describe('hardenSession', () => {
    function fakeSession() {
        return {
            webRequest: { onHeadersReceived: vi.fn() },
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
        };
    }

    it('denies permission requests and permission checks', () => {
        const session = fakeSession();

        hardenSession(session as never, false, {});

        const request = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
            ...args: unknown[]
        ) => void;
        const callback = vi.fn();

        request({}, 'media', callback);

        expect(callback).toHaveBeenCalledWith(false);

        const check = session.setPermissionCheckHandler.mock.calls[0]?.[0] as () => boolean;

        expect(check()).toBe(false);
    });

    it('sets the CSP header', () => {
        const session = fakeSession();

        hardenSession(session as never, false, {});

        const onHeaders = session.webRequest.onHeadersReceived.mock.calls[0]?.[0] as (
            details: { responseHeaders: Record<string, string[]> },
            cb: (r: { responseHeaders: Record<string, string[]> }) => void,
        ) => void;
        const cb = vi.fn();

        onHeaders({ responseHeaders: { X: ['1'] } }, cb);

        const headers = cb.mock.calls[0]?.[0].responseHeaders;

        expect(headers['X']).toEqual(['1']);
        expect(headers['Content-Security-Policy'][0]).toContain("default-src 'self'");
    });
});

describe('openExternalHttps', () => {
    it('opens https URLs', async () => {
        const opener = vi.fn().mockResolvedValue(undefined);
        expect(await openExternalHttps('https://example.com/a?b=1', opener)).toBe(true);
        expect(opener).toHaveBeenCalledWith('https://example.com/a?b=1');
    });

    it.each([
        'http://example.com',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ms-msdt:/id',
        'https://user:pw@example.com',
        'nonsense',
    ])('refuses %s', async (url) => {
        const opener = vi.fn();
        expect(await openExternalHttps(url, opener)).toBe(false);
        expect(opener).not.toHaveBeenCalled();
    });
});

describe('buildCsp', () => {
    it('is strict in production', () => {
        const csp = buildCsp({ dev: false });
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self';");
        expect(csp).toContain("connect-src 'self';");
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).not.toContain('ws:');
    });

    it('allows the Vite dev server only in dev', () => {
        const csp = buildCsp({ dev: true, devServerOrigin: 'http://localhost:5173' });
        expect(csp).toContain('http://localhost:5173');
        expect(csp).toContain('ws://localhost:5173');
    });
});
