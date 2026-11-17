import { useEffect } from 'react';
import type { RendererApi } from '../../shared/ipc';
import { LoginScreen } from './screens/LoginScreen';
import { MainScreen } from './screens/MainScreen';
import { AppProvider, useApp } from './state/AppProvider';
import { ToastProvider } from './state/Toasts';

/** A file dropped outside the drop zone must not make the window navigate to it. */
function usePreventStrayDrops(): void {
    useEffect(() => {
        const block = (event: DragEvent): void => event.preventDefault();

        window.addEventListener('dragover', block);
        window.addEventListener('drop', block);

        return () => {
            window.removeEventListener('dragover', block);
            window.removeEventListener('drop', block);
        };
    }, []);
}

function Shell() {
    const { ready, loadError, auth, reload } = useApp();

    usePreventStrayDrops();

    if (!ready) {
        return (
            <main className="splash" aria-busy="true">
                <p className="wordmark">HLS R2 Studio</p>
                <p className="muted">{'Loading…'}</p>
            </main>
        );
    }

    if (loadError !== null) {
        return (
            <main className="splash">
                <p className="wordmark">HLS R2 Studio</p>
                <p role="alert">{loadError}</p>
                <button type="button" className="btn btn-primary" onClick={reload}>
                    Try again
                </button>
            </main>
        );
    }

    if (auth.status === 'signed_out' || auth.status === 'signing_in') return <LoginScreen />;

    return <MainScreen />;
}

export function App({ api }: { api?: RendererApi }) {
    return (
        <ToastProvider>
            <AppProvider api={api}>
                <Shell />
            </AppProvider>
        </ToastProvider>
    );
}
