import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppStore, isValidAppData, STORE_FILE_NAME } from './appStore';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hls-appstore-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('createAppStore', () => {
    it('starts with default settings and persists changes', async () => {
        const store = createAppStore({ dir, defaultTmpRoot: '/tmp/hls', debounceMs: 1 });
        const data = await store.load();
        expect(data).toMatchObject({
            schemaVersion: 1,
            settings: { siteUrl: '', tmpRoot: '/tmp/hls', maxConcurrent: 1 },
            jobs: [],
        });

        store.update((d) => {
            d.settings.siteUrl = 'https://example.com';
        });
        await store.flush();

        const reopened = createAppStore({ dir, defaultTmpRoot: '/tmp/other' });
        expect((await reopened.load()).settings.siteUrl).toBe('https://example.com');
        expect(JSON.parse(readFileSync(join(dir, STORE_FILE_NAME), 'utf8')).schemaVersion).toBe(1);
    });
});

const SETTINGS = { siteUrl: '', tmpRoot: '/tmp/x', maxConcurrent: 1 };
const JOB = {
    id: 'j1',
    sourcePath: '/v/a.mp4',
    sizeBytes: 10,
    state: 'done',
    publicId: null,
    prefix: null,
    errorMessage: null,
    errorDetail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    registered: null,
};

describe('isValidAppData', () => {
    it('accepts valid data, optional fields and old job records without siteOrigin', () => {
        expect(isValidAppData({ schemaVersion: 1, settings: SETTINGS, jobs: [] })).toBe(true);
        expect(
            isValidAppData({
                schemaVersion: 1,
                settings: { ...SETTINGS, username: 'a' },
                jobs: [JOB, { ...JOB, siteOrigin: 'https://a.test', registerPayload: null }],
            }),
        ).toBe(true);
    });

    it('accepts upload_interrupted jobs with the new optional fields', () => {
        const paused = {
            ...JOB,
            state: 'upload_interrupted',
            tmpDir: '/tmp/hls/aaaaaaaaaaaa',
            registerStarted: false,
            mode: 'resume',
            registerPayload: { public_id: 'aaaaaaaaaaaa' },
        };

        expect(isValidAppData({ schemaVersion: 1, settings: SETTINGS, jobs: [paused] })).toBe(true);
    });

    it.each([
        ['non-object', 5],
        ['missing jobs', { schemaVersion: 1, settings: SETTINGS }],
        ['missing settings', { schemaVersion: 1, jobs: [] }],
        ['jobs not an array', { schemaVersion: 1, settings: SETTINGS, jobs: {} }],
        ['bad schemaVersion', { schemaVersion: '1', settings: SETTINGS, jobs: [] }],
        [
            'bad settings type',
            { schemaVersion: 1, settings: { ...SETTINGS, maxConcurrent: '1' }, jobs: [] },
        ],
        ['bad tmpDir', { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, tmpDir: 5 }] }],
        [
            'bad registerStarted',
            { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, registerStarted: 'yes' }] },
        ],
        ['bad mode', { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, mode: 'other' }] }],
        ['bad job state', { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, state: 'x' }] }],
        [
            'job missing id',
            { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, id: undefined }] },
        ],
        ['job is null', { schemaVersion: 1, settings: SETTINGS, jobs: [null] }],
        [
            'bad siteOrigin',
            { schemaVersion: 1, settings: SETTINGS, jobs: [{ ...JOB, siteOrigin: 5 }] },
        ],
    ])('rejects %s', (_name, data) => {
        expect(isValidAppData(data)).toBe(false);
    });
});

describe('createAppStore with a malformed file', () => {
    it('backs up a file without jobs/settings and starts with defaults', async () => {
        const text = JSON.stringify({ schemaVersion: 1 });
        writeFileSync(join(dir, STORE_FILE_NAME), text);
        const store = createAppStore({ dir, defaultTmpRoot: '/tmp/hls' });
        const data = await store.load();

        expect(data.jobs).toEqual([]);
        expect(data.settings.tmpRoot).toBe('/tmp/hls');
        expect(readFileSync(join(dir, `${STORE_FILE_NAME}.bak`), 'utf8')).toBe(text);
    });
});
