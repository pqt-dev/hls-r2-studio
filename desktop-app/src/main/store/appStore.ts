import { join } from 'node:path';
import type { AppData, JobState } from '../../shared/types';
import { JsonStore } from './jsonStore';
import type { FileOps } from './jsonStore';

export const APP_SCHEMA_VERSION = 1;
export const STORE_FILE_NAME = 'store.json';

export interface AppStoreOptions {
    /** Directory of the store file (app.getPath('userData')). */
    dir: string;
    /** Default temporary root, e.g. join(os.tmpdir(), 'hls-r2-studio'). */
    defaultTmpRoot: string;
    debounceMs?: number;
    fileOps?: FileOps;
    onError?: (error: unknown) => void;
}

export function createDefaultAppData(defaultTmpRoot: string): AppData {
    return {
        schemaVersion: APP_SCHEMA_VERSION,
        settings: { siteUrl: '', tmpRoot: defaultTmpRoot, maxConcurrent: 1 },
        jobs: [],
    };
}

/**
 * Migration hook. Only schema version 1 exists today, so there is nothing to migrate yet;
 * future versions add `if (fromVersion < N)` steps here. Unknown shapes fall back to defaults.
 */
export function migrateAppData(
    _oldData: unknown,
    _fromVersion: number,
    defaultTmpRoot: string,
): AppData {
    return createDefaultAppData(defaultTmpRoot);
}

const JOB_STATES: readonly JobState[] = [
    'waiting',
    'transcoding',
    'thumbnail',
    'storyboard',
    'uploading',
    'registering',
    'done',
    'failed',
    'cancelled',
    'interrupted',
    'register_failed',
    'needs_sign_in',
    'upload_interrupted',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): boolean => value === null || isString(value);
const isNullableObject = (value: unknown): boolean => value === null || isRecord(value);

function isValidJob(job: unknown): boolean {
    if (!isRecord(job)) return false;

    return (
        isString(job['id']) &&
        isString(job['sourcePath']) &&
        typeof job['sizeBytes'] === 'number' &&
        isString(job['state']) &&
        (JOB_STATES as readonly string[]).includes(job['state']) &&
        isNullableString(job['publicId']) &&
        isNullableString(job['prefix']) &&
        isNullableString(job['errorMessage']) &&
        isNullableObject(job['errorDetail']) &&
        isString(job['createdAt']) &&
        isString(job['updatedAt']) &&
        isNullableString(job['startedAt']) &&
        isNullableString(job['finishedAt']) &&
        isNullableObject(job['registered']) &&
        (job['registerPayload'] === undefined || isNullableObject(job['registerPayload'])) &&
        (job['siteOrigin'] === undefined || isString(job['siteOrigin'])) &&
        (job['tmpDir'] === undefined || isString(job['tmpDir'])) &&
        (job['registerStarted'] === undefined || typeof job['registerStarted'] === 'boolean') &&
        (job['mode'] === undefined || job['mode'] === 'resume')
    );
}

/** Structural check of a parsed store file (current schema). Does not repair anything. */
export function isValidAppData(data: unknown): data is AppData {
    if (!isRecord(data) || typeof data['schemaVersion'] !== 'number') return false;

    const settings = data['settings'];

    if (
        !isRecord(settings) ||
        !isString(settings['siteUrl']) ||
        !isString(settings['tmpRoot']) ||
        typeof settings['maxConcurrent'] !== 'number' ||
        !(settings['username'] === undefined || isString(settings['username']))
    ) {
        return false;
    }

    const jobs = data['jobs'];

    return Array.isArray(jobs) && jobs.every(isValidJob);
}

export type AppStore = JsonStore<AppData>;

export function createAppStore(options: AppStoreOptions): AppStore {
    return new JsonStore<AppData>({
        filePath: join(options.dir, STORE_FILE_NAME),
        schemaVersion: APP_SCHEMA_VERSION,
        createDefaults: () => createDefaultAppData(options.defaultTmpRoot),
        migrate: (oldData, fromVersion) =>
            migrateAppData(oldData, fromVersion, options.defaultTmpRoot),
        validate: isValidAppData,
        debounceMs: options.debounceMs,
        fileOps: options.fileOps,
        onError: options.onError,
    });
}
