import { normalize } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../testing/memoryStore';
import { classifyTmpRoot, createSettingsService } from './settingsService';

function setup(
    opts: {
        busy?: boolean;
        paused?: boolean;
        ensureDir?: (p: string) => Promise<void>;
    } = {},
) {
    const store = createMemoryStore('/tmp/hls');
    const ensureDir = vi.fn(opts.ensureDir ?? (() => Promise.resolve()));
    const onChanged = vi.fn();
    const service = createSettingsService({
        store,
        getSiteUrl: () => 'https://built-in.example.com',
        hasActiveJobs: () => opts.busy ?? false,
        hasPausedUploads: () => opts.paused ?? false,
        ensureDir,
        onChanged,
    });

    return { service, store, ensureDir, onChanged };
}

describe('settingsService with paused uploads', () => {
    it('refuses a different temp folder', async () => {
        const t = setup({ paused: true });
        const tmp = await t.service.set({ tmpRoot: '/data/other' });

        expect(tmp).toMatchObject({ ok: false, error: expect.stringContaining('paused') });
        expect(tmp).toMatchObject({ error: expect.stringContaining('temporary folder') });
        expect(t.ensureDir).not.toHaveBeenCalled();
        expect(t.service.get().tmpRoot).toBe('/tmp/hls');
    });

    it('still allows unchanged values and unrelated settings', async () => {
        const t = setup({ paused: true });
        const result = await t.service.set({ tmpRoot: '/tmp/hls', maxConcurrent: 2 });

        expect(result).toMatchObject({ ok: true, settings: { maxConcurrent: 2 } });
    });
});

describe('settingsService', () => {
    it('returns the built-in site URL (read-only) with the stored settings', () => {
        expect(setup().service.get()).toEqual({
            siteUrl: 'https://built-in.example.com',
            tmpRoot: '/tmp/hls',
            maxConcurrent: 1,
        });
    });

    it('never takes the site URL from the stored settings or from a patch', async () => {
        const t = setup();
        t.store.update((d) => {
            d.settings.siteUrl = 'https://old.example.com';
        });
        const patch = { siteUrl: 'https://evil.example.com', maxConcurrent: 2 };
        const result = await t.service.set(patch);

        expect(result).toMatchObject({
            ok: true,
            settings: { siteUrl: 'https://built-in.example.com' },
        });
        expect(t.store.get().settings.siteUrl).toBe('https://old.example.com');
    });

    it('applies valid changes', async () => {
        const t = setup();
        const result = await t.service.set({ tmpRoot: '/data/tmp', maxConcurrent: 2 });

        expect(result).toMatchObject({
            ok: true,
            settings: { tmpRoot: normalize('/data/tmp'), maxConcurrent: 2 },
        });
        expect(t.ensureDir).toHaveBeenCalledWith(normalize('/data/tmp'));
        expect(t.onChanged).toHaveBeenCalled();
    });

    it('rejects out-of-range parallel jobs without changing anything', async () => {
        const t = setup();

        for (const value of [0, 3, 1.5]) {
            expect((await t.service.set({ maxConcurrent: value })).ok).toBe(false);
        }
        expect(t.store.get().settings.maxConcurrent).toBe(1);
    });

    it('rejects relative or empty temp folders and unwritable ones', async () => {
        const t = setup();
        expect((await t.service.set({ tmpRoot: 'relative/dir' })).ok).toBe(false);
        expect((await t.service.set({ tmpRoot: '  ' })).ok).toBe(false);

        const bad = setup({ ensureDir: () => Promise.reject(new Error('EACCES')) });
        expect(await bad.service.set({ tmpRoot: '/root/nope' })).toMatchObject({
            ok: false,
            error: 'The temporary folder cannot be created or is not writable.',
        });
        expect(bad.store.get().settings.tmpRoot).toBe('/tmp/hls');
    });

    it('refuses to move the temp folder while jobs are running', async () => {
        const t = setup({ busy: true });

        expect((await t.service.set({ tmpRoot: '/other' })).ok).toBe(false);
        // Unchanged values and the parallel job count remain allowed.
        expect((await t.service.set({ tmpRoot: '/tmp/hls' })).ok).toBe(true);
        expect((await t.service.set({ maxConcurrent: 2 })).ok).toBe(true);
    });
});

describe('classifyTmpRoot', () => {
    it.each([
        ['C:\\Temp\\hls', 'win'],
        ['D:/data/tmp', 'win'],
        ['/var/tmp/hls', 'posix'],
    ])('accepts the local absolute path %s', (path, kind) => {
        const abs =
            kind === 'win'
                ? (p: string) => /^[A-Za-z]:[\\/]/.test(p)
                : (p: string) => p.startsWith('/');

        expect(classifyTmpRoot(path, abs)).toBeNull();
    });

    it.each([
        '\\\\server\\share\\tmp',
        '//server/share/tmp',
        '\\/server/share',
        '/\\server\\share',
    ])('rejects the UNC path %s on every platform', (path) => {
        expect(classifyTmpRoot(path, () => true)).toBe('unc');
    });

    it.each([
        '\\\\?\\UNC\\server\\share',
        '\\\\?\\C:\\tmp',
        '\\\\.\\PhysicalDrive0',
        '//./pipe/x',
        '//?/C:/tmp',
    ])('rejects the device path %s', (path) => {
        expect(classifyTmpRoot(path, () => true)).toBe('device');
    });

    it('reports empty and relative values', () => {
        expect(classifyTmpRoot('  ', () => true)).toBe('empty');
        expect(classifyTmpRoot('relative/dir', () => false)).toBe('not_absolute');
    });

    it('is enforced by settings.set with a clear message', async () => {
        const t = setup();

        for (const path of ['\\\\srv\\share', '\\\\?\\C:\\x']) {
            const result = await t.service.set({ tmpRoot: path });

            expect(result.ok).toBe(false);
            expect(result.ok ? '' : result.error).toMatch(/cannot be a/);
        }

        expect(t.ensureDir).not.toHaveBeenCalled();
        expect(t.store.get().settings.tmpRoot).toBe('/tmp/hls');
    });
});
