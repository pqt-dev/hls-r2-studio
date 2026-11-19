/**
 * A controllable in-memory `RendererApi`. Used by the unit tests and (through mockApi.ts) by the
 * dev-only `?mock=1` mode. It never touches Electron, the network or the filesystem.
 */
import type {
    ActionResult,
    AuthState,
    DiagnosticsDto,
    JobDto,
    LogCounts,
    LogItem,
    Overview,
    PickDirectoryResult,
    QueueSummary,
    R2Status,
    RendererApi,
    SettingsDto,
    VideoDetail,
    VideoListItem,
} from '../../../shared/ipc';

export function makeJob(partial: Partial<JobDto> = {}): JobDto {
    const state = partial.state ?? 'waiting';

    return {
        id: 'job-1',
        fileName: 'holiday-video.mp4',
        sizeBytes: 42 * 1024 * 1024,
        state,
        stageKey: `job.state.${state}`,
        progress: 0,
        waitingReason: null,
        waitingForNetwork: false,
        errorMessage: null,
        errorDetail: null,
        thumbnailUrl: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        canCancel: false,
        canRetry: false,
        canResume: false,
        canRetryRegister: false,
        canRemove: false,
        ...partial,
    };
}

export function makeVideo(partial: Partial<VideoListItem> = {}): VideoListItem {
    return {
        id: 1,
        publicId: 'abcdefghijkl',
        title: 'Holiday video',
        originalFilename: 'holiday.mp4',
        status: 'ready',
        duration: 75,
        width: 1920,
        height: 1080,
        sizeBytes: 42 * 1024 * 1024,
        fps: 30,
        bitrateKbps: 2400,
        thumbnailUrl: null,
        hasCustomImage: false,
        embedUrl: 'https://site.example.com/embed/abcdefghijkl',
        createdAt: '2026-01-01T10:00:00.000Z',
        ...partial,
    };
}

export function makeVideoDetail(partial: Partial<VideoDetail> = {}): VideoDetail {
    return {
        id: 1,
        publicId: 'abcdefghijkl',
        title: 'Holiday video',
        originalFilename: 'holiday.mp4',
        originalSizeBytes: 150 * 1024 * 1024,
        status: 'ready',
        stage: null,
        progress: null,
        error: null,
        duration: 75,
        outputWidth: 1920,
        outputHeight: 1080,
        outputFps: 29.97,
        outputBitrateKbps: 4500,
        outputCodec: 'h264',
        embedUrl: 'https://site.example.com/embed/abcdefghijkl',
        playlistUrl: 'https://cdn.example.com/videos/abcdefghijkl/master.m3u8',
        storageFolder: '2026/11/18/holiday-video-abcdefghijkl/',
        shortcode: '[hls_embed_vl id="abcdefghijkl"]',
        iframeCode:
            '<iframe src="https://site.example.com/embed/abcdefghijkl" style="width:100%; aspect-ratio:16 / 9; max-height:75vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>',
        thumbnailUrl: 'https://cdn.example.com/videos/abcdefghijkl/thumb.jpg',
        hasCustomImage: false,
        customImageUrl: null,
        storyboards: {},
        embedStoryboard: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-02T10:00:00.000Z',
        ...partial,
    };
}

export function makeLogItem(partial: Partial<LogItem> = {}): LogItem {
    return {
        id: 1,
        publicId: 'abcdefghijkl',
        title: 'Holiday video',
        originalFilename: 'holiday.mp4',
        status: 'ready',
        stage: null,
        progress: null,
        errorMessage: null,
        errorDetail: null,
        failedAt: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:05:00.000Z',
        ...partial,
    };
}

export function makeLogCounts(partial: Partial<LogCounts> = {}): LogCounts {
    return { total: 0, success: 0, error: 0, processing: 0, ...partial };
}

export function makeOverview(partial: Partial<Overview> = {}): Overview {
    return {
        videos: { total: 0, ready: 0, processing: 0, failed: 0 },
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
    /** What the site reports about R2 (never holds a key or a secret). */
    r2: R2Status;
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
        r2: {
            configured: true,
            source: 'database',
            endpoint: 'https://acct.r2.cloudflarestorage.com',
            bucket: 'media',
            url: 'https://cdn.example.com',
            accessKeyLast4: 'wxyz',
            hasSecret: true,
        },
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
            login: (username) => {
                const next: AuthState = {
                    status: 'signed_in',
                    username,
                    siteUrl: state.settings.siteUrl,
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
            resume: () => Promise.resolve(OK),
            remove: () => Promise.resolve(OK),
            clearFinished: () => Promise.resolve(OK),
            onUpdated: (listener) => subscribe(jobListeners, listener),
            onSummary: (listener) => subscribe(summaryListeners, listener),
        },
        videos: {
            list: () =>
                Promise.resolve({
                    ok: true,
                    data: [],
                    meta: { page: 1, perPage: 24, total: 0, lastPage: 1 },
                }),
            get: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
            copyLink: () => Promise.resolve(OK),
            openEmbed: () => Promise.resolve(OK),
            updateTitle: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
            delete: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
            bulkDelete: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
            setImage: () => Promise.resolve({ ok: true, canceled: true }),
            removeImage: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
        },
        overview: {
            get: () => Promise.resolve({ ok: true, overview: makeOverview() }),
        },
        logs: {
            get: () =>
                Promise.resolve({
                    ok: true,
                    view: 'summary',
                    counts: makeLogCounts(),
                    success: [],
                    error: [],
                    processing: [],
                }),
        },
        r2: {
            get: () => Promise.resolve({ ok: true, status: state.r2 }),
            // Like the site: only the last four characters of the key and a flag are kept.
            save: (input) => {
                const key = input.accessKeyId?.trim() ?? '';
                const secret = input.secretAccessKey?.trim() ?? '';

                state.r2 = {
                    configured: true,
                    source: 'database',
                    endpoint: input.endpoint,
                    bucket: input.bucket,
                    url: input.url,
                    accessKeyLast4: key === '' ? state.r2.accessKeyLast4 : key.slice(-4),
                    hasSecret: secret !== '' || state.r2.hasSecret,
                };

                return Promise.resolve({ ok: true, status: state.r2 });
            },
            test: () => Promise.resolve({ ok: true }),
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
