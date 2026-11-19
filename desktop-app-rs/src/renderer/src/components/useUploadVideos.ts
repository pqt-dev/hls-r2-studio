import { useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { useAddFiles } from './useAddFiles';

/**
 * "Upload videos": opens the native file picker, toasts the outcome (via `useAddFiles`) and opens
 * the Queue tab when something was added (unless `navigate` is false, e.g. already on the Queue).
 * Used by `UploadVideosButton`.
 */
export function useUploadVideos({ navigate = true }: { navigate?: boolean } = {}): {
    busy: boolean;
    upload: () => Promise<void>;
} {
    const { api } = useApp();
    const { openTab } = useNavigation();
    const { busy, add } = useAddFiles();

    async function upload(): Promise<void> {
        const result = await add(() => api.jobs.addFiles());

        if (navigate && result !== null && result.added > 0) openTab('queue');
    }

    return { busy, upload };
}
