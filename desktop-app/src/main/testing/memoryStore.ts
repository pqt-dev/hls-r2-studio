/** Test helpers: an AppStore backed by memory, a fake token backend and a recording logger. */
import { createAppStore, type AppStore, type FileOps } from '../store';
import type { Logger } from '../logger';
import type { SecureBackend } from '../secure';

export function memoryFileOps(): FileOps & { files: Map<string, string> } {
    const files = new Map<string, string>();

    return {
        files,
        readFile: (path) => {
            const data = files.get(path);

            return data === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(data);
        },
        writeFile: (path, data) => {
            files.set(path, data);

            return Promise.resolve();
        },
        rename: (from, to) => {
            const data = files.get(from);
            if (data !== undefined) {
                files.set(to, data);
                files.delete(from);
            }

            return Promise.resolve();
        },
        copyFile: () => Promise.resolve(),
        rm: (path) => {
            files.delete(path);

            return Promise.resolve();
        },
        mkdir: () => Promise.resolve(),
    };
}

export function createMemoryStore(tmpRoot = '/tmp/hls-test'): AppStore {
    return createAppStore({
        dir: '/memory',
        defaultTmpRoot: tmpRoot,
        debounceMs: 5,
        fileOps: memoryFileOps(),
    });
}

/** Reversible fake of safeStorage: "encrypts" by prefixing. */
export function fakeBackend(available = true): SecureBackend {
    return {
        isAvailable: () => available,
        encrypt: (plain) => Buffer.from(`enc:${plain}`),
        decrypt: (data) => data.toString().replace(/^enc:/, ''),
    };
}

export interface RecordingLogger extends Logger {
    entries: { level: string; message: string; meta: unknown }[];
}

export function recordingLogger(): RecordingLogger {
    const entries: RecordingLogger['entries'] = [];
    const make = (level: string) => (message: string, meta?: unknown) => {
        entries.push({ level, message, meta });
    };

    return {
        entries,
        debug: make('debug'),
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
    };
}
