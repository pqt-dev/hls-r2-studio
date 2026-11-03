import { useState, type DragEvent } from 'react';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { plural } from '../lib/format';
import type { AddFilesResult } from '../../../shared/ipc';

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

export function DropZone({ compact }: { compact: boolean }) {
    const { api } = useApp();
    const toast = useToast();
    const [dragging, setDragging] = useState(false);
    const [busy, setBusy] = useState(false);

    async function add(run: () => Promise<AddFilesResult>): Promise<void> {
        setBusy(true);

        try {
            const result = await run();
            const message = describeResult(result);

            if (message.added !== undefined) toast.show('success', message.added);

            if (message.skipped !== undefined) toast.show('error', message.skipped);
        } catch {
            toast.show('error', 'Could not add the files.');
        } finally {
            setBusy(false);
        }
    }

    function onDrop(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        setDragging(false);

        const files = Array.from(event.dataTransfer.files);

        if (files.length > 0) void add(() => api.jobs.addDroppedFiles(files));
    }

    return (
        <div
            className={`dropzone${dragging ? ' is-dragging' : ''}${compact ? ' is-compact' : ''}`}
            onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
            }}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDragging(false);
                }
            }}
            onDrop={onDrop}
            data-testid="dropzone"
        >
            <p className="dropzone-text">
                {dragging
                    ? 'Release to add the videos'
                    : 'Drop video files here, or click Add videos'}
            </p>
            <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void add(() => api.jobs.addFiles())}
            >
                Add videos
            </button>
            {!compact && <p className="muted small">MP4, MOV, MKV, AVI and WebM files.</p>}
        </div>
    );
}
