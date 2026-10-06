/**
 * Shared behavior for `<x-ui.dropdown-menu>` (`[data-dropdown]`).
 *
 * Toggle via `[data-dropdown-trigger]`, Escape and outside click close,
 * ArrowUp/ArrowDown/Home/End move between `[role="menuitem"]` items, one menu
 * open at a time. Closing fires a `dropdown:close` event on the wrapper so a
 * page can reset its own extra state.
 *
 * Listeners are delegated on `document` and bound once, so they keep working
 * after soft navigation swaps <main> (see soft-navigation.js).
 */

const ANIMATION_MS = 150;

function parts(wrapper) {
    return {
        trigger: wrapper.querySelector('[data-dropdown-trigger]'),
        panel: wrapper.querySelector('[data-dropdown-panel]'),
    };
}

function isOpen(wrapper) {
    const panel = parts(wrapper).panel;
    return !!panel && panel.dataset.state === 'open';
}

function items(wrapper) {
    return Array.from(parts(wrapper).panel.querySelectorAll('[role="menuitem"]')).filter(function (item) {
        return item.getClientRects().length > 0;
    });
}

function openMenu(wrapper, focusFirst) {
    document.querySelectorAll('[data-dropdown]').forEach(function (other) {
        if (other !== wrapper && isOpen(other)) {
            closeMenu(other, false);
        }
    });

    const { trigger, panel } = parts(wrapper);

    clearTimeout(panel._uiDropdownTimer);
    panel.dataset.state = 'closed';
    panel.classList.remove('hidden');
    void panel.offsetWidth;
    panel.dataset.state = 'open';
    trigger.setAttribute('aria-expanded', 'true');

    if (focusFirst) {
        const first = items(wrapper)[0];

        if (first) {
            first.focus();
        }
    }
}

function closeMenu(wrapper, restoreFocus) {
    const { trigger, panel } = parts(wrapper);

    if (!isOpen(wrapper)) {
        return;
    }

    panel.dataset.state = 'closed';
    trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(panel._uiDropdownTimer);
    panel._uiDropdownTimer = setTimeout(function () {
        panel.classList.add('hidden');
        delete panel.dataset.state;
    }, ANIMATION_MS);

    wrapper.dispatchEvent(new CustomEvent('dropdown:close'));

    if (restoreFocus) {
        trigger.focus();
    }
}

export default function initUiDropdown() {
    document.addEventListener('click', function (event) {
        const trigger = event.target.closest('[data-dropdown-trigger]');

        if (trigger) {
            const wrapper = trigger.closest('[data-dropdown]');

            if (wrapper) {
                if (isOpen(wrapper)) {
                    closeMenu(wrapper, false);
                } else {
                    // detail === 0 means the click came from the keyboard.
                    openMenu(wrapper, event.detail === 0);
                }
            }

            return;
        }

        document.querySelectorAll('[data-dropdown]').forEach(function (wrapper) {
            if (isOpen(wrapper) && !wrapper.contains(event.target)) {
                closeMenu(wrapper, false);
            }
        });
    });

    document.addEventListener('keydown', function (event) {
        const wrapper = event.target.closest ? event.target.closest('[data-dropdown]') : null;
        const open = Array.from(document.querySelectorAll('[data-dropdown]')).filter(isOpen);

        if (event.key === 'Escape' && open.length > 0) {
            // A dialog on top handles its own Escape; only close menus when none handled it.
            if (event.defaultPrevented) {
                return;
            }
            event.preventDefault();
            closeMenu(open[open.length - 1], true);
            return;
        }

        if (!wrapper) {
            return;
        }

        const { trigger } = parts(wrapper);
        const onTrigger = event.target === trigger;
        const onItem = event.target.matches('[role="menuitem"]');

        if (!onTrigger && !onItem) {
            return;
        }

        if (event.key === 'Tab') {
            closeMenu(wrapper, false);
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();

            if (!isOpen(wrapper)) {
                openMenu(wrapper, false);
            }

            const list = items(wrapper);

            if (list.length === 0) {
                return;
            }

            const index = list.indexOf(document.activeElement);
            let next;

            if (event.key === 'Home') {
                next = 0;
            } else if (event.key === 'End') {
                next = list.length - 1;
            } else if (event.key === 'ArrowDown') {
                next = index === -1 ? 0 : (index + 1) % list.length;
            } else {
                next = index === -1 ? list.length - 1 : (index - 1 + list.length) % list.length;
            }

            list[next].focus();
        }
    });
}
