/** Persisted user settings (spec 4.3): temp folder, parallel jobs. The site URL is read-only. */
import { isAbsolute, normalize } from 'node:path';
import type { SettingsDto, SettingsPatch, SettingsResult } from '../../shared/ipc';
import type { AppStore } from '../store';

export const MIN_CONCURRENT = 1;
export const MAX_CONCURRENT = 2;

export type TmpRootProblem = 'empty' | 'not_absolute' | 'unc' | 'device';

/**
 * Classifies a temp folder string (pure; the same on every platform). UNC (`\\server\share`,
 * `//server/share`) and device paths (`\\.\`, `\\?\`, including `\\?\UNC\`) are rejected
 * everywhere: temp files must live on a local drive. `isAbsolutePath` is injectable for tests.
 */
export function classifyTmpRoot(
    raw: string,
    isAbsolutePath: (path: string) => boolean = isAbsolute,
): TmpRootProblem | null {
    const text = raw.trim();

    if (text === '') return 'empty';
    if (/^[\\/]{2}[.?][\\/]/.test(text)) return 'device';
    if (/^[\\/]{2}/.test(text)) return 'unc';
    if (!isAbsolutePath(text)) return 'not_absolute';

    return null;
}

const TMP_ROOT_ERRORS: Record<TmpRootProblem, string> = {
    empty: 'The temporary folder must be an absolute path.',
    not_absolute: 'The temporary folder must be an absolute path.',
    unc: 'The temporary folder cannot be a network (UNC) path. Choose a folder on a local drive.',
    device: 'The temporary folder cannot be a device path. Choose a folder on a local drive.',
};

export interface SettingsServiceOptions {
    store: AppStore;
    /** The built-in site origin (fixed at build time), '' when this build has none. */
    getSiteUrl: () => string;
    hasActiveJobs: () => boolean;
    /** True while an upload is paused (`upload_interrupted`): its temp files are needed to resume. */
    hasPausedUploads?: () => boolean;
    /** Override of `path.isAbsolute` (tests). */
    isAbsolutePath?: (path: string) => boolean;
    /** Creates the directory when needed and verifies it is a writable directory. Throws if not. */
    ensureDir: (path: string) => Promise<void>;
    /** Called after any change so the queue can re-evaluate. */
    onChanged: () => void;
}

export interface SettingsService {
    get(): SettingsDto;
    set(patch: SettingsPatch): Promise<SettingsResult>;
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
    const { store } = options;

    function get(): SettingsDto {
        const { tmpRoot, maxConcurrent } = store.get().settings;

        return { siteUrl: options.getSiteUrl(), tmpRoot, maxConcurrent };
    }

    return {
        get,

        async set(patch) {
            const current = get();
            const busy = options.hasActiveJobs();

            let tmpRoot: string | undefined;

            if (patch.maxConcurrent !== undefined) {
                const value = patch.maxConcurrent;

                if (!Number.isInteger(value) || value < MIN_CONCURRENT || value > MAX_CONCURRENT) {
                    return {
                        ok: false,
                        error: `Parallel jobs must be between ${MIN_CONCURRENT} and ${MAX_CONCURRENT}.`,
                    };
                }
            }

            if (patch.tmpRoot !== undefined) {
                const candidate = patch.tmpRoot.trim();

                const problem = classifyTmpRoot(candidate, options.isAbsolutePath);

                if (problem !== null) return { ok: false, error: TMP_ROOT_ERRORS[problem] };

                tmpRoot = normalize(candidate);

                if (tmpRoot !== normalize(current.tmpRoot)) {
                    if (busy) {
                        return {
                            ok: false,
                            error: 'Wait for the running jobs to finish before changing the temporary folder.',
                        };
                    }

                    if (options.hasPausedUploads?.()) {
                        return {
                            ok: false,
                            error: 'Some uploads are paused and their temporary files are needed to resume them. Resume or remove them before changing the temporary folder.',
                        };
                    }

                    try {
                        await options.ensureDir(tmpRoot);
                    } catch {
                        return {
                            ok: false,
                            error: 'The temporary folder cannot be created or is not writable.',
                        };
                    }
                }
            }

            // Everything is valid: apply.
            if (tmpRoot !== undefined || patch.maxConcurrent !== undefined) {
                store.update((draft) => {
                    if (tmpRoot !== undefined) draft.settings.tmpRoot = tmpRoot;
                    if (patch.maxConcurrent !== undefined) {
                        draft.settings.maxConcurrent = patch.maxConcurrent;
                    }
                });
            }

            options.onChanged();

            return { ok: true, settings: get() };
        },
    };
}
