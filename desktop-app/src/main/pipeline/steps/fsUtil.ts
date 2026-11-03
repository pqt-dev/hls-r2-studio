import { rm, stat } from 'node:fs/promises';

export async function fileExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

/** Deletes the files, ignoring missing ones and any error (best-effort temp cleanup). */
export async function removeFiles(paths: Iterable<string>): Promise<void> {
    await Promise.all([...paths].map((p) => rm(p, { force: true }).catch(() => undefined)));
}
