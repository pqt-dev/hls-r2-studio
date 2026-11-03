import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { AppLocation } from './security/navigation';
import { buildAppLocation, isAppUrl } from './security/navigation';
import type { Logger } from './logger';

export function getAppLocation(isPackaged: boolean): AppLocation {
    return buildAppLocation({
        isPackaged,
        rendererUrlEnv: process.env['ELECTRON_RENDERER_URL'],
        indexFileUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
    });
}

export function createMainWindow(dev: boolean, logger: Logger): BrowserWindow {
    const location = getAppLocation(app.isPackaged);

    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 760,
        minHeight: 520,
        show: false,
        title: 'HLS R2 Studio',
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    win.once('ready-to-show', () => win.show());

    // Never open new windows. External links will go through openExternalHttps from main only.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.on('will-navigate', (event, url) => {
        if (!isAppUrl(url, location)) {
            event.preventDefault();
            logger.warn('Blocked navigation', { url });
        }
    });

    if (dev && !app.isPackaged && location.devServerUrl) {
        void win.loadURL(location.devServerUrl);
    } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return win;
}
