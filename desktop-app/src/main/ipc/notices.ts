import { join } from 'node:path';

export type NoticesOutcome = 'opened' | 'not_found' | 'failed';

export interface NoticesDeps {
    isPackaged: boolean;
    /** `process.resourcesPath` of the installed app. */
    resourcesPath: string;
    /** `app.getAppPath()`: the desktop-app folder in development. */
    appPath: string;
    exists: (path: string) => boolean;
    /** Opens the file with the system viewer; resolves to an empty string on success. */
    openPath: (path: string) => Promise<string>;
}

/** Where the third-party notices file lives: next to the app resources, or the repo in dev. */
export function noticesPath(deps: Pick<NoticesDeps, 'isPackaged' | 'resourcesPath' | 'appPath'>) {
    return deps.isPackaged
        ? join(deps.resourcesPath, 'LICENSES', 'THIRD-PARTY-NOTICES.txt')
        : join(deps.appPath, 'LICENSES', 'THIRD-PARTY-NOTICES.txt');
}

export async function openNotices(deps: NoticesDeps): Promise<NoticesOutcome> {
    const path = noticesPath(deps);

    if (!deps.exists(path)) return 'not_found';

    try {
        return (await deps.openPath(path)) === '' ? 'opened' : 'failed';
    } catch {
        return 'failed';
    }
}
