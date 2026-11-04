import { normalize } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../testing/memoryStore';
import { classifyTmpRoot, createSettingsService } from './settingsService';

function setup(
    opts: {
        busy?: boolean;
        attention?: boolean;
        paused?: boolean;
        ensureDir?: (p: string) => Promise<void>;
    } = {},
) {
    const store = createMemoryStore('/tmp/hls');
    store.update((d) => {
        d.settings.siteUrl = 'https://old.example.com';
    });
    const changeSiteUrl = vi.fn((url: string) =>
        Promise.resolve(
            url.startsWith('https://')
                ? { ok: true as const, siteUrl: url }
                : { ok: false as const, error: 'The site URL must start with https://.' },
        ),
    );
    const ensureDir = vi.fn(opts.ensureDir ?? (() => Promise.resolve()));
    const onChanged = vi.fn();
    const service = createSettingsService({
        store,
        auth: { changeSiteUrl },
        hasActiveJobs: () => opts.busy ?? false,
        hasAttentionJobs: () => opts.attention ?? false,
        hasPausedUploads: () => opts.paused ?? false,
        ensureDir,
        onChanged,
    });

    return { service, store, changeSiteUrl, ensureDir, onChanged };
}

describe('settingsService with paused uploads', () => {
    it('refuses a different temp folder and a different site URL', async () => {
        const t = setup({ paused: true });
        const tmp = await t.service.set({ tmpRoot: '/data/other' });
        const site = await t.service.set({ siteUrl: 'https://new.example.com' });

        expect(tmp).toMatchObject({ ok: false, error: expect.stringContaining('paused') });
        expect(tmp).toMatchObject({ error: expect.stringContaining('temporary folder') });
        expect(site).toMatchObject({ ok: false, error: expect.stringContaining('site URL') });
        expect(t.ensureDir).not.toHaveBeenCalled();
        expect(t.changeSiteUrl).not.toHaveBeenCalled();
        expect(t.service.get().tmpRoot).toBe('/tmp/hls');
    });

    it('still allows unchanged values and unrelated settings', async () => {
        const t = setup({ paused: true });
        const result = await t.service.set({
            tmpRoot: '/tmp/hls',
            siteUrl: 'https://old.example.com/',
            maxConcurrent: 2,
        });

        expect(result).toMatchObject({ ok: true, settings: { maxConcurrent: 2 } });
    });
});

describe('settingsService', () => {
    it('returns the stored settings', () => {
        expect(setup().service.get()).toEqual({
            siteUrl: 'https://old.example.com',
            tmpRoot: '/tmp/hls',
            maxConcurrent: 1,
        });
    });

    it('applies valid changes', async () => {
        const t = setup();
        const result = await t.service.set({
            tmpRoot: '/data/tmp',
            maxConcurrent: 2,
            siteUrl: 'https://new.example.com',
        });

        expect(result).toMatchObject({
            ok: true,
            settings: { tmpRoot: normalize('/data/tmp'), maxConcurrent: 2 },
        });
        expect(t.ensureDir).toHaveBeenCalledWith(normalize('/data/tmp'));
        expect(t.changeSiteUrl).toHaveBeenCalledWith('https://new.example.com');
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

    it('is all-or-nothing when the site URL is rejected', async () => {
        const t = setup();
        const result = await t.service.set({ siteUrl: 'http://insecure.example.com' });

        expect(result).toEqual({ ok: false, error: 'The site URL must start with https://.' });
    });

    it('refuses to move the temp folder or switch site while jobs are running', async () => {
        const t = setup({ busy: true });

        expect((await t.service.set({ tmpRoot: '/other' })).ok).toBe(false);
        expect((await t.service.set({ siteUrl: 'https://new.example.com' })).ok).toBe(false);
        // Unchanged values and the parallel job count remain allowed.
        expect(
            (await t.service.set({ tmpRoot: '/tmp/hls', siteUrl: 'https://old.example.com/' })).ok,
        ).toBe(true);
        expect((await t.service.set({ maxConcurrent: 2 })).ok).toBe(true);
    });
});

describe('site URL change with unregistered jobs', () => {
    it('is refused while jobs wait for registration, with a clear message', async () => {
        const t = setup({ attention: true });
        const result = await t.service.set({ siteUrl: 'https://new.example.com' });

        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.error).toMatch(/Finish or cancel/);
        expect(t.changeSiteUrl).not.toHaveBeenCalled();
    });

    it('still accepts the unchanged URL and other settings', async () => {
        const t = setup({ attention: true });

        expect((await t.service.set({ siteUrl: 'https://old.example.com/' })).ok).toBe(true);
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
