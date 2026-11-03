import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from './redact';

const home = 'C:\\Users\\alice';

describe('redact', () => {
    it('masks Bearer values', () => {
        expect(redact('Bearer abc.DEF-123_xyz')).toBe(`Bearer ${REDACTED}`);
    });

    it('masks Authorization header text', () => {
        const out = redact('Authorization: Bearer 12|abcdefghijklmnopqrstuvwxyz0123');
        expect(out).not.toContain('abcdefghij');
        expect(out).toContain(REDACTED);
    });

    it('masks Sanctum-style tokens inside text', () => {
        const out = redact('login ok token=7|AbCdEfGhIjKlMnOpQrStUv123456 done');
        expect(out).not.toContain('AbCdEf');
        expect(out.startsWith('login ok')).toBe(true);
        expect(out.endsWith('done')).toBe(true);
    });

    it('does not touch short number|word pairs', () => {
        expect(redact('a 1|abc b')).toBe('a 1|abc b');
    });

    it('masks values of sensitive keys at any depth', () => {
        const out = redact({
            token: 't',
            nested: { Password: 'p', secret_access_key: 's', accessKeyId: 'k', keep: 'ok' },
            list: [{ authorization: 'Bearer x' }],
        }) as Record<string, unknown>;
        expect(out).toEqual({
            token: REDACTED,
            nested: {
                Password: REDACTED,
                secret_access_key: REDACTED,
                accessKeyId: REDACTED,
                keep: 'ok',
            },
            list: [{ authorization: REDACTED }],
        });
    });

    it('replaces the home directory with ~ in all slash styles, case-insensitively', () => {
        const opts = { homeDir: home };
        expect(redact('C:\\Users\\alice\\Videos\\a.mp4', opts)).toBe('~\\Videos\\a.mp4');
        expect(redact('C:/Users/alice/Videos/a.mp4', opts)).toBe('~/Videos/a.mp4');
        expect(redact('c:\\users\\ALICE\\x', opts)).toBe('~\\x');
    });

    it('replaces a POSIX home directory', () => {
        expect(redact('/Users/bob/file', { homeDir: '/Users/bob' })).toBe('~/file');
    });

    it('ignores a root-like home directory', () => {
        expect(redact('/etc/x', { homeDir: '/' })).toBe('/etc/x');
    });

    it('redacts inside Error objects', () => {
        const err = new Error('failed in C:\\Users\\alice\\x with Bearer secrettoken');
        const out = redact(err, { homeDir: home }) as { message: string };
        expect(out.message).toBe(`failed in ~\\x with Bearer ${REDACTED}`);
    });

    it('handles circular references and does not mutate input', () => {
        const a: Record<string, unknown> = { token: 'x', name: 'n' };
        a['self'] = a;
        const out = redact(a) as Record<string, unknown>;
        expect(out['self']).toBe('[Circular]');
        expect(a['token']).toBe('x');
    });

    it('passes primitives through', () => {
        expect(redact(5)).toBe(5);
        expect(redact(null)).toBeNull();
    });
});
