import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
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

export default defineConfig({
    main: {},
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
});
