/**
 * Soft navigation for the sidebar links.
 *
 * Clicking a sidebar link normally unloads the document, which aborts any
 * in-flight chunked upload running on the upload page. Instead of a real
 * browser navigation we fetch the destination page, swap the <main> content
 * and re-run the page scripts, so the document (and every running upload)
 * stays alive.
 *
 * Page script convention: a page that registers an interval or a
 * document/window level listener must expose a cleanup callback as
 * `window.__pageCleanup`. It is called and cleared right before the old
 * <main> content is swapped out, on every navigation (including back/forward).
 */

const ACTIVE_CLASSES = ['bg-primary', 'text-primary-foreground', 'shadow-sm', '[&>span:first-child]:bg-transparent', '[&_svg]:text-primary-foreground'];
const INACTIVE_CLASSES = ['text-muted-foreground', 'hover:bg-accent', 'hover:text-foreground'];

let navigationToken = 0;

function hardNavigate(url) {
    window.location.href = url;
}

function runPageCleanup() {
    const cleanup = window.__pageCleanup;
    window.__pageCleanup = null;

    if (typeof cleanup === 'function') {
        try {
            cleanup();
        } catch (error) {
            console.error('Page cleanup failed.', error);
        }
    }
}

function removeInlinePageScripts() {
    // Only inline scripts are removed. External ones are kept so that the
    // "already loaded" check below can skip re-downloading them.
    document.body.querySelectorAll('script:not([src])').forEach(function (script) {
        script.remove();
    });
}

function isExternalScriptLoaded(src) {
    return Array.from(document.querySelectorAll('script[src]')).some(function (script) {
        return script.src === src;
    });
}

function injectScript(template) {
    const src = template.getAttribute('src');

    if (src && isExternalScriptLoaded(new URL(src, document.baseURI).href)) {
        return;
    }

    const script = document.createElement('script');

    Array.from(template.attributes).forEach(function (attribute) {
        script.setAttribute(attribute.name, attribute.value);
    });

    if (src) {
        // Keep the execution order of external scripts stable.
        script.async = false;
    } else {
        script.textContent = template.textContent;
    }

    document.body.appendChild(script);
}

function updateActiveNavLinks(nav) {
    nav.querySelectorAll('a[href]').forEach(function (link) {
        const isActive = new URL(link.href, document.baseURI).pathname === window.location.pathname;

        link.classList.remove.apply(link.classList, isActive ? INACTIVE_CLASSES : ACTIVE_CLASSES);
        link.classList.add.apply(link.classList, isActive ? ACTIVE_CLASSES : INACTIVE_CLASSES);
    });
}

async function swap(url, options) {
    navigationToken++;
    const token = navigationToken;

    await performSwap(url, options, token);
}

async function performSwap(url, { push, nav }, token) {
    let response;

    try {
        response = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    } catch (error) {
        hardNavigate(url);
        return;
    }

    if (response.redirected) {
        hardNavigate(url);
        return;
    }

    if (!response.ok) {
        hardNavigate(url);
        return;
    }

    const html = await response.text();

    if (token !== navigationToken) {
        // A newer navigation started while this one was still loading.
        return;
    }

    const incoming = new DOMParser().parseFromString(html, 'text/html');
    const incomingMain = incoming.querySelector('main');
    const currentMain = document.querySelector('main');

    if (!incomingMain || !currentMain) {
        hardNavigate(url);
        return;
    }

    // Page scripts are pushed to the bottom of <body>, outside <main>. Detach
    // them from the parsed document so they are injected exactly once, as live
    // elements, after the content swap.
    const scripts = Array.from(incoming.body.querySelectorAll('script'));
    scripts.forEach(function (script) {
        script.remove();
    });

    runPageCleanup();
    removeInlinePageScripts();

    currentMain.innerHTML = incomingMain.innerHTML;
    document.dispatchEvent(new CustomEvent('softnav:swap'));

    const title = incoming.querySelector('title');
    if (title) {
        document.title = title.textContent;
    }

    if (push) {
        window.history.pushState({ softNavigation: true }, '', url);
    }

    updateActiveNavLinks(nav);

    if (push) {
        window.scrollTo(0, 0);
    }

    scripts.forEach(injectScript);
}

function isSoftNavTarget(link, nav) {
    if (link.hasAttribute('data-soft-nav')) {
        return true;
    }

    return nav.contains(link)
        || Boolean(link.closest('main'))
        || Boolean(link.closest('#in-progress-ring, [data-in-progress-ring]'));
}

function shouldIntercept(event, link) {
    if (event.defaultPrevented || event.button !== 0) {
        return false;
    }

    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return false;
    }

    if (link.hasAttribute('download') || link.hasAttribute('data-no-soft-nav')) {
        return false;
    }

    if (link.target && link.target !== '_self') {
        return false;
    }

    if (link.origin !== window.location.origin) {
        return false;
    }

    const href = (link.getAttribute('href') || '').trim();

    if (href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) {
        return false;
    }

    return true;
}

let initialized = false;

function withoutHash(url) {
    return url.split('#')[0];
}

export default function initSoftNavigation() {
    const nav = document.querySelector('aside nav');

    if (!nav || initialized) {
        return;
    }

    initialized = true;

    // Delegated on document so links outside the sidebar (the floating progress
    // ring, links inside <main>, pagination...) also avoid a full page load,
    // which would fire beforeunload and abort a running upload.
    document.addEventListener('click', function (event) {
        const link = event.target instanceof Element ? event.target.closest('a[href]') : null;

        if (!link || !isSoftNavTarget(link, nav) || !shouldIntercept(event, link)) {
            return;
        }

        event.preventDefault();

        // Same URL (including query/hash): nothing to load and no duplicate history entry.
        if (link.href === window.location.href) {
            return;
        }

        loadedUrl = withoutHash(link.href);
        swap(link.href, { push: true, nav: nav });
    });

    let loadedUrl = withoutHash(window.location.href);

    window.addEventListener('popstate', function () {
        // Fragment-only changes (#anchor) do not need a page swap.
        if (withoutHash(window.location.href) === loadedUrl) {
            return;
        }

        loadedUrl = withoutHash(window.location.href);
        swap(window.location.href, { push: false, nav: nav });
    });
}
