/**
 * Installs `window.hlsApi` (the same RendererApi the Electron preload exposed) on top of Tauri.
 * It must be the first import of main.tsx so the API exists before React reads it.
 *
 * Channel names and payload shapes are those of src/shared/ipc.ts. Tauri command names must be
 * valid identifiers, and Tauri event names may not contain `:`, so:
 *
 *   IpcChannels (invoke)              Tauri command            argument
 *   --------------------------------  -----------------------  ---------------------------
 *   app:get-version                   app_get_version          -
 *   app:open-logs-folder              app_open_logs_folder     -
 *   app:open-notices                  app_open_notices         -
 *   diagnostics:get                   diagnostics_get          -
 *   auth:get-state                    auth_get_state           -
 *   auth:login                        auth_login               { payload: {username,password,staySignedIn?} }
 *   auth:logout                       auth_logout              -
 *   auth:reload-config                auth_reload_config       -
 *   settings:get                      settings_get             -
 *   settings:set                      settings_set             { payload: SettingsPatch }
 *   settings:pick-directory           settings_pick_directory  -
 *   jobs:list                         jobs_list                -
 *   jobs:add-files                    jobs_add_files           -
 *   jobs:add-paths                    jobs_add_paths           { payload: {paths} }
 *   jobs:cancel|retry|retry-register  jobs_cancel|jobs_retry|  { payload: {id} }
 *     |resume|remove|open-embed         jobs_retry_register|...
 *   jobs:clear-finished               jobs_clear_finished      -
 *   jobs:copy                         jobs_copy                { payload: {id,kind} }
 *   videos:list                       videos_list              { payload: {page?,perPage?,q?,sort?,status?} }
 *   videos:get                        videos_get               { payload: {id} }
 *   videos:copy-link                  videos_copy_link         { payload: {id,kind} }
 *   videos:open-embed                 videos_open_embed        { payload: {id} }
 *   videos:update-title               videos_update_title      { payload: {id,title} }
 *   videos:delete                     videos_delete            { payload: {id} }
 *   videos:bulk-delete                videos_bulk_delete       { payload: {ids} }
 *   videos:set-image                  videos_set_image         { payload: {id} }
 *   videos:remove-image               videos_remove_image      { payload: {id} }
 *   overview:get                      overview_get             (no payload)
 *   logs:get                          logs_get                 { payload: {type?,page?,perPage?} }
 *
 *   IpcEvents (Rust -> renderer)      Tauri event name
 *   --------------------------------  ----------------
 *   auth:changed                      auth-changed
 *   jobs:updated                      jobs-updated
 *   queue:summary                     queue-summary
 *
 * Rule: command = channel with `:` and `-` replaced by `_`; event = event with `:` replaced by `-`.
 *
 * Drag and drop: with Tauri the webview swallows file drops, so the DOM never sees real `File`
 * objects. `installDragDrop` listens to Tauri's drag-drop event (which carries real paths) and
 * re-dispatches it as ordinary DOM dragenter/dragover/dragleave/drop events whose `files` are
 * placeholder `File` objects. The path of each placeholder is kept in a WeakMap, so the existing
 * DropZone code keeps working and `jobs.addDroppedFiles` turns the placeholders back into paths.
 * TODO(milestone queue): a genuine DOM `File` (e.g. from <input type="file">) has no filesystem
 * path in a webview; such files are reported back as rejected instead of being added.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { IpcChannels, IpcEvents, RENDERER_API_KEY } from '../../shared/ipc';
import type {
    ActionResult,
    AddFilesResult,
    AuthState,
    DiagnosticsDto,
    DroppedFile,
    JobDto,
    LogsGetResult,
    OverviewGetResult,
    PickDirectoryResult,
    QueueSummary,
    RejectedFile,
    RendererApi,
    SettingsDto,
    SettingsResult,
    Unsubscribe,
    VideosBulkDeleteResult,
    VideosSetImageResult,
    VideosDeleteResult,
    VideosGetResult,
    VideosListResult,
    VideosUpdateTitleResult,
} from '../../shared/ipc';

export type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type ListenFn = (
    event: string,
    handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/** `app:get-version` -> `app_get_version`. */
export function commandName(channel: string): string {
    return channel.replace(/[:-]/g, '_');
}

/** `jobs:updated` -> `jobs-updated`. */
export function eventName(event: string): string {
    return event.replace(/:/g, '-');
}

/** Paths of placeholder files created for a Tauri drop, keyed by the placeholder object. */
const droppedPaths = new WeakMap<object, string>();

function baseName(path: string): string {
    const parts = path.split(/[\\/]/);

    return parts[parts.length - 1] ?? path;
}

