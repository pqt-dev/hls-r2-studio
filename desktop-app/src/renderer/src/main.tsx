import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function start(): Promise<void> {
    const container = document.getElementById('root');

    if (!container) {
        throw new Error('Root element not found');
    }

    // Dev only: `?mock=1` serves a fake API so the UI works in a plain browser. The whole block is
    // dead code in production builds (import.meta.env.DEV is replaced by false), so the mock is
    // never bundled.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1') {
        const { installMockApi } = await import('./testing/mockApi');

        installMockApi();
    }

    if (typeof window.hlsApi === 'undefined') {
        container.textContent = 'This page must be opened inside the HLS R2 Studio desktop app.';

        return;
    }

    createRoot(container).render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

void start();
