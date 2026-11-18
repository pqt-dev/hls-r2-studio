import { useState } from 'react';
import type { AddFilesResult } from '../../../shared/ipc';
import { plural } from '../lib/format';
import { useToast } from '../state/Toasts';

function describeResult(result: AddFilesResult): { added?: string; skipped?: string } {
    const out: { added?: string; skipped?: string } = {};

    if (result.added > 0) out.added = `Added ${plural(result.added, 'video')} to the queue.`;

    if (result.rejected.length > 0) {
        const shown = result.rejected
            .slice(0, 3)
            .map((file) => `${file.name} (${file.reason})`)
            .join('; ');
        const more = result.rejected.length > 3 ? `; and ${result.rejected.length - 3} more` : '';

        out.skipped = `Skipped ${plural(result.rejected.length, 'file')}: ${shown}${more}`;
    }

    return out;
}

/**
 * Adds files through `run` with the Queue's toasts: "Added N videos to the queue." and a
 * "Skipped ..." error for rejected files. Resolves with the result, or null when it failed.
 */
export function useAddFiles(): {
    busy: boolean;
    add: (run: () => Promise<AddFilesResult>) => Promise<AddFilesResult | null>;
} {
    const toast = useToast();
    const [busy, setBusy] = useState(false);

    async function add(run: () => Promise<AddFilesResult>): Promise<AddFilesResult | null> {
        setBusy(true);

        try {
            const result = await run();
            const message = describeResult(result);

            if (message.added !== undefined) toast.show('success', message.added);

            if (message.skipped !== undefined) toast.show('error', message.skipped);

            return result;
        } catch {
            toast.show('error', 'Could not add the files.');

            return null;
        } finally {
            setBusy(false);
        }
    }

    return { busy, add };
}
