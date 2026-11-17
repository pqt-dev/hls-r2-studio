import type { AppConfigTranscode } from './appConfig';
import type { JobErrorDetail, JobState } from './types';

/** IPC channel names shared by main, preload and renderer. */
export const IpcChannels = {
    appGetVersion: 'app:get-version',
    appOpenLogsFolder: 'app:open-logs-folder',
    appOpenNotices: 'app:open-notices',
    diagnosticsGet: 'diagnostics:get',
    authGetState: 'auth:get-state',
    authLogin: 'auth:login',
    authLogout: 'auth:logout',
    authReloadConfig: 'auth:reload-config',
    settingsGet: 'settings:get',
    settingsSet: 'settings:set',
    settingsPickDirectory: 'settings:pick-directory',
    jobsList: 'jobs:list',
    jobsAddFiles: 'jobs:add-files',
    jobsAddPaths: 'jobs:add-paths',
    jobsCancel: 'jobs:cancel',
    jobsRetry: 'jobs:retry',
    jobsRetryRegister: 'jobs:retry-register',
    jobsResume: 'jobs:resume',
    jobsRemove: 'jobs:remove',
    jobsClearFinished: 'jobs:clear-finished',
    jobsOpenEmbed: 'jobs:open-embed',
    jobsCopy: 'jobs:copy',
} as const;

/** Main -> renderer push events. */
export const IpcEvents = {
    authChanged: 'auth:changed',
    jobsUpdated: 'jobs:updated',
    queueSummary: 'queue:summary',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
export type IpcEvent = (typeof IpcEvents)[keyof typeof IpcEvents];

// ---- shared DTOs (nothing here may carry a secret) ----------------------------------------

export type AuthStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'offline';

export interface AuthState {
    status: AuthStatus;
    username?: string;
    siteUrl?: string;
    /** Whether the site has complete R2 settings. Known once the config was fetched. */
    r2Configured?: boolean;
    /** True when the token is stored on disk ("stay signed in"); false = this session only. */
    persisted?: boolean;
    /** Safe English message for the UI. */
    error?: string;
}

/** What the renderer may know about the site config. The R2 credentials are never included. */
export interface PublicConfig {
    r2Configured: boolean;
    transcode: AppConfigTranscode | null;
}

export interface SettingsDto {
    /** Read-only: the site this build is fixed to (empty when the build has none). */
    siteUrl: string;
    tmpRoot: string;
    maxConcurrent: number;
}

export interface SettingsPatch {
    tmpRoot?: string;
    maxConcurrent?: number;
}

/** Outcome of an action the user can trigger. `error` is safe English text. */
export type ActionResult = { ok: true } | { ok: false; error: string };

export type SettingsResult = { ok: true; settings: SettingsDto } | { ok: false; error: string };

/** Result of the native folder picker. The chosen path is then saved through `settings.set`. */
export type PickDirectoryResult = { canceled: true } | { canceled: false; path: string };

export interface RejectedFile {
    /** File name only (never the full path). */
    name: string;
    reason: string;
}

export interface AddFilesResult {
    added: number;
    rejected: RejectedFile[];
    /** True when the user closed the file dialog without choosing anything. */
    canceled: boolean;
}

/** Renderer-visible job. No file paths, payloads or secrets. */
export interface JobDto {
    id: string;
    fileName: string;
    sizeBytes: number;
    state: JobState;
    /** Translation key of the current stage label, e.g. `job.state.uploading`. */
    stageKey: string;
    /** Overall progress 0-100. */
    progress: number;
    /** Why a waiting job is not running yet (e.g. not signed in), else null. */
    waitingReason: string | null;
    /** True while the upload retries automatically because the network is down. */
    waitingForNetwork: boolean;
    /** ISO time the current network outage started; set only while `waitingForNetwork`. */
    networkWaitSince?: string;
    errorMessage: string | null;
    /** Failed/interrupted details; text already redacted. */
    errorDetail: JobErrorDetail | null;
    publicId: string | null;
    embedUrl: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    canCancel: boolean;
    /** For `upload_interrupted` this means "Start over" (process the video again). */
    canRetry: boolean;
    /** True for a paused upload that can be continued without transcoding again. */
    canResume: boolean;
    canRetryRegister: boolean;
    canRemove: boolean;
}

export interface QueueSummary {
    running: number;
    waiting: number;
    attention: number;
    done: number;
    failed: number;
    total: number;
    /** Why waiting jobs cannot start right now, or null. */
    blockedReason: string | null;
}

export interface FfmpegDiagnostics {
    /** False while the startup self-check has not finished. */
    checked: boolean;
    ok: boolean;
    version: string | null;
    missing: string[];
}

export interface DiagnosticsDto {
    appVersion: string;
    platform: string;
    ffmpeg: FfmpegDiagnostics;
}

export type CopyKind = 'embed-url' | 'shortcode';

// ---- preload API --------------------------------------------------------------------------

/** Function that removes a subscription. */
export type Unsubscribe = () => void;

/** Opaque reference to a dropped DOM `File`; the preload turns it into a path string. */
export type DroppedFile = object;

export interface AppApi {
    getVersion(): Promise<string>;
    openLogsFolder(): Promise<ActionResult>;
    /** Opens the third-party licenses file with the system viewer. */
    openNotices(): Promise<ActionResult>;
    getDiagnostics(): Promise<DiagnosticsDto>;
}

export interface AuthApi {
    getState(): Promise<AuthState>;
    /** The site is fixed at build time; the renderer cannot choose it. */
    login(username: string, password: string, staySignedIn?: boolean): Promise<AuthState>;
    logout(): Promise<AuthState>;
    reloadConfig(): Promise<AuthState>;
    onChanged(listener: (state: AuthState) => void): Unsubscribe;
}

export interface SettingsApi {
    get(): Promise<SettingsDto>;
    set(patch: SettingsPatch): Promise<SettingsResult>;
    /** Main opens the native folder dialog; nothing is saved until `set` is called. */
    pickDirectory(): Promise<PickDirectoryResult>;
}

export interface JobsApi {
    list(): Promise<JobDto[]>;
    /** Main opens the native file dialog. */
    addFiles(): Promise<AddFilesResult>;
    /** Drag and drop: the preload resolves the real paths and only strings cross the IPC. */
    addDroppedFiles(files: readonly DroppedFile[]): Promise<AddFilesResult>;
    cancel(id: string): Promise<ActionResult>;
    retry(id: string): Promise<ActionResult>;
    retryRegister(id: string): Promise<ActionResult>;
    /** Continues a paused upload (`upload_interrupted`) without transcoding again. */
    resume(id: string): Promise<ActionResult>;
    remove(id: string): Promise<ActionResult>;
    clearFinished(): Promise<ActionResult>;
    openEmbed(id: string): Promise<ActionResult>;
    copy(id: string, kind: CopyKind): Promise<ActionResult>;
    onUpdated(listener: (jobs: JobDto[]) => void): Unsubscribe;
    onSummary(listener: (summary: QueueSummary) => void): Unsubscribe;
}

export interface RendererApi {
    app: AppApi;
    auth: AuthApi;
    settings: SettingsApi;
    jobs: JobsApi;
}

/** Name of the property exposed on `window` through contextBridge. */
export const RENDERER_API_KEY = 'hlsApi';
