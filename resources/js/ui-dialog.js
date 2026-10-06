/**
 * Shared behavior for the `<x-ui.dialog>` overlays (`[data-dialog]`).
 *
 * Provides open/close with a fade + scale animation, Escape / overlay /
 * close-button dismissal, initial focus, focus restore to the trigger, a Tab
 * focus trap and body scroll lock.
 *
 * Dismissal (Escape, overlay click, `[data-dialog-close]`) fires a cancelable
 * `dialog:dismiss` event on the overlay. A page that has its own close logic
 * calls preventDefault() in a listener and closes via `uiDialog.close(el)`
 * itself; without a listener the dialog is simply closed.
 *
 * All listeners are delegated on `document` and bound once, so they keep
 * working after soft navigation swaps <main> (see soft-navigation.js).
 */

const ANIMATION_MS = 150;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs, topmost last.
const stack = [];
let lastTrigger = null;

function isVisible(element) {
    return element.getClientRects().length > 0;
}

function focusableIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(function (element) {
        return element.getAttribute('tabindex') !== '-1' && isVisible(element);
    });
}

function panelOf(overlay) {
    return overlay.querySelector('[data-dialog-panel]');
}

function syncScrollLock() {
    document.body.classList.toggle('overflow-hidden', stack.length > 0);
}

// Drop dialogs whose element was removed from the document (soft navigation).
function prune() {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (!stack[i].overlay.isConnected) {
            stack.splice(i, 1);
        }
    }
    syncScrollLock();
}

function finishHide(overlay) {
    clearTimeout(overlay._uiDialogTimer);
    overlay._uiDialogTimer = null;
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    delete overlay.dataset.state;
}

function open(overlay, options) {
    options = options || {};
    prune();

    if (!overlay || stack.some(function (entry) { return entry.overlay === overlay; })) {
        return;
    }

    clearTimeout(overlay._uiDialogTimer);

    const active = document.activeElement;
    const returnFocus = active && active !== document.body && active.isConnected
        ? active
        : (lastTrigger && lastTrigger.isConnected ? lastTrigger : null);

    stack.push({ overlay: overlay, returnFocus: returnFocus });
    syncScrollLock();

    overlay.dataset.state = 'closed';
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    // Force a reflow so the closed -> open change is animated.
    void overlay.offsetWidth;
    overlay.dataset.state = 'open';

    const panel = panelOf(overlay);
    let target = options.initialFocus || null;

    if (!target && overlay.dataset.initialFocus !== 'panel') {
        target = focusableIn(panel)[0] || null;
    }

    (target || panel).focus({ preventScroll: true });
}

function close(overlay) {
    const index = stack.findIndex(function (entry) { return entry.overlay === overlay; });

    if (index === -1) {
        return;
    }

    const entry = stack.splice(index, 1)[0];
    syncScrollLock();

    overlay.dataset.state = 'closed';
    clearTimeout(overlay._uiDialogTimer);
    overlay._uiDialogTimer = setTimeout(function () {
        finishHide(overlay);
    }, ANIMATION_MS);

    if (entry.returnFocus && entry.returnFocus.isConnected) {
        entry.returnFocus.focus({ preventScroll: true });
    }
}

function dismiss(overlay) {
    const event = new CustomEvent('dialog:dismiss', { cancelable: true });
    overlay.dispatchEvent(event);

    if (!event.defaultPrevented) {
        close(overlay);
    }
}

export default function initUiDialog() {
    window.uiDialog = { open: open, close: close };

    // Remember what was clicked, since Safari/Firefox on macOS do not focus
    // buttons on click and activeElement would be <body> when a dialog opens.
    document.addEventListener('click', function (event) {
        const trigger = event.target.closest('button, a[href], [role="button"]');

        if (trigger && !trigger.closest('[data-dialog]')) {
            lastTrigger = trigger;
        }
    }, true);

    let mouseDownOverlay = null;

    document.addEventListener('mousedown', function (event) {
        mouseDownOverlay = event.target.matches && event.target.matches('[data-dialog]') ? event.target : null;
    });

    document.addEventListener('click', function (event) {
        const overlay = event.target.matches && event.target.matches('[data-dialog]') ? event.target : null;

        if (overlay && overlay === mouseDownOverlay) {
            dismiss(overlay);
        } else if (event.target.closest('[data-dialog-close]')) {
            const owner = event.target.closest('[data-dialog]');

            if (owner) {
                dismiss(owner);
            }
        }

        mouseDownOverlay = null;
    });

    document.addEventListener('keydown', function (event) {
        prune();

        if (stack.length === 0) {
            return;
        }

        const top = stack[stack.length - 1].overlay;

        if (event.key === 'Escape') {
            event.preventDefault();
            dismiss(top);
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const panel = panelOf(top);
        const items = focusableIn(panel);

        if (items.length === 0) {
            event.preventDefault();
            panel.focus();
            return;
        }

        const first = items[0];
        const last = items[items.length - 1];
        const current = document.activeElement;

        if (!panel.contains(current) || current === panel) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && current === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus();
        }
    });

    // Soft navigation replaces <main> (and any dialog inside it).
    document.addEventListener('softnav:swap', prune);
}