export function createTauriApi(call: InvokeFn, subscribeTo: ListenFn): RendererApi {
    const send = <T>(channel: string, payload?: unknown): Promise<T> =>
        (payload === undefined
            ? call(commandName(channel))
            : call(commandName(channel), { payload })) as Promise<T>;

    const subscribe = <T>(event: string, listener: (payload: T) => void): Unsubscribe => {
        let disposed = false;
        let stop: (() => void) | null = null;

        void subscribeTo(eventName(event), (e) => listener(e.payload as T)).then((unlisten) => {
            if (disposed) unlisten();
            else stop = unlisten;
        });

        return () => {
            disposed = true;
            stop?.();
            stop = null;
        };
    };

    return {
        app: {
            getVersion: () => send<string>(IpcChannels.appGetVersion),
            openLogsFolder: () => send<ActionResult>(IpcChannels.appOpenLogsFolder),
            openNotices: () => send<ActionResult>(IpcChannels.appOpenNotices),
            getDiagnostics: () => send<DiagnosticsDto>(IpcChannels.diagnosticsGet),
        },
        auth: {
            getState: () => send<AuthState>(IpcChannels.authGetState),
            login: (username, password, staySignedIn) =>
                send<AuthState>(IpcChannels.authLogin, {
                    username,
                    password,
                    ...(staySignedIn === undefined ? {} : { staySignedIn }),
                }),
            logout: () => send<AuthState>(IpcChannels.authLogout),
            reloadConfig: () => send<AuthState>(IpcChannels.authReloadConfig),
            onChanged: (listener) => subscribe<AuthState>(IpcEvents.authChanged, listener),
        },
        settings: {
            get: () => send<SettingsDto>(IpcChannels.settingsGet),
            set: (patch) => send<SettingsResult>(IpcChannels.settingsSet, patch),
            pickDirectory: () => send<PickDirectoryResult>(IpcChannels.settingsPickDirectory),
        },
        jobs: {
            list: () => send<JobDto[]>(IpcChannels.jobsList),
            addFiles: () => send<AddFilesResult>(IpcChannels.jobsAddFiles),
            addDroppedFiles: async (files: readonly DroppedFile[]) => {
                const paths: string[] = [];
                const unresolved: RejectedFile[] = [];

                for (const file of files) {
                    const path = droppedPaths.get(file);

                    if (path !== undefined) paths.push(path);
                    else {
                        const name = (file as { name?: unknown }).name;

                        unresolved.push({
                            name: typeof name === 'string' ? name : 'Unknown file',
                            reason: 'The file location could not be read',
                        });
                    }
                }

                if (paths.length === 0) return { added: 0, rejected: unresolved, canceled: false };

                const result = await send<AddFilesResult>(IpcChannels.jobsAddPaths, { paths });

                return { ...result, rejected: [...result.rejected, ...unresolved] };
            },
            cancel: (id) => send<ActionResult>(IpcChannels.jobsCancel, { id }),
            retry: (id) => send<ActionResult>(IpcChannels.jobsRetry, { id }),
            retryRegister: (id) => send<ActionResult>(IpcChannels.jobsRetryRegister, { id }),
            resume: (id) => send<ActionResult>(IpcChannels.jobsResume, { id }),
            remove: (id) => send<ActionResult>(IpcChannels.jobsRemove, { id }),
            clearFinished: () => send<ActionResult>(IpcChannels.jobsClearFinished),
            openEmbed: (id) => send<ActionResult>(IpcChannels.jobsOpenEmbed, { id }),
            copy: (id, kind) => send<ActionResult>(IpcChannels.jobsCopy, { id, kind }),
            onUpdated: (listener) => subscribe<JobDto[]>(IpcEvents.jobsUpdated, listener),
            onSummary: (listener) => subscribe<QueueSummary>(IpcEvents.queueSummary, listener),
        },
        videos: {
            list: (params) => send<VideosListResult>(IpcChannels.videosList, params ?? {}),
            get: (id) => send<VideosGetResult>(IpcChannels.videosGet, { id }),
            copyLink: (id, kind, index) =>
                send<ActionResult>(
                    IpcChannels.videosCopyLink,
                    index === undefined ? { id, kind } : { id, kind, index },
                ),
            openEmbed: (id) => send<ActionResult>(IpcChannels.videosOpenEmbed, { id }),
            updateTitle: (id, title) =>
                send<VideosUpdateTitleResult>(IpcChannels.videosUpdateTitle, { id, title }),
            delete: (id) => send<VideosDeleteResult>(IpcChannels.videosDelete, { id }),
            bulkDelete: (ids) =>
                send<VideosBulkDeleteResult>(IpcChannels.videosBulkDelete, { ids }),
            setImage: (id) => send<VideosSetImageResult>(IpcChannels.videosSetImage, { id }),
            removeImage: (id) => send<ActionResult>(IpcChannels.videosRemoveImage, { id }),
        },
        overview: {
            get: () => send<OverviewGetResult>(IpcChannels.overviewGet),
        },
        logs: {
            get: (params) => send<LogsGetResult>(IpcChannels.logsGet, params ?? {}),
        },
    };
}

type DragKind = 'dragenter' | 'dragover' | 'dragleave' | 'drop';

function dispatchDrag(kind: DragKind, x: number, y: number, paths: readonly string[]): void {
    const target = document.elementFromPoint(x, y) ?? document.body;
    const transfer = new DataTransfer();

    for (const path of paths) {
        const placeholder = new File([], baseName(path));

        droppedPaths.set(placeholder, path);
        transfer.items.add(placeholder);
    }

    target.dispatchEvent(
        new DragEvent(kind, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: x,
            clientY: y,
        }),
    );
}

/** Re-dispatches Tauri's drag-drop events as DOM drag events (see the note at the top). */
async function installDragDrop(): Promise<void> {
    await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        // Tauri reports physical pixels; the DOM wants CSS pixels.
        const scale = window.devicePixelRatio || 1;

        if (payload.type === 'leave') {
            dispatchDrag('dragleave', -1, -1, []);

            return;
        }

        const x = payload.position.x / scale;
        const y = payload.position.y / scale;

        if (payload.type === 'enter') dispatchDrag('dragenter', x, y, payload.paths);
        else if (payload.type === 'over') dispatchDrag('dragover', x, y, []);
        else dispatchDrag('drop', x, y, payload.paths);
    });
}

/** Installs the API only inside Tauri; a plain browser keeps the dev `?mock=1` path working. */
export function installTauriApi(): void {
    if (!('__TAURI_INTERNALS__' in window)) return;

    Object.defineProperty(window, RENDERER_API_KEY, {
        value: createTauriApi(invoke as InvokeFn, listen as ListenFn),
        configurable: true,
    });

    installDragDrop().catch(() => {
        // Without drag and drop the "Upload videos" button still works.
    });
}

installTauriApi();
