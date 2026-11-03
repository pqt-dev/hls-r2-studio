/** Persisted user settings (spec 4.3): site URL, temp folder, parallel jobs. */
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
    auth: {
        changeSiteUrl(
            url: string,
        ): Promise<{ ok: true; siteUrl: string } | { ok: false; error: string }>;
    };
    hasActiveJobs: () => boolean;
    /** True while jobs wait for register (`register_failed` / `needs_sign_in`) on the current site. */
    hasAttentionJobs?: () => boolean;
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
        const { siteUrl, tmpRoot, maxConcurrent } = store.get().settings;

        return { siteUrl, tmpRoot, maxConcurrent };
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

            if (patch.siteUrl !== undefined && busy) {
                const same = patch.siteUrl.trim().replace(/\/+$/, '') === current.siteUrl;

                if (!same) {
                    return {
                        ok: false,
                        error: 'Wait for the running jobs to finish before changing the site URL.',
                    };
                }
            }

            if (patch.siteUrl !== undefined && options.hasAttentionJobs?.()) {
                const same = patch.siteUrl.trim().replace(/\/+$/, '') === current.siteUrl;

                if (!same) {
                    return {
                        ok: false,
                        error: 'Some videos are uploaded but not registered yet. Finish or cancel them before changing the site URL.',
                    };
                }
            }

            // Everything is valid: apply. The site URL goes last because it can sign out.
            if (tmpRoot !== undefined || patch.maxConcurrent !== undefined) {
                store.update((draft) => {
                    if (tmpRoot !== undefined) draft.settings.tmpRoot = tmpRoot;
                    if (patch.maxConcurrent !== undefined) {
                        draft.settings.maxConcurrent = patch.maxConcurrent;
                    }
                });
            }

            if (patch.siteUrl !== undefined) {
                const result = await options.auth.changeSiteUrl(patch.siteUrl);

                if (!result.ok) {
                    options.onChanged();

                    return { ok: false, error: result.error };
                }
            }

            options.onChanged();

            return { ok: true, settings: get() };
        },
    };
}
