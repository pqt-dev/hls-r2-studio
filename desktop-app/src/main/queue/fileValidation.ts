/** Validation of source files offered to the queue (spec 4.4 step 0 / 4.3). */
import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { RejectedFile } from '../../shared/ipc';

export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov', 'mkv', 'avi', 'webm'];

export interface FileStat {
    isFile(): boolean;
    size: number;
}

export interface ValidatedFile {
    path: string;
    size: number;
}

/** Key used to detect the same file twice (case-insensitive on Windows). */
export function pathKey(path: string, platform: NodeJS.Platform): string {
    const resolved = resolve(path);

    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function hasVideoExtension(path: string): boolean {
    return VIDEO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

/** Checks one path. Returns the file (with its size) or the reason it was rejected. */
export async function validateVideoPath(
    path: string,
    stat: (path: string) => Promise<FileStat>,
): Promise<{ ok: true; file: ValidatedFile } | { ok: false; rejected: RejectedFile }> {
    const name = basename(path);
    const reject = (reason: string) => ({ ok: false as const, rejected: { name, reason } });

    if (!isAbsolute(path)) return reject('The file path is not valid.');

    if (!hasVideoExtension(path)) {
        return reject(`Unsupported file type. Supported: ${VIDEO_EXTENSIONS.join(', ')}.`);
    }

    let info: FileStat;

    try {
        info = await stat(path);
    } catch {
        return reject('The file was not found.');
    }

    if (!info.isFile()) return reject('This is not a regular file.');
    if (info.size < 1) return reject('The file is empty.');

    return { ok: true, file: { path, size: info.size } };
}
