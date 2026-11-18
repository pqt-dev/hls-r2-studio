import { useState, type DragEvent } from 'react';
import { useApp } from '../state/AppProvider';
import { useAddFiles } from './useAddFiles';

export function DropZone({ compact }: { compact: boolean }) {
    const { api } = useApp();
    const [dragging, setDragging] = useState(false);
    const { busy, add } = useAddFiles();

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
                    ? 'Release to upload the videos'
                    : 'Drop videos here to upload, or click Upload videos'}
            </p>
            <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void add(() => api.jobs.addFiles())}
            >
                Upload videos
            </button>
            {!compact && <p className="muted small">MP4, MOV, MKV, AVI and WebM files.</p>}
        </div>
    );
}
