import { forwardRef } from 'react';
import { UploadIcon } from './icons';
import { UploadVideosButton } from './UploadVideosButton';

/**
 * The Queue's upload card: drop target look plus the Upload videos button (the keyboard path).
 * It is the ONLY drop target: the Queue's `useFileDrop` gets its `ref` and passes `dragging` here.
 * Compact (one line) when the queue has jobs; roomier and stacked when it is empty.
 */
export const DropZone = forwardRef<
    HTMLDivElement,
    {
        compact: boolean;
        dragging: boolean;
        /** A drop is being processed: the button is disabled. */
        busy: boolean;
    }
>(function DropZone({ compact, dragging, busy }, ref) {
    return (
        <div
            ref={ref}
            className={`dropzone${dragging ? ' is-dragging' : ''}${compact ? ' is-compact' : ''}`}
            role="group"
            aria-label="Upload videos"
            data-testid="dropzone"
        >
            <span className="dropzone-icon" aria-hidden="true">
                <UploadIcon />
            </span>
            <div className="dropzone-body">
                <p className="dropzone-text">
                    {dragging ? 'Release to upload the videos' : 'Drop videos here to upload'}
                </p>
                <p className="dropzone-hint">MP4, MOV, MKV, AVI or WebM · or click Upload</p>
            </div>
            <UploadVideosButton navigate={false} disabled={busy} />
        </div>
    );
});
