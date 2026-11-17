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
});
