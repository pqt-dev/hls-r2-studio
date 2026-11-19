import { UploadIcon } from './icons';
import { useUploadVideos } from './useUploadVideos';

/**
 * The one "Upload videos" button (Home, Library, Queue): opens the native file picker, toasts the
 * outcome and, unless `navigate` is false (already on the Queue), opens the Queue when something
 * was added. `create` is the accented create action; `primary` is the solid primary (Home hero).
 */
export function UploadVideosButton({
    variant = 'create',
    navigate = true,
    disabled = false,
    className,
}: {
    variant?: 'create' | 'primary';
    navigate?: boolean;
    /** Extra reason to disable it (e.g. a drop is being processed). */
    disabled?: boolean;
    className?: string;
}) {
    const { busy, upload } = useUploadVideos({ navigate });

    return (
        <button
            type="button"
            className={`btn btn-control ${variant === 'primary' ? 'btn-primary' : 'btn-accent-create'} upload-videos${className === undefined ? '' : ` ${className}`}`}
            disabled={busy || disabled}
            onClick={() => void upload()}
        >
            <UploadIcon />
            Upload videos
        </button>
    );
}
