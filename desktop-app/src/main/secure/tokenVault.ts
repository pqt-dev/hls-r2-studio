import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureBackend } from './backend';

export interface TokenVaultOptions {
    /** Directory that holds the encrypted token file (userData). */
    dir: string;
    backend: SecureBackend;
    /** Default `token.bin`. */
    fileName?: string;
}

export type SaveResult = 'persisted' | 'memory-only';

/**
 * Keeps the site API token. The token is written to disk only when it can be encrypted;
 * otherwise it stays in memory for the current session.
 */
export class TokenVault {
    private readonly filePath: string;
    private readonly backend: SecureBackend;
    private readonly dir: string;
    private token: string | null = null;

    constructor(options: TokenVaultOptions) {
        this.dir = options.dir;
        this.backend = options.backend;
        this.filePath = join(options.dir, options.fileName ?? 'token.bin');
    }

    /** Token currently held in memory (after load() or save()). */
    get(): string | null {
        return this.token;
    }

    /** Loads the persisted token. Returns null when missing, corrupt or undecryptable. */
    async load(): Promise<string | null> {
        if (this.token !== null) return this.token;
        if (!this.backend.isAvailable()) return null;

        let data: Buffer;
        try {
            data = await readFile(this.filePath);
        } catch {
            return null;
        }
        if (data.length === 0) return null;

        try {
            const token = this.backend.decrypt(data);
            if (token === '') return null;
            this.token = token;
            return token;
        } catch {
            return null;
        }
    }

    /**
     * Stores the token in memory and, when encryption is available, on disk.
     * When encryption is unavailable nothing is written and any older file is removed.
     */
    async save(token: string): Promise<SaveResult> {
        this.token = token;

        if (!this.backend.isAvailable()) {
            await rm(this.filePath, { force: true });
            return 'memory-only';
        }

        let encrypted: Buffer;
        try {
            encrypted = this.backend.encrypt(token);
        } catch {
            await rm(this.filePath, { force: true });
            return 'memory-only';
        }

        await mkdir(this.dir, { recursive: true });
        const tmpPath = `${this.filePath}.tmp`;
        await writeFile(tmpPath, encrypted, { mode: 0o600 });
        await rename(tmpPath, this.filePath);
        return 'persisted';
    }

    /** Keeps the token in memory only (never on disk) and removes any previously saved file. */
    async saveMemoryOnly(token: string): Promise<void> {
        this.token = token;
        await rm(this.filePath, { force: true });
    }

    /** Forgets the token in memory and deletes the file. */
    async clear(): Promise<void> {
        this.token = null;
        await rm(this.filePath, { force: true });
    }
}
