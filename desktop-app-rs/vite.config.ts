import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer lives in src/renderer (same layout as the Electron app). Tauri serves `dist/`.
// The Content-Security-Policy is NOT injected as a <meta> tag here: Tauri applies it from
// src-tauri/tauri.conf.json (app.security.csp) and adds its own nonces/hashes. A second, stricter
// meta policy would be intersected with it and block the Tauri IPC transport.
export default defineConfig({
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    clearScreen: false,
    server: { port: 5173, strictPort: true, host: 'localhost' },
    build: {
        outDir: resolve(__dirname, 'dist'),
        emptyOutDir: true,
        target: 'safari14',
    },
});
