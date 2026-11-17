import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

function directive(csp: string, name: string): string | undefined {
    return csp.split('; ').find((part) => part.startsWith(`${name} `));
}

describe('CSP', () => {
    it('allows https images only for img-src and keeps connections local', () => {
        for (const dev of [false, true]) {
            const csp = buildCsp({ dev, devServerOrigin: 'http://localhost:5173' });

            expect(directive(csp, 'img-src')).toBe("img-src 'self' data: https:");
            expect(directive(csp, 'connect-src')).not.toContain('https:');
            expect(directive(csp, 'script-src')).not.toContain('https:');
            expect(directive(csp, 'default-src')).toBe("default-src 'self'");
        }
    });

    it('frames nothing by default and only the site origin when it is given', () => {
        for (const dev of [false, true]) {
            expect(directive(buildCsp({ dev }), 'frame-src')).toBe("frame-src 'none'");
            expect(
                directive(buildCsp({ dev, siteOrigin: 'https://site.example.com' }), 'frame-src'),
            ).toBe('frame-src https://site.example.com');
            expect(
                directive(
                    buildCsp({ dev, siteOrigin: 'https://site.example.com:8443' }),
                    'frame-src',
                ),
            ).toBe('frame-src https://site.example.com:8443');
        }
    });

    it('never widens frame-src for an invalid origin', () => {
        for (const siteOrigin of [
            '',
            'https:',
            '*',
            'http://site.example.com',
            'https://site.example.com/path',
            'https://user@site.example.com',
            'https://site.example.com; script-src *',
            'https://*.example.com',
        ]) {
            const csp = buildCsp({ dev: false, siteOrigin });

            expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
            expect(csp).not.toContain('*');
        }
    });
});
