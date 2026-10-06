/**
 * Off-canvas sidebar drawer for viewports below `md`.
 *
 * The sidebar, top bar and backdrop live outside <main>, so they survive soft
 * navigation (see soft-navigation.js). Listeners are bound once, on elements
 * that are never swapped out, so they must not be re-bound after a swap.
 */

const HIDDEN_CLASSES = ['max-md:-translate-x-full', 'max-md:invisible'];

export default function initSidebarDrawer() {
    const sidebar = document.getElementById('app-sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (!sidebar || !toggle || !backdrop) {
        return;
    }

    function isOpen() {
        return toggle.getAttribute('aria-expanded') === 'true';
    }

    function setOpen(open) {
        sidebar.classList.toggle(HIDDEN_CLASSES[0], !open);
        sidebar.classList.toggle(HIDDEN_CLASSES[1], !open);
        backdrop.classList.toggle('hidden', !open);
        document.body.classList.toggle('overflow-hidden', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    }

    toggle.addEventListener('click', function () {
        setOpen(!isOpen());
    });

    backdrop.addEventListener('click', function () {
        setOpen(false);
    });

    sidebar.addEventListener('click', function (event) {
        if (event.target.closest('a[href]')) {
            setOpen(false);
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen()) {
            setOpen(false);
            toggle.focus();
        }
    });

    window.addEventListener('popstate', function () {
        setOpen(false);
    });

    window.matchMedia('(min-width: 768px)').addEventListener('change', function (event) {
        if (event.matches) {
            setOpen(false);
        }
    });
}
