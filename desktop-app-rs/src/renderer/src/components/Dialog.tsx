import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    /** `alertdialog` for confirmations. */
    role?: 'dialog' | 'alertdialog';
    /** Element focused when the dialog opens; defaults to the first focusable element. */
    initialFocusRef?: RefObject<HTMLElement | null>;
    wide?: boolean;
}

/**
 * Accessible modal: focus is trapped inside, Escape closes it and focus returns to the element
 * that opened it.
 */
export function Dialog({
    title,
    onClose,
    children,
    footer,
    role = 'dialog',
    initialFocusRef,
    wide = false,
}: DialogProps) {
    const titleId = useId();
    const panel = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    onCloseRef.current = onClose;

    useEffect(() => {
        const opener =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const node = panel.current;

        if (node === null) return undefined;

        const focusables = (): HTMLElement[] =>
            Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));

        (initialFocusRef?.current ?? focusables()[0] ?? node).focus();

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onCloseRef.current();

                return;
            }

            if (event.key !== 'Tab') return;

            const items = focusables();
            const first = items[0];
            const last = items[items.length - 1];

            if (first === undefined || last === undefined) {
                event.preventDefault();
                node.focus();

                return;
            }

            const active = document.activeElement;

            if (event.shiftKey && (active === first || active === node)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            } else if (active instanceof Node && !node.contains(active)) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown, true);

        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            // Restore focus if the opener is still in the page.
            if (opener !== null && opener.isConnected) opener.focus();
        };
        // The initial focus target is read once, when the dialog opens.
    }, []);

    return createPortal(
        <div
            className="backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={panel}
                className={wide ? 'dialog dialog-wide' : 'dialog'}
                role={role}
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
            >
                <h2 id={titleId} className="dialog-title">
                    {title}
                </h2>
                <div className="dialog-body">{children}</div>
                {footer !== undefined && <div className="dialog-footer">{footer}</div>}
            </div>
        </div>,
        document.body,
    );
}

export interface ConfirmDialogProps {
    title: string;
    message: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Confirmation prompt; the safe (cancel) button has the initial focus. */
export function ConfirmDialog({
    title,
    message,
    confirmLabel,
    cancelLabel = 'Keep',
    danger = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);

    return (
        <Dialog
            title={title}
            role="alertdialog"
            onClose={onCancel}
            initialFocusRef={cancelRef}
            footer={
                <>
                    <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        className={danger ? 'btn btn-danger' : 'btn btn-primary'}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <p>{message}</p>
        </Dialog>
    );
}
