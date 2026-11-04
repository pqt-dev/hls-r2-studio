import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { normalizeSiteUrl } from './src/main/api/siteUrl';
import { buildCsp } from './src/shared/csp';

/** Injects the strict CSP meta tag into index.html for production builds only. */
function cspMetaPlugin(): Plugin {
    return {
        name: 'hls-csp-meta',
        apply: 'build',
        transformIndexHtml() {
            return [
                {
                    tag: 'meta',
                    attrs: {
                        'http-equiv': 'Content-Security-Policy',
                        content: buildCsp({ dev: false }),
                    },
                    injectTo: 'head-prepend',
                },
            ];
        },
    };
}

/**
 * The site this app talks to is fixed at build time from the HLS_SITE_URL env var (https only,
 * normalized to an origin). A production build fails without a valid value; dev and tests are
 * not affected (the main process then falls back to the runtime env var).
 */
function builtInSiteUrlDefine(command: 'build' | 'serve'): Record<string, string> {
    if (command !== 'build') return {};

    const raw = process.env['HLS_SITE_URL'];

    if (raw === undefined || raw.trim() === '') {
        throw new Error(
            'HLS_SITE_URL is not set. Set it to the https URL of your HLS site before building, ' +
                'for example: HLS_SITE_URL=https://admin.example.com npm run build',
        );
    }

    try {
        return { __HLS_SITE_URL__: JSON.stringify(normalizeSiteUrl(raw, false)) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'It is not valid.';

        throw new Error(`HLS_SITE_URL is not valid: ${reason}`, { cause: error });
    }
}

export default defineConfig(({ command }) => ({
    // Only the main process needs the site URL; the renderer reads it through the settings IPC.
    main: { define: builtInSiteUrlDefine(command) },
    preload: {},
    renderer: {
        root: resolve(__dirname, 'src/renderer'),
        plugins: [react(), cspMetaPlugin()],
        build: {
            rollupOptions: {
                input: resolve(__dirname, 'src/renderer/index.html'),
            },
        },
    },
}));
