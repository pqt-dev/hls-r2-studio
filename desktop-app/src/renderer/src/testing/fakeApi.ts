/**
 * A controllable in-memory `RendererApi`. Used by the unit tests and (through mockApi.ts) by the
 * dev-only `?mock=1` mode. It never touches Electron, the network or the filesystem.
 */
import type {
    ActionResult,
    AuthState,
    DiagnosticsDto,
    JobDto,
    PickDirectoryResult,
    QueueSummary,
    RendererApi,
    SettingsDto,
} from '../../../shared/ipc';

export function makeJob(partial: Partial<JobDto> = {}): JobDto {
    const state = partial.state ?? 'waiting';

    return {
        id: 'job-1',
        fileName: 'holiday-video.mp4',
        sizeBytes: 150 * 1024 * 1024,
        state,
        stageKey: `job.state.${state}`,
        progress: 0,
        waitingReason: null,
        errorMessage: null,
        errorDetail: null,
        publicId: null,
        embedUrl: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        canCancel: false,
        canRetry: false,
        canRetryRegister: false,
        canRemove: false,
        ...partial,
    };
}

export function makeSummary(partial: Partial<QueueSummary> = {}): QueueSummary {
    return {
        running: 0,
        waiting: 0,
        attention: 0,
        done: 0,
        failed: 0,
        total: 0,
        blockedReason: null,
        ...partial,
    };
}

export interface FakeState {
    auth: AuthState;
    jobs: JobDto[];
    settings: SettingsDto;
    diagnostics: DiagnosticsDto;
    /** What the native folder dialog returns next. */
    nextDirectory: string | null;
}

export interface FakeApi {
    api: RendererApi;
    state: FakeState;
    emitAuth(state: AuthState): void;
    emitJobs(jobs: JobDto[]): void;
    emitSummary(summary: QueueSummary): void;
    /** Number of live event subscriptions (to verify they are removed on unmount). */
    listenerCount(): number;
}

const OK: ActionResult = { ok: true };

export function createFakeApi(initial: Partial<FakeState> = {}): FakeApi {
    const state: FakeState = {
        auth: {
            status: 'signed_in',
            username: 'alice',
            siteUrl: 'https://site.example.com',
            r2Configured: true,
        },
        jobs: [],
        settings: {
            siteUrl: 'https://site.example.com',
            tmpRoot: 'C:\\Temp\\hls-r2-studio',
            maxConcurrent: 1,
        },
        diagnostics: {
            appVersion: '1.2.3',
            platform: 'win32 x64',
            ffmpeg: { checked: true, ok: true, version: '9.0.2', missing: [] },
        },
        nextDirectory: null,
        ...initial,
    };

    const authListeners = new Set<(state: AuthState) => void>();
    const jobListeners = new Set<(jobs: JobDto[]) => void>();
    const summaryListeners = new Set<(summary: QueueSummary) => void>();

    const emitAuth = (next: AuthState): void => {
        state.auth = next;
        for (const listener of [...authListeners]) listener(next);
    };
    const emitJobs = (jobs: JobDto[]): void => {
        state.jobs = jobs;
        for (const listener of [...jobListeners]) listener(jobs);
    };
    const emitSummary = (summary: QueueSummary): void => {
        for (const listener of [...summaryListeners]) listener(summary);
    };

    const subscribe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void) => {
        set.add(listener);

        return () => {
            set.delete(listener);
        };
    };

    const api: RendererApi = {
        app: {
            getVersion: () => Promise.resolve(state.diagnostics.appVersion),
            openLogsFolder: () => Promise.resolve(OK),
            openNotices: () => Promise.resolve(OK),
            getDiagnostics: () => Promise.resolve(state.diagnostics),
        },
        auth: {
            getState: () => Promise.resolve(state.auth),
            login: (siteUrl, username) => {
                const next: AuthState = {
                    status: 'signed_in',
                    username,
                    siteUrl,
                    r2Configured: true,
                };

                emitAuth(next);

                return Promise.resolve(next);
            },
            logout: () => {
                const next: AuthState = { status: 'signed_out' };

                emitAuth(next);

                return Promise.resolve(next);
            },
            reloadConfig: () => Promise.resolve(state.auth),
            onChanged: (listener) => subscribe(authListeners, listener),
        },
        settings: {
            get: () => Promise.resolve(state.settings),
            set: (patch) => {
                state.settings = { ...state.settings, ...patch };

                return Promise.resolve({ ok: true, settings: state.settings });
            },
            pickDirectory: (): Promise<PickDirectoryResult> =>
                Promise.resolve(
                    state.nextDirectory === null
                        ? { canceled: true }
                        : { canceled: false, path: state.nextDirectory },
                ),
        },
        jobs: {
            list: () => Promise.resolve(state.jobs),
            addFiles: () => Promise.resolve({ added: 0, rejected: [], canceled: true }),
            addDroppedFiles: (files) =>
                Promise.resolve({ added: files.length, rejected: [], canceled: false }),
            cancel: () => Promise.resolve(OK),
            retry: () => Promise.resolve(OK),
            retryRegister: () => Promise.resolve(OK),
            remove: () => Promise.resolve(OK),
            clearFinished: () => Promise.resolve(OK),
            openEmbed: () => Promise.resolve(OK),
            copy: () => Promise.resolve(OK),
            onUpdated: (listener) => subscribe(jobListeners, listener),
            onSummary: (listener) => subscribe(summaryListeners, listener),
        },
    };

    return {
        api,
        state,
        emitAuth,
        emitJobs,
        emitSummary,
        listenerCount: () => authListeners.size + jobListeners.size + summaryListeners.size,
    };
}
