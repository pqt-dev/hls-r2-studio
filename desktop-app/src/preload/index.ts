import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IpcChannels, IpcEvents, RENDERER_API_KEY } from '../shared/ipc';
import type {
    ActionResult,
    AddFilesResult,
    AuthState,
    DiagnosticsDto,
    JobDto,
    PickDirectoryResult,
    QueueSummary,
    RendererApi,
    SettingsDto,
    SettingsResult,
    Unsubscribe,
} from '../shared/ipc';

/** Typed invoke helper: the main process validates every payload again. */
function invoke<T>(channel: string, payload?: unknown): Promise<T> {
    return (
        payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload)
    ) as Promise<T>;
}

/** Subscribes to a main -> renderer event. The Electron event object is never handed out. */
function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload as T);

    ipcRenderer.on(channel, wrapped);

    return () => {
        ipcRenderer.removeListener(channel, wrapped);
    };
}

/** Resolves real paths of dropped files. Only strings cross the IPC boundary. */
function pathsOf(files: readonly object[]): string[] {
    const paths: string[] = [];

    for (const file of files) {
        try {
            const path = webUtils.getPathForFile(file as File);

            if (path !== '') paths.push(path);
        } catch {
            // Not a real file (e.g. dragged text): skip it.
        }
    }

    return paths;
}

const api: RendererApi = {
    app: {
        getVersion: () => invoke<string>(IpcChannels.appGetVersion),
        openLogsFolder: () => invoke<ActionResult>(IpcChannels.appOpenLogsFolder),
        openNotices: () => invoke<ActionResult>(IpcChannels.appOpenNotices),
        getDiagnostics: () => invoke<DiagnosticsDto>(IpcChannels.diagnosticsGet),
    },
    auth: {
        getState: () => invoke<AuthState>(IpcChannels.authGetState),
        login: (siteUrl, username, password, staySignedIn) =>
            invoke<AuthState>(IpcChannels.authLogin, {
                siteUrl,
                username,
                password,
                ...(staySignedIn === undefined ? {} : { staySignedIn }),
            }),
        logout: () => invoke<AuthState>(IpcChannels.authLogout),
        reloadConfig: () => invoke<AuthState>(IpcChannels.authReloadConfig),
        onChanged: (listener) => subscribe<AuthState>(IpcEvents.authChanged, listener),
    },
    settings: {
        get: () => invoke<SettingsDto>(IpcChannels.settingsGet),
        set: (patch) => invoke<SettingsResult>(IpcChannels.settingsSet, patch),
        pickDirectory: () => invoke<PickDirectoryResult>(IpcChannels.settingsPickDirectory),
    },
    jobs: {
        list: () => invoke<JobDto[]>(IpcChannels.jobsList),
        addFiles: () => invoke<AddFilesResult>(IpcChannels.jobsAddFiles),
        addDroppedFiles: (files) =>
            invoke<AddFilesResult>(IpcChannels.jobsAddPaths, { paths: pathsOf(files) }),
        cancel: (id) => invoke<ActionResult>(IpcChannels.jobsCancel, { id }),
        retry: (id) => invoke<ActionResult>(IpcChannels.jobsRetry, { id }),
        retryRegister: (id) => invoke<ActionResult>(IpcChannels.jobsRetryRegister, { id }),
        remove: (id) => invoke<ActionResult>(IpcChannels.jobsRemove, { id }),
        clearFinished: () => invoke<ActionResult>(IpcChannels.jobsClearFinished),
        openEmbed: (id) => invoke<ActionResult>(IpcChannels.jobsOpenEmbed, { id }),
        copy: (id, kind) => invoke<ActionResult>(IpcChannels.jobsCopy, { id, kind }),
        onUpdated: (listener) => subscribe<JobDto[]>(IpcEvents.jobsUpdated, listener),
        onSummary: (listener) => subscribe<QueueSummary>(IpcEvents.queueSummary, listener),
    },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
