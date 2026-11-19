import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, GridViewIcon, ImageIcon } from './icons';

/**
 * Click-to-zoom lightbox: the same image, enlarged in a square frame (`object-fit: contain`, so it
 * is never cropped or stretched). Focus moves to the Close button and is trapped inside; Escape,
 * the Close button and a click on the backdrop close it; focus returns to the opener.
 */
export function ImageZoom({
    label,
    kind,
    url,
    onClose,
}: {
    label: string;
    /** Picks the small leading icon, the same as the tile bar. */
    kind: 'thumbnail' | 'custom' | 'storyboard';
    url: string;
    onClose: () => void;
}) {
    const panel = useRef<HTMLDivElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);

    onCloseRef.current = onClose;

    useEffect(() => {
        const opener =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const node = panel.current;
        const previousOverflow = document.body.style.overflow;

        // The overlay covers the page; also stop the page behind from scrolling.
        document.body.style.overflow = 'hidden';
        closeButton.current?.focus();

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                // Only the zoom closes: other Escape handlers must not react.
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();

                return;
            }

            // The Close button is the only focusable element: Tab stays on it.
            if (event.key === 'Tab' && node !== null) {
                event.preventDefault();
                closeButton.current?.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown, true);

        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.body.style.overflow = previousOverflow;
            if (opener !== null && opener.isConnected) opener.focus();
        };
    }, []);

    return createPortal(
        <div
            className="backdrop image-zoom-backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={panel}
                className="image-zoom"
                role="dialog"
                aria-modal="true"
                aria-label={`${label} preview`}
                tabIndex={-1}
            >
                <div className="image-zoom-bar">
                    <span className="image-zoom-icon" aria-hidden="true">
                        {kind === 'storyboard' ? <GridViewIcon /> : <ImageIcon />}
                    </span>
                    <h2 className="image-zoom-title" aria-hidden="true">
                        {label}
                        <span className="image-zoom-title-sub">{' preview'}</span>
                    </h2>
                    <button
                        ref={closeButton}
                        type="button"
                        className="btn btn-accent-danger image-zoom-close"
                        aria-label="Close"
                        title="Close"
                        onClick={onClose}
                    >
                        <CloseIcon />
                    </button>
                </div>
                <div className="image-zoom-frame">
                    <img src={url} alt={label} loading="eager" decoding="async" />
                </div>
            </div>
        </div>,
        document.body,
    );
}
