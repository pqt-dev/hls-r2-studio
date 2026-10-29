/**
 * Shared behavior for every "copy to clipboard" button.
 *
 * `copyButton.copy(text, button, { exclusive, onStatus })` copies the text
 * (Clipboard API first, hidden-textarea execCommand fallback) and shows
 * temporary feedback on the button: "Copied" for 1500 ms, or "Copy failed"
 * for 2000 ms, then the button returns to its idle label.
 *
 * Markup contract: the button contains a `[data-copy-label]` element. The idle
 * label is `data-copy-idle-label` or the label found on first use. Optional
 * `[data-copy-icon="copy"]` / `[data-copy-icon="check"]` icons are toggled.
 * Buttons marked `data-copy-btn` also swap the outline/primary color classes.
 *
 * `exclusive`: a scope element; on success every other `[data-copy-btn]`
 * inside it reverts to idle immediately, so only the button whose content is
 * in the clipboard shows "Copied".
 *
 * `copyButton.feedback(button, message, ok, duration, onStatus)` shows custom
 * feedback (e.g. "Nothing to copy"); `copyButton.reset(scope)` clears timers
 * and restores idle state for a button or all `[data-copy-btn]` in a scope.
 */

const COPIED_MS = 1500;
const FAILED_MS = 2000;
// Idle classes mirror the ui button component outline variant; copied classes use the primary token.
const IDLE_CLASSES = ['border-input', 'bg-background', 'text-foreground', 'hover:bg-accent', 'hover:text-accent-foreground'];
const COPIED_CLASSES = ['border-primary', 'bg-primary', 'text-primary-foreground', 'hover:bg-primary/90', 'hover:text-primary-foreground'];

const timers = new WeakMap();
const idleLabels = new WeakMap();

function copyViaTextarea(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    try {
        ta.select();
        return document.execCommand('copy') === true;
    } catch (e) {
        return false;
    } finally {
        ta.remove();
    }
}

async function writeText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // Fall through to the textarea fallback.
        }
    }
    return copyViaTextarea(text);
}

function parts(button) {
    return {
        label: button.querySelector('[data-copy-label]'),
        copyIcon: button.querySelector('[data-copy-icon="copy"]'),
        checkIcon: button.querySelector('[data-copy-icon="check"]'),
    };
}

function idleLabelOf(button, label) {
    if (button.dataset.copyIdleLabel) {
        return button.dataset.copyIdleLabel;
    }
    if (!idleLabels.has(button)) {
        idleLabels.set(button, (label && label.textContent.trim()) || 'Copy');
    }
    return idleLabels.get(button);
}

function applyState(button, message, ok, showColors) {
    const { label, copyIcon, checkIcon } = parts(button);
    if (label) label.textContent = message;
    if (copyIcon) copyIcon.classList.toggle('hidden', ok);
    if (checkIcon) checkIcon.classList.toggle('hidden', !ok);
    if (button.hasAttribute('data-copy-btn')) {
        button.classList.remove(...(showColors ? IDLE_CLASSES : COPIED_CLASSES));
        button.classList.add(...(showColors ? COPIED_CLASSES : IDLE_CLASSES));
    }
}

function resetButton(button, onStatus) {
    clearTimeout(timers.get(button));
    timers.delete(button);
    const { label } = parts(button);
    if (!label || !idleLabels.has(button) && !button.dataset.copyIdleLabel && !button.style.minWidth) {
        // Never showed feedback: nothing to restore, but make sure colors are idle.
        applyState(button, label ? label.textContent : '', false, false);
        return;
    }
    applyState(button, idleLabelOf(button, label), false, false);
    button.style.minWidth = '';
    if (onStatus) onStatus('');
}

function feedback(button, message, ok, duration, onStatus) {
    const { label } = parts(button);
    // Capture the idle label before it is overwritten.
    idleLabelOf(button, label);
    clearTimeout(timers.get(button));
    if (!button.style.minWidth) {
        button.style.minWidth = button.offsetWidth + 'px';
    }
    applyState(button, message, ok, ok);
    if (onStatus) onStatus(message);
    timers.set(button, setTimeout(function () {
        resetButton(button, onStatus);
    }, duration));
}

async function copy(text, button, options) {
    const opts = options || {};
    let ok = false;
    try {
        ok = await writeText(text);
    } catch (e) {
        ok = false;
    }
    if (ok && opts.exclusive) {
        opts.exclusive.querySelectorAll('[data-copy-btn]').forEach(function (other) {
            if (other !== button) resetButton(other);
        });
    }
    feedback(button, ok ? 'Copied' : 'Copy failed', ok, ok ? COPIED_MS : FAILED_MS, opts.onStatus);
    return ok;
}

function reset(target) {
    if (!target) return;
    if (target.matches && target.matches('[data-copy-btn], button')) {
        resetButton(target);
        return;
    }
    target.querySelectorAll('[data-copy-btn]').forEach(function (button) {
        resetButton(button);
    });
}

export default function initCopyButton() {
    window.copyButton = { copy: copy, feedback: feedback, reset: reset };
}
