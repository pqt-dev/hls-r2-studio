import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
    id: number;
    kind: ToastKind;
    message: string;
}

export interface ToastApi {
    show: (kind: ToastKind, message: string) => void;
}

const DURATION_MS: Record<ToastKind, number> = { success: 3500, info: 5000, error: 8000 };
const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const nextId = useRef(1);
    const timers = useRef(new Map<number, number>());

    const dismiss = useCallback((id: number) => {
        const timer = timers.current.get(id);

        if (timer !== undefined) window.clearTimeout(timer);

        timers.current.delete(id);
        setToasts((list) => list.filter((toast) => toast.id !== id));
    }, []);

    const show = useCallback(
        (kind: ToastKind, message: string) => {
            const id = nextId.current++;

            setToasts((list) => [...list, { id, kind, message }].slice(-MAX_TOASTS));
            timers.current.set(
                id,
                window.setTimeout(() => dismiss(id), DURATION_MS[kind]),
            );
        },
        [dismiss],
    );

    useEffect(() => {
        const pending = timers.current;

        return () => {
            for (const timer of pending.values()) window.clearTimeout(timer);

            pending.clear();
        };
    }, []);

    const api = useMemo<ToastApi>(() => ({ show }), [show]);

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div className="toasts" role="status" aria-live="polite" aria-relevant="additions">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`toast toast-${toast.kind}`}>
                        <span className="toast-icon" aria-hidden="true">
                            {toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : 'i'}
                        </span>
                        <span className="toast-text">
                            {toast.kind === 'error' ? 'Error: ' : ''}
                            {toast.message}
                        </span>
                        <button
                            type="button"
                            className="toast-close"
                            aria-label="Dismiss notification"
                            onClick={() => dismiss(toast.id)}
                        >
                            {'×'}
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastApi {
    const value = useContext(ToastContext);

    if (value === null) throw new Error('useToast must be used inside <ToastProvider>');

    return value;
}
