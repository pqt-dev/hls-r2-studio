import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore, nodeFileOps } from './jsonStore';
import type { FileOps } from './jsonStore';

interface TestData {
    schemaVersion: number;
    counter: number;
    note: string;
}

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hls-store-'));
    file = join(dir, 'store.json');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function makeStore(extra: Partial<ConstructorParameters<typeof JsonStore<TestData>>[0]> = {}) {
    return new JsonStore<TestData>({
        filePath: file,
        schemaVersion: 2,
        createDefaults: () => ({ schemaVersion: 2, counter: 0, note: 'default' }),
        debounceMs: 5,
        ...extra,
    });
}

describe('JsonStore load', () => {
    it('returns defaults for a missing file', async () => {
        const store = makeStore();
        expect(await store.load()).toEqual({ schemaVersion: 2, counter: 0, note: 'default' });
    });

    it('loads valid data of the current version', async () => {
        writeFileSync(file, JSON.stringify({ schemaVersion: 2, counter: 7, note: 'x' }));
        expect((await makeStore().load()).counter).toBe(7);
    });

    it('keeps a corrupt file as .bak and returns defaults', async () => {
        writeFileSync(file, '{ not json');
        const store = makeStore();
        expect((await store.load()).note).toBe('default');
        expect(readFileSync(`${file}.bak`, 'utf8')).toBe('{ not json');
    });

    it('treats a non-object root as corrupt', async () => {
        writeFileSync(file, '[1,2]');
        await makeStore().load();
        expect(readFileSync(`${file}.bak`, 'utf8')).toBe('[1,2]');
    });

    it('treats data rejected by validate() as corrupt (backup + defaults)', async () => {
        const text = JSON.stringify({ schemaVersion: 2, counter: 'oops', note: 'x' });
        writeFileSync(file, text);
        const store = makeStore({
            validate: (d) => typeof (d as { counter?: unknown }).counter === 'number',
        });

        expect((await store.load()).note).toBe('default');
        expect(readFileSync(`${file}.bak`, 'utf8')).toBe(text);
    });

    it('treats a throwing validate() as corrupt and keeps valid data otherwise', async () => {
        writeFileSync(file, JSON.stringify({ schemaVersion: 2, counter: 1, note: 'x' }));
        const throwing = makeStore({
            validate: () => {
                throw new Error('boom');
            },
        });

        expect((await throwing.load()).note).toBe('default');

        writeFileSync(file, JSON.stringify({ schemaVersion: 2, counter: 1, note: 'x' }));
        const ok = makeStore({ validate: () => true });

        expect((await ok.load()).note).toBe('x');
    });

    it('validates migrated data too', async () => {
        writeFileSync(file, JSON.stringify({ counter: 3 }));
        const store = makeStore({
            migrate: () => ({ schemaVersion: 0, counter: 'bad' as unknown as number, note: 'm' }),
            validate: (d) => typeof (d as { counter?: unknown }).counter === 'number',
        });

        expect((await store.load()).note).toBe('default');
    });

    it('runs the migrate hook for older versions and schedules a save', async () => {
        writeFileSync(file, JSON.stringify({ counter: 3 })); // no schemaVersion => 0
        const seen: number[] = [];
        const store = makeStore({
            migrate: (old, from) => {
                seen.push(from);
                return {
                    schemaVersion: 0,
                    counter: (old as { counter: number }).counter,
                    note: 'migrated',
                };
            },
        });
        const data = await store.load();
        expect(seen).toEqual([0]);
        expect(data).toEqual({ schemaVersion: 2, counter: 3, note: 'migrated' });
        await store.flush();
        expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(2);
    });

    it('falls back to defaults and backs up when migrate throws', async () => {
        writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
        const store = makeStore({
            migrate: () => {
                throw new Error('nope');
            },
        });
        expect((await store.load()).note).toBe('default');
        expect(readdirSync(dir)).toContain('store.json.bak');
    });

    it('backs up data written by a newer schema instead of using it', async () => {
        writeFileSync(file, JSON.stringify({ schemaVersion: 9, counter: 1, note: 'future' }));
        expect((await makeStore().load()).note).toBe('default');
        expect(readdirSync(dir)).toContain('store.json.bak');
    });
});

describe('JsonStore writes', () => {
    it('writes atomically through a temp file and leaves no temp file behind', async () => {
        const calls: string[] = [];
        const fileOps: FileOps = {
            ...nodeFileOps,
            writeFile: async (path, data) => {
                calls.push(`write:${path.endsWith('.tmp') ? 'tmp' : 'final'}`);
                await nodeFileOps.writeFile(path, data);
            },
            rename: async (from, to) => {
                calls.push(`rename:${from.endsWith('.tmp')}->${to === file}`);
                await nodeFileOps.rename(from, to);
            },
        };
        const store = makeStore({ fileOps });
        await store.load();
        store.update((d) => {
            d.counter = 1;
        });
        await store.flush();
        expect(calls).toEqual(['write:tmp', 'rename:true->true']);
        expect(readdirSync(dir)).toEqual(['store.json']);
        expect(JSON.parse(readFileSync(file, 'utf8')).counter).toBe(1);
    });

    it('keeps the old file intact when the write fails, and cleans up the temp file', async () => {
        writeFileSync(file, JSON.stringify({ schemaVersion: 2, counter: 1, note: 'old' }));
        const errors: unknown[] = [];
        const fileOps: FileOps = {
            ...nodeFileOps,
            rename: async () => {
                throw new Error('disk full');
            },
        };
        const store = makeStore({ fileOps, onError: (e) => errors.push(e) });
        await store.load();
        store.update((d) => {
            d.counter = 2;
        });
        await store.flush();
        expect(errors).toHaveLength(1);
        expect(JSON.parse(readFileSync(file, 'utf8')).counter).toBe(1);
        expect(readdirSync(dir)).toEqual(['store.json']);
    });

    it('debounces rapid updates into one write containing the latest state', async () => {
        let writes = 0;
        const fileOps: FileOps = {
            ...nodeFileOps,
            writeFile: async (p, d) => {
                writes++;
                await nodeFileOps.writeFile(p, d);
            },
        };
        const store = makeStore({ fileOps, debounceMs: 20 });
        await store.load();
        for (let i = 1; i <= 10; i++) {
            store.update((d) => {
                d.counter = i;
            });
        }
        await store.flush();
        expect(writes).toBe(1);
        expect(JSON.parse(readFileSync(file, 'utf8')).counter).toBe(10);
    });

    it('never runs two writes at the same time', async () => {
        let active = 0;
        let maxActive = 0;
        const fileOps: FileOps = {
            ...nodeFileOps,
            writeFile: async (p, d) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 15));
                await nodeFileOps.writeFile(p, d);
                active--;
            },
        };
        const store = makeStore({ fileOps, debounceMs: 1 });
        await store.load();
        for (let i = 1; i <= 5; i++) {
            store.update((d) => {
                d.counter = i;
            });
            await new Promise((r) => setTimeout(r, 3)); // let the timer fire while a write is running
        }
        await store.flush();
        expect(maxActive).toBe(1);
        expect(JSON.parse(readFileSync(file, 'utf8')).counter).toBe(5);
    });

    it('flush() with nothing pending resolves immediately', async () => {
        const store = makeStore();
        await store.load();
        await expect(store.flush()).resolves.toBeUndefined();
        expect(readdirSync(dir)).toEqual([]);
    });
});
