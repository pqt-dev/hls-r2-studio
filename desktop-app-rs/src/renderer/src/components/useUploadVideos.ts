import { useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { useAddFiles } from './useAddFiles';

/**
 * "Upload videos": opens the native file picker, toasts the outcome (via `useAddFiles`) and opens
 * the Queue tab when something was added. Shared by the Home and Library buttons.
 */
export function useUploadVideos(): { busy: boolean; upload: () => Promise<void> } {
    const { api } = useApp();
    const { openTab } = useNavigation();
    const { busy, add } = useAddFiles();

    async function upload(): Promise<void> {
        const result = await add(() => api.jobs.addFiles());

        if (result !== null && result.added > 0) openTab('queue');
    }

    return { busy, upload };
}
