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
    videosList: 'videos:list',
    videosGet: 'videos:get',
    videosCopyLink: 'videos:copy-link',
    videosOpenEmbed: 'videos:open-embed',
    videosUpdateTitle: 'videos:update-title',
    videosDelete: 'videos:delete',
    videosBulkDelete: 'videos:bulk-delete',
    videosSetImage: 'videos:set-image',
    videosRemoveImage: 'videos:remove-image',
    overviewGet: 'overview:get',
    logsGet: 'logs:get',
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
    /** Numeric id of the video on the site; set only once the job is registered. */
    videoId?: number;
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

// ---- cloud video library ------------------------------------------------------

/** Unknown words can appear when the site adds a status, so treat any other value as "other". */
export type VideoStatus = 'pending' | 'processing' | 'ready' | 'failed' | (string & {});

/** Server-side sort orders of the video list (same whitelist as the site and the Rust side). */
export const VIDEO_SORTS = [
    'newest',
    'oldest',
    'title_asc',
    'title_desc',
    'duration_desc',
    'size_desc',
] as const;

export type VideoSort = (typeof VIDEO_SORTS)[number];

/** Server-side status filter of the video list (absent = every status). */
export const VIDEO_STATUS_FILTERS = ['pending', 'processing', 'ready', 'failed'] as const;

export type VideoStatusFilter = (typeof VIDEO_STATUS_FILTERS)[number];

export interface VideoListParams {
    /** >= 1, default 1. */
    page?: number;
    /** 1..50, default 24. */
    perPage?: number;
    /** Search text, trimmed, at most 100 characters. Every word must match the title. */
    q?: string;
    /** Default `newest`. */
    sort?: VideoSort;
    /** Only videos in this status; omitted = all. */
    status?: VideoStatusFilter;
}

export interface VideoListMeta {
    page: number;
    perPage: number;
    total: number;
    lastPage: number;
}

/**
 * One row of the list. Thumbnail and embed URLs are built by the main process; storage paths
 * and the R2 base URL never reach the renderer.
 */
export interface VideoListItem {
    id: number;
    publicId: string;
    title: string;
    originalFilename: string | null;
    status: VideoStatus;
    duration: number | null;
    /** Output resolution in pixels; null until the video is processed. */
    width: number | null;
    height: number | null;
    /** Size of the original upload in bytes; null when the site does not report it. */
    sizeBytes: number | null;
    /** Frames per second and video bitrate in kilobits per second of the output; null if unknown. */
    fps: number | null;
    bitrateKbps: number | null;
    /** The generated thumbnail only (a custom image never replaces it); null when unavailable. */
    thumbnailUrl: string | null;
    hasCustomImage: boolean;
    embedUrl: string | null;
    createdAt: string | null;
}

export interface VideoErrorInfo {
    message: string | null;
    /** Already sanitized by the site. */
    detail: string | null;
    failedAt: string | null;
}

export interface VideoStoryboard {
    url: string | null;
    columns: number | null;
    count: number | null;
}

export interface VideoEmbedStoryboard {
    url: string | null;
    number: number | null;
    column: number | null;
    width: number | null;
    height: number | null;
}

