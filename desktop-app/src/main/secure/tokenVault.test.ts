import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecureBackend } from './backend';
import { TokenVault } from './tokenVault';

/** Fake backend: "encrypts" by reversing and prefixing, so plaintext never appears on disk. */
function createFakeBackend(available = true): SecureBackend & { available: boolean } {
    const backend = {
        available,
        isAvailable: () => backend.available,
        encrypt: (plain: string) => Buffer.from('ENC:' + [...plain].reverse().join('')),
        decrypt: (data: Buffer) => {
            const text = data.toString();
            if (!text.startsWith('ENC:')) throw new Error('bad data');
            return [...text.slice(4)].reverse().join('');
        },
    };
    return backend;
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hls-vault-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('TokenVault', () => {
    it('persists an encrypted token and loads it in a new instance', async () => {
        const backend = createFakeBackend();
        const vault = new TokenVault({ dir, backend });
        expect(await vault.save('1|secrettokenvalue')).toBe('persisted');

        const onDisk = readFileSync(join(dir, 'token.bin'));
        expect(onDisk.toString()).not.toContain('secrettokenvalue');

        const second = new TokenVault({ dir, backend });
        expect(second.get()).toBeNull();
        expect(await second.load()).toBe('1|secrettokenvalue');
        expect(second.get()).toBe('1|secrettokenvalue');
    });

    it('returns null when the file is missing', async () => {
        const vault = new TokenVault({ dir, backend: createFakeBackend() });
        expect(await vault.load()).toBeNull();
    });

    it('returns null for a corrupt file', async () => {
        writeFileSync(join(dir, 'token.bin'), 'garbage');
        const vault = new TokenVault({ dir, backend: createFakeBackend() });
        expect(await vault.load()).toBeNull();
    });

    it('returns null for an empty file', async () => {
        writeFileSync(join(dir, 'token.bin'), '');
        const vault = new TokenVault({ dir, backend: createFakeBackend() });
        expect(await vault.load()).toBeNull();
    });

    it('returns null when decryption throws', async () => {
        const backend = createFakeBackend();
        backend.decrypt = () => {
            throw new Error('DPAPI failure');
        };
        await new TokenVault({ dir, backend: createFakeBackend() }).save('tok');
        expect(await new TokenVault({ dir, backend }).load()).toBeNull();
    });

    it('returns null on load when encryption is unavailable', async () => {
        await new TokenVault({ dir, backend: createFakeBackend() }).save('tok');
        const vault = new TokenVault({ dir, backend: createFakeBackend(false) });
        expect(await vault.load()).toBeNull();
    });

    it('refuses to write to disk when encryption is unavailable but keeps the token in memory', async () => {
        const vault = new TokenVault({ dir, backend: createFakeBackend(false) });
        expect(await vault.save('session-token')).toBe('memory-only');
        expect(vault.get()).toBe('session-token');
        expect(readdirSync(dir)).toEqual([]);
    });

    it('removes a stale token file when encryption becomes unavailable', async () => {
        await new TokenVault({ dir, backend: createFakeBackend() }).save('old');
        const vault = new TokenVault({ dir, backend: createFakeBackend(false) });
        expect(await vault.save('new')).toBe('memory-only');
        expect(readdirSync(dir)).toEqual([]);
    });

    it('falls back to memory-only when encrypt throws', async () => {
        const backend = createFakeBackend();
        backend.encrypt = () => {
            throw new Error('boom');
        };
        const vault = new TokenVault({ dir, backend });
        expect(await vault.save('tok')).toBe('memory-only');
        expect(vault.get()).toBe('tok');
        expect(readdirSync(dir)).toEqual([]);
    });

    it('clear() removes the file and the in-memory token', async () => {
        const vault = new TokenVault({ dir, backend: createFakeBackend() });
        await vault.save('tok');
        await vault.clear();
        expect(vault.get()).toBeNull();
        expect(readdirSync(dir)).toEqual([]);
        await expect(vault.clear()).resolves.toBeUndefined();
    });

    it('leaves no temp file behind after saving', async () => {
        const vault = new TokenVault({ dir, backend: createFakeBackend() });
        await vault.save('tok');
        expect(readdirSync(dir)).toEqual(['token.bin']);
    });
});
