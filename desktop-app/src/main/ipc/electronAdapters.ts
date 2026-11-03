/** Thin Electron adapters (dialog, clipboard, shell, window messages). No logic lives here. */
import { clipboard, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { VIDEO_EXTENSIONS } from '../queue/fileValidation';

export interface ElectronAdapters {
    pickVideoFiles(): Promise<string[] | null>;
    writeClipboard(text: string): void;
    openExternal(url: string): Promise<void>;
    openLogsFolder(): Promise<string>;
    pickDirectory(): Promise<string | null>;
    /** Opens a local file with the system viewer; resolves to an empty string on success. */
    openPath(path: string): Promise<string>;
    send(channel: string, payload: unknown): void;
    confirmQuit(): Promise<boolean>;
}

export function createElectronAdapters(
    getWindow: () => BrowserWindow | null,
    logsDir: string,
): ElectronAdapters {
    return {
        async pickVideoFiles() {
            const options = {
                title: 'Add videos',
                properties: ['openFile', 'multiSelections'] as Array<
                    'openFile' | 'multiSelections'
                >,
                filters: [{ name: 'Videos', extensions: [...VIDEO_EXTENSIONS] }],
            };
            const win = getWindow();
            const result = win
                ? await dialog.showOpenDialog(win, options)
                : await dialog.showOpenDialog(options);

            return result.canceled ? null : result.filePaths;
        },

        writeClipboard: (text) => clipboard.writeText(text),

        openExternal: (url) => shell.openExternal(url),

        openLogsFolder: () => shell.openPath(logsDir),

        async pickDirectory() {
            const options = {
                title: 'Choose temporary folder',
                properties: ['openDirectory', 'createDirectory'] as Array<
                    'openDirectory' | 'createDirectory'
                >,
            };
            const win = getWindow();
            const result = win
                ? await dialog.showOpenDialog(win, options)
                : await dialog.showOpenDialog(options);
            const [first] = result.filePaths;

            return result.canceled || first === undefined ? null : first;
        },

        openPath: (path) => shell.openPath(path),

        send(channel, payload) {
            const win = getWindow();

            if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send(channel, payload);
            }
        },

        async confirmQuit() {
            const options = {
                type: 'warning' as const,
                buttons: ['Quit', 'Keep working'],
                defaultId: 1,
                cancelId: 1,
                title: 'HLS R2 Studio',
                message: 'Jobs are still running. Quit and cancel them?',
            };
            const win = getWindow();
            const result = win
                ? await dialog.showMessageBox(win, options)
                : await dialog.showMessageBox(options);

            return result.response === 0;
        },
    };
}
