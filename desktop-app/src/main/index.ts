import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, rm, stat } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { app, dialog, safeStorage, session } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DiagnosticsDto, FfmpegDiagnostics } from '../shared/ipc';
import { createSiteClient } from './api/siteClient';
import { getBuiltInSiteUrl } from './api/siteUrl';
import { createAuthService, type AuthService } from './auth/authService';
import { createConfigService } from './config/configService';
import { resolveBinaries } from './ffmpeg/binaries';
import { createRunner } from './ffmpeg/runner';
import { checkFfmpeg, createFfmpegTextRunner } from './ffmpeg/selfCheck';
import { createHandlers } from './ipc/handlers';
import { createElectronAdapters } from './ipc/electronAdapters';
import { openNotices } from './ipc/notices';
import { wirePushEvents } from './ipc/pushEvents';
import { registerIpcHandlers } from './ipc/register';
import { createSenderGuard } from './ipc/senderGuard';
import { createQuitCoordinator } from './lifecycle/quitCoordinator';
import { createFileLogger, type Logger } from './logger';
import { handleStartupFailure } from './lifecycle/startupFailure';
import { createDefaultDeps } from './pipeline/defaultDeps';
import { generatePublicId } from './pipeline/publicId';
import { resumeUpload } from './pipeline/resumeUpload';
import { retryRegister, runPipeline } from './pipeline/runPipeline';
import { deleteR2Prefix } from './pipeline/steps/cleanup';
import { JobQueue } from './queue/jobQueue';
import { createSafeStorageBackend, TokenVault } from './secure';
import { createSettingsService } from './settings/settingsService';
import { createAppStore } from './store';
import { hardenSession } from './security/session';
import { createMainWindow, getAppLocation } from './window';

const dev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let startupLogger: Logger | null = null;

// Single instance: a second launch focuses the existing window and exits.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    void app
        .whenReady()
        .then(bootstrap)
        .catch((error: unknown) => {
            mainWindow?.destroy();
            mainWindow = null;
            handleStartupFailure(error, {
                logger: startupLogger,
                showError: (title, content) => dialog.showErrorBox(title, content),
                quit: () => app.exit(1),
            });
        });

    app.on('window-all-closed', () => {
        app.quit();
    });
}

