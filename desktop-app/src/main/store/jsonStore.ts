import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** File operations used by the store; injectable so tests can observe or slow them down. */
export interface FileOps {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
    rm(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}

export const nodeFileOps: FileOps = {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, 'utf8'),
    rename,
    copyFile,
    rm: (path) => rm(path, { force: true }),
    mkdir: async (path) => {
        await mkdir(path, { recursive: true });
    },
};

export interface JsonStoreOptions<T extends { schemaVersion: number }> {
    filePath: string;
    /** Current schema version written to disk. */
    schemaVersion: number;
    /** Fresh default data (must carry `schemaVersion`). Called each time defaults are needed. */
    createDefaults: () => T;
    /** Converts data saved with an older schema into the current shape. Throwing => treated as corrupt. */
    migrate?: (oldData: unknown, fromVersion: number) => T;
    /**
     * Shape check for data of the CURRENT schema (also applied to migrated data). Returning false
     * (or throwing) treats the file as corrupt: it is copied to `.bak` and defaults are used.
     */
    validate?: (data: unknown) => boolean;
    /** Delay before a scheduled write hits the disk. Default 200 ms. */
    debounceMs?: number;
    fileOps?: FileOps;
    /** Called when a background write fails. */
    onError?: (error: unknown) => void;
}

/**
 * Single-file JSON store with atomic writes (temp file + rename), tolerant loading
 * and serialized, debounced saves.
 */
export class JsonStore<T extends { schemaVersion: number }> {
    private data: T;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<void> = Promise.resolve();
    private readonly fileOps: FileOps;
    private readonly debounceMs: number;

    constructor(private readonly options: JsonStoreOptions<T>) {
        this.fileOps = options.fileOps ?? nodeFileOps;
        this.debounceMs = options.debounceMs ?? 200;
        this.data = options.createDefaults();
    }

    /**
     * Loads the file. A missing file yields defaults. A corrupt, unmigratable or newer-version
     * file is copied to `<file>.bak` and defaults are used instead.
     */
    async load(): Promise<T> {
        let raw: string;
        try {
            raw = await this.fileOps.readFile(this.options.filePath);
        } catch {
            this.data = this.options.createDefaults();
            return this.data;
        }

        try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('Store root must be an object');
            }
            const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
            const fromVersion =
                typeof version === 'number' && Number.isInteger(version) ? version : 0;

            if (fromVersion === this.options.schemaVersion) {
                if (this.options.validate && !this.options.validate(parsed)) {
                    throw new Error('Store data has an invalid shape');
                }
                this.data = parsed as T;
            } else if (fromVersion < this.options.schemaVersion && this.options.migrate) {
                const migrated = this.options.migrate(parsed, fromVersion);
                migrated.schemaVersion = this.options.schemaVersion;
                if (this.options.validate && !this.options.validate(migrated)) {
                    throw new Error('Migrated store data has an invalid shape');
                }
                this.data = migrated;
                this.scheduleSave();
            } else {
                throw new Error(`Unsupported schema version ${fromVersion}`);
            }
        } catch {
            await this.keepBackup();
            this.data = this.options.createDefaults();
        }
        return this.data;
    }

    /** Current in-memory data. Do not mutate directly; use update(). */
    get(): T {
        return this.data;
    }

    /** Mutates the data in place (or returns a replacement) and schedules a debounced save. */
    update(mutator: (draft: T) => T | void): void {
        const result = mutator(this.data);
        if (result !== undefined) this.data = result;
        this.scheduleSave();
    }

    /** Writes any pending change now and resolves when all queued writes are finished. */
    async flush(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
            this.enqueueWrite();
        }
        await this.chain;
    }

    private scheduleSave(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.enqueueWrite();
        }, this.debounceMs);
    }

    /** Writes are chained so two writes never run at the same time. */
    private enqueueWrite(): void {
        this.chain = this.chain
            .then(() => this.writeAtomic())
            .catch((error: unknown) => {
                this.options.onError?.(error);
            });
    }

    private async writeAtomic(): Promise<void> {
        const { filePath } = this.options;
        const tmpPath = `${filePath}.tmp`;
        // Snapshot at write time so the latest state always wins.
        const json = JSON.stringify(this.data, null, 2);
        await this.fileOps.mkdir(dirname(filePath));
        try {
            await this.fileOps.writeFile(tmpPath, json);
            await this.fileOps.rename(tmpPath, filePath);
        } catch (error) {
            await this.fileOps.rm(tmpPath).catch(() => undefined);
            throw error;
        }
    }

    private async keepBackup(): Promise<void> {
        try {
            await this.fileOps.copyFile(this.options.filePath, `${this.options.filePath}.bak`);
        } catch {
            // Best effort: the original is replaced on the next successful write anyway.
        }
    }
}