/** Detail of one video. URL fields are https URLs, or null when the file does not exist. */
export interface VideoDetail {
    id: number;
    publicId: string;
    title: string;
    originalFilename: string | null;
    originalSizeBytes: number | null;
    status: VideoStatus;
    stage: string | null;
    progress: number | null;
    /** Set only when `status` is `failed`. */
    error: VideoErrorInfo | null;
    duration: number | null;
    outputWidth: number | null;
    outputHeight: number | null;
    outputFps: number | null;
    outputBitrateKbps: number | null;
    outputCodec: string | null;
    embedUrl: string | null;
    playlistUrl: string | null;
    /**
     * Ready-made `[hls_embed_vl id="..."]` and iframe snippet, built by the main process with the
     * same checks as the Copy buttons; null when they cannot be offered. Displayed as is.
     */
    shortcode: string | null;
    iframeCode: string | null;
    thumbnailUrl: string | null;
    hasCustomImage: boolean;
    customImageUrl: string | null;
    storyboards: Record<string, VideoStoryboard>;
    embedStoryboard: VideoEmbedStoryboard | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/** `error` is safe English text (never the site's body, URL or token). */
export type VideosListResult =
    { ok: true; data: VideoListItem[]; meta: VideoListMeta } | { ok: false; error: string };

export type VideosGetResult = { ok: true; video: VideoDetail } | { ok: false; error: string };

/** Renaming returns the updated detail. */
export type VideosUpdateTitleResult = VideosGetResult;

/** `skipped`: the video is still pending/processing, nothing changed. `failed`: kept, retry. */
export type VideoDeleteStatus = 'deleted' | 'skipped' | 'failed';

export type VideosDeleteResult =
    { ok: true; status: VideoDeleteStatus; message: string } | { ok: false; error: string };

export type VideosBulkDeleteResult =
    | { ok: true; deleted: number; failed: number; skipped: number; message: string }
    | { ok: false; error: string };

/** Main opens the native image picker; `canceled` when the user closed it. */
export type VideosSetImageResult =
    | { ok: true; canceled: true }
    | { ok: true; canceled: false; imageUrl?: string }
    | { ok: false; error: string };

/** Which URL of a video the main process copies (it fetches the video itself). */
export type VideoLinkKind =
    | 'embed-url'
    | 'playlist-url'
    | 'shortcode'
    | 'iframe-code'
    | 'thumbnail-url'
    | 'custom-image-url'
    | 'storyboard-url';

// ---- overview + logs (site dashboard numbers) ----------------------------------------------

export interface OverviewVideoCounts {
    total: number;
    ready: number;
    processing: number;
    failed: number;
}

export interface Overview {
    videos: OverviewVideoCounts;
}

export type OverviewGetResult = { ok: true; overview: Overview } | { ok: false; error: string };

export type LogType = 'success' | 'error' | 'processing';

export interface LogsParams {
    /** Omitted: the summary view (three short lists). */
    type?: LogType;
    /** Only used with `type`. */
    page?: number;
    /** 1..50; only used with `type`. */
    perPage?: number;
}

export interface LogCounts {
    total: number;
    success: number;
    error: number;
    processing: number;
}

/**
 * One log row. All text is plain text from the site (control characters stripped, length capped):
 * render it as text, never as HTML. `errorDetail` may hold line breaks.
 */
export interface LogItem {
    id: number;
    publicId: string;
    title: string;
    originalFilename: string | null;
    status: VideoStatus;
    stage: string | null;
    /** Whole percent 0..100. */
    progress: number | null;
    errorMessage: string | null;
    errorDetail: string | null;
    failedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/** `error` is safe English text (never the site's body, URL or token). */
export type LogsGetResult =
    | {
          ok: true;
          view: 'summary';
          counts: LogCounts;
          success: LogItem[];
          error: LogItem[];
          processing: LogItem[];
      }
    | { ok: true; view: 'page'; counts: LogCounts; data: LogItem[]; meta: VideoListMeta }
    | { ok: false; error: string };

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

export interface VideosApi {
    list(params?: VideoListParams): Promise<VideosListResult>;
    get(id: number): Promise<VideosGetResult>;
    /** Main fetches the video and copies the URL; the renderer never passes clipboard text. */
    /** `index` (0-based, among the storyboards that have a URL) is required for `storyboard-url` only. */
    copyLink(id: number, kind: VideoLinkKind, index?: number): Promise<ActionResult>;
    /** Main fetches the video and opens its embed page when it is https on the signed-in site. */
    openEmbed(id: number): Promise<ActionResult>;
    /** Title is trimmed by the main process: 1..255 characters, no control characters. */
    updateTitle(id: number, title: string): Promise<VideosUpdateTitleResult>;
    /** Deleting is only allowed after the renderer asked the user to confirm. */
    delete(id: number): Promise<VideosDeleteResult>;
    /** 1..100 ids (duplicates are dropped by the main process). */
    bulkDelete(ids: number[]): Promise<VideosBulkDeleteResult>;
    /** Rust opens the file picker and uploads the chosen image; the renderer never sees a path. */
    setImage(id: number): Promise<VideosSetImageResult>;
    /** Removes the custom thumbnail (only after the user confirmed). */
    removeImage(id: number): Promise<ActionResult>;
}

export interface OverviewApi {
    get(): Promise<OverviewGetResult>;
}

export interface LogsApi {
    /** No `type`: the summary view; with `type`: one paginated page. */
    get(params?: LogsParams): Promise<LogsGetResult>;
}

export interface RendererApi {
    app: AppApi;
    auth: AuthApi;
    settings: SettingsApi;
    jobs: JobsApi;
    videos: VideosApi;
    overview: OverviewApi;
    logs: LogsApi;
}

/** Name of the property exposed on `window` through contextBridge. */
export const RENDERER_API_KEY = 'hlsApi';