async function bootstrap(): Promise<void> {
    const userData = app.getPath('userData');
    const logsDir = join(userData, 'logs');
    const logger = createFileLogger({ dir: logsDir });

    startupLogger = logger;
    const version = app.getVersion();

    logger.info('App starting', { version, dev });

    const store = createAppStore({
        dir: userData,
        defaultTmpRoot: join(app.getPath('temp'), 'hls-r2-studio'),
        onError: (error) => logger.error('Store write failed', { error }),
    });

    await store.load();

    // The site is fixed at build time (HLS_SITE_URL); nothing at runtime can change it.
    const siteUrl = getBuiltInSiteUrl(dev);

    if (siteUrl === null) logger.error('No valid built-in site URL; sign-in is disabled');

    const tokenVault = new TokenVault({
        dir: userData,
        backend: createSafeStorageBackend(safeStorage),
    });

    // ---- site API, auth, config ----
    let auth: AuthService | null = null;

    const siteClient = createSiteClient({
        // Node/Undici fetch of the main process; redirects are never followed by the client.
        fetch: (input, init) => fetch(input, init),
        getBaseUrl: () => siteUrl ?? '',
        getToken: () => tokenVault.get(),
        userAgent: `HLS-R2-Studio/${version} (${platform()})`,
        allowInsecureLocalhost: dev,
        onUnauthorized: () => auth?.handleUnauthorized(),
        logger,
    });
    const config = createConfigService(siteClient);

    auth = createAuthService({
        client: siteClient,
        vault: tokenVault,
        store,
        config,
        hostname,
        siteUrl,
        allowInsecureLocalhost: dev,
        logger,
    });

    // ---- ffmpeg ----
    const binaries = resolveBinaries({
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        env: process.env,
        isPackaged: app.isPackaged,
    });
    let ffmpeg: FfmpegDiagnostics = { checked: false, ok: false, version: null, missing: [] };

    // ---- queue ----
    const queue = new JobQueue({
        store,
        runPipelineFn: runPipeline,
        retryRegisterFn: retryRegister,
        resumeUploadFn: resumeUpload,
        deletePrefixFn: deleteR2Prefix,
        // Fresh deps per run so a changed temp folder applies to the next job.
        getDeps: () =>
            createDefaultDeps({
                binaries,
                tmpRoot: store.get().settings.tmpRoot,
                register: siteClient,
                logger,
            }),
        getConfig: () => config.getConfig(),
        getAuthState: () => auth?.getState() ?? { status: 'signed_out' },
        hasSession: () => tokenVault.get() !== null,
        subscribeAuth: (listener) => auth?.subscribe(listener) ?? (() => undefined),
        getStartBlock: () => {
            if (!ffmpeg.checked) return 'Checking the video tools...';
            if (!ffmpeg.ok) {
                return 'The bundled video tools (ffmpeg) are missing or incomplete, so videos cannot be processed.';
            }

            return null;
        },
        fs: {
            stat: (path) => stat(path),
            rm: (path) => rm(path, { recursive: true, force: true }),
        },
        now: () => new Date(),
        generateId: randomUUID,
        generatePublicId: () => generatePublicId(),
        platform: process.platform,
        logger,
    });

    await queue.recover();

    const settings = createSettingsService({
        store,
        getSiteUrl: () => siteUrl ?? '',
        hasActiveJobs: () => queue.hasActiveJobs(),
        hasPausedUploads: () => queue.hasPausedUploads(),
        ensureDir: async (path) => {
            await mkdir(path, { recursive: true });
            await access(path, constants.W_OK);
        },
        onChanged: () => queue.kick(),
    });

    // ---- IPC ----
    const appLocation = getAppLocation(app.isPackaged);
    const adapters = createElectronAdapters(() => mainWindow, logsDir);

    hardenSession(session.defaultSession, dev, appLocation);
    registerIpcHandlers(
        createHandlers({
            getAppVersion: () => version,
            getDiagnostics: (): DiagnosticsDto => ({
                appVersion: version,
                platform: `${process.platform} ${process.arch}`,
                ffmpeg,
            }),
            openLogsFolder: () => adapters.openLogsFolder(),
            openNotices: () =>
                openNotices({
                    isPackaged: app.isPackaged,
                    resourcesPath: process.resourcesPath,
                    appPath: app.getAppPath(),
                    exists: existsSync,
                    openPath: (path) => adapters.openPath(path),
                }),
            pickDirectory: () => adapters.pickDirectory(),
            auth,
            settings,
            queue,
            getSiteUrl: () => auth?.getSiteUrl(),
            pickVideoFiles: () => adapters.pickVideoFiles(),
            writeClipboard: (text) => adapters.writeClipboard(text),
            openExternal: (url) => adapters.openExternal(url),
        }),
        createSenderGuard(() => mainWindow?.webContents ?? null, appLocation),
        logger,
    );
    wirePushEvents({ auth, queue }, (channel, payload) => adapters.send(channel, payload));

    // ---- window and quit flow ----
    const quitFlow = createQuitCoordinator({
        hasActiveJobs: () => queue.hasActiveJobs(),
        confirm: () => adapters.confirmQuit(),
        shutdown: () => queue.shutdown(),
        flush: () => store.flush(),
        quit: () => app.quit(),
        onError: (error) => logger.error('Shutdown failed', { error }),
    });

    mainWindow = createMainWindow(dev, logger);
    mainWindow.on('close', (event) => quitFlow.handleWindowClose(event, () => mainWindow?.close()));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    app.on('before-quit', (event) => quitFlow.handleBeforeQuit(event));

    // ---- background startup work ----
    void auth
        .restore()
        .catch((error: unknown) => logger.error('Session restore failed', { error }));

    void checkFfmpeg(createFfmpegTextRunner(createRunner(), binaries.ffmpeg))
        .then((result) => {
            ffmpeg = {
                checked: true,
                ok: result.ok,
                version: result.version,
                missing: result.missing,
            };

            if (result.ok) logger.info('ffmpeg self-check passed', { version: result.version });
            else logger.error('ffmpeg self-check failed', { missing: result.missing });
        })
        .catch((error: unknown) => {
            ffmpeg = { checked: true, ok: false, version: null, missing: ['ffmpeg:run'] };
            logger.error('ffmpeg self-check crashed', { error });
        })
        .finally(() => queue.kick());
}
