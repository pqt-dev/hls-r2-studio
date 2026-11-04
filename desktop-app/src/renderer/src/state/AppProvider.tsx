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
import type {
    AuthState,
    DiagnosticsDto,
    JobDto,
    QueueSummary,
    RendererApi,
    SettingsDto,
} from '../../../shared/ipc';
import { isFinished, isRunning } from '../lib/jobState';

export interface AppState {
    /** False until the first load finished (or failed). */
    ready: boolean;
    loadError: string | null;
    auth: AuthState;
    jobs: JobDto[];
    summary: QueueSummary;
    settings: SettingsDto | null;
    diagnostics: DiagnosticsDto | null;
}

export interface AppContextValue extends AppState {
    api: RendererApi;
    /** Replaces the cached settings after a successful `settings.set`. */
    applySettings: (settings: SettingsDto) => void;
    /** Loads everything again (used by the "Try again" button of the load error). */
    reload: () => void;
}

/** Local fallback until the first `queue:summary` event arrives. */
export function summarize(jobs: readonly JobDto[]): QueueSummary {
    const count = (predicate: (job: JobDto) => boolean): number => jobs.filter(predicate).length;

    return {
        running: count(isRunning),
        waiting: count((job) => job.state === 'waiting'),
        attention: count(
            (job) =>
                job.state === 'register_failed' ||
                job.state === 'needs_sign_in' ||
                job.state === 'upload_interrupted',
        ),
        done: count((job) => job.state === 'done'),
        failed: count((job) => job.state === 'failed' || job.state === 'interrupted'),
        total: jobs.length,
        blockedReason: null,
    };
}

export function finishedCount(jobs: readonly JobDto[]): number {
    return jobs.filter((job) => isFinished(job.state)).length;
}

const DIAGNOSTICS_POLL_MS = 1000;

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
    api = window.hlsApi,
    children,
}: {
    api?: RendererApi;
    children: ReactNode;
}) {
    const [ready, setReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
    const [jobs, setJobs] = useState<JobDto[]>([]);
    const [summary, setSummary] = useState<QueueSummary>(() => summarize([]));
    const [settings, setSettings] = useState<SettingsDto | null>(null);
    const [diagnostics, setDiagnostics] = useState<DiagnosticsDto | null>(null);
    const [loadToken, setLoadToken] = useState(0);

    // Pushed events win over the initial load, which may resolve later with older data.
    const pushed = useRef({ auth: false, jobs: false, summary: false });

    useEffect(() => {
        let alive = true;

        pushed.current = { auth: false, jobs: false, summary: false };

        const unsubscribe = [
            api.auth.onChanged((state) => {
                pushed.current.auth = true;
                setAuth(state);
            }),
            api.jobs.onUpdated((list) => {
                pushed.current.jobs = true;
                setJobs(list);

                if (!pushed.current.summary) setSummary(summarize(list));
            }),
            api.jobs.onSummary((value) => {
                pushed.current.summary = true;
                setSummary(value);
            }),
        ];

        setLoadError(null);
        setReady(false);

        Promise.all([
            api.auth.getState(),
            api.jobs.list(),
            api.settings.get(),
            api.app.getDiagnostics(),
        ])
            .then(([authState, list, settingsDto, diagnosticsDto]) => {
                if (!alive) return;

                if (!pushed.current.auth) setAuth(authState);

                if (!pushed.current.jobs) {
                    setJobs(list);

                    if (!pushed.current.summary) setSummary(summarize(list));
                }

                setSettings(settingsDto);
                setDiagnostics(diagnosticsDto);
                setReady(true);
            })
            .catch(() => {
                if (!alive) return;

                setLoadError('Could not load the app state.');
                setReady(true);
            });

        return () => {
            alive = false;

            for (const off of unsubscribe) off();
        };
    }, [api, loadToken]);

    // The ffmpeg self-check runs in the background at startup: poll until it has finished.
    const ffmpegChecked = diagnostics?.ffmpeg.checked ?? true;

    useEffect(() => {
        if (ffmpegChecked) return undefined;

        const timer = window.setInterval(() => {
            api.app
                .getDiagnostics()
                .then(setDiagnostics)
                .catch(() => undefined);
        }, DIAGNOSTICS_POLL_MS);

        return () => window.clearInterval(timer);
    }, [api, ffmpegChecked]);

    const applySettings = useCallback((next: SettingsDto) => setSettings(next), []);
    const reload = useCallback(() => setLoadToken((token) => token + 1), []);

    const value = useMemo<AppContextValue>(
        () => ({
            ready,
            loadError,
            auth,
            jobs,
            summary,
            settings,
            diagnostics,
            api,
            applySettings,
            reload,
        }),
        [ready, loadError, auth, jobs, summary, settings, diagnostics, api, applySettings, reload],
    );

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
    const value = useContext(AppContext);

    if (value === null) throw new Error('useApp must be used inside <AppProvider>');

    return value;
}
