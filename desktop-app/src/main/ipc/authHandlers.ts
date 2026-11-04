import { isAbsolute } from 'node:path';
import { IpcChannels } from '../../shared/ipc';
import type {
    AuthState,
    PickDirectoryResult,
    SettingsDto,
    SettingsPatch,
    SettingsResult,
} from '../../shared/ipc';
import type { IpcHandler } from './handlers';
import {
    expectBoolean,
    expectInt,
    expectNoArgs,
    expectSingleObject,
    expectString,
} from './validate';

export interface AuthHandlerDeps {
    auth: {
        getState(): AuthState;
        login(username: string, password: string, staySignedIn?: boolean): Promise<AuthState>;
        logout(): Promise<AuthState>;
        reloadConfig(): Promise<AuthState>;
    };
    settings: {
        get(): SettingsDto;
        set(patch: SettingsPatch): Promise<SettingsResult>;
    };
    /** Native folder dialog; null when the user cancelled. */
    pickDirectory: () => Promise<string | null>;
}

/** Shape check of `settings:set`. Value rules (https, writable folder) live in the service. */
export function parseSettingsPatch(args: readonly unknown[]): SettingsPatch {
    const object = expectSingleObject(args, 'settings', ['tmpRoot', 'maxConcurrent']);
    const patch: SettingsPatch = {};

    if (object['tmpRoot'] !== undefined)
        patch.tmpRoot = expectString(object['tmpRoot'], 'tmpRoot', 4096);
    if (object['maxConcurrent'] !== undefined) {
        patch.maxConcurrent = expectInt(object['maxConcurrent'], 'maxConcurrent', -1000, 1000);
    }

    return patch;
}

/** The site is fixed at build time: the renderer cannot send (or even name) a server here. */
export function parseLogin(args: readonly unknown[]): {
    username: string;
    password: string;
    staySignedIn: boolean;
} {
    const object = expectSingleObject(args, 'login', ['username', 'password', 'staySignedIn']);

    return {
        username: expectString(object['username'], 'username', 256),
        password: expectString(object['password'], 'password', 1024),
        staySignedIn:
            object['staySignedIn'] === undefined
                ? true
                : expectBoolean(object['staySignedIn'], 'staySignedIn'),
    };
}

export function createAuthHandlers(deps: AuthHandlerDeps): Record<string, IpcHandler> {
    return {
        [IpcChannels.authGetState]: (args) => {
            expectNoArgs(args);

            return deps.auth.getState();
        },
        [IpcChannels.authLogin]: (args) => {
            const { username, password, staySignedIn } = parseLogin(args);

            return deps.auth.login(username, password, staySignedIn);
        },
        [IpcChannels.authLogout]: (args) => {
            expectNoArgs(args);

            return deps.auth.logout();
        },
        [IpcChannels.authReloadConfig]: (args) => {
            expectNoArgs(args);

            return deps.auth.reloadConfig();
        },
        [IpcChannels.settingsGet]: (args) => {
            expectNoArgs(args);

            return deps.settings.get();
        },
        [IpcChannels.settingsSet]: (args) => deps.settings.set(parseSettingsPatch(args)),
        [IpcChannels.settingsPickDirectory]: async (args): Promise<PickDirectoryResult> => {
            expectNoArgs(args);

            const picked = await deps.pickDirectory();

            // Only an absolute path from our own dialog is handed back; settings.set validates it
            // again (writable folder) when the renderer saves it.
            if (picked === null || picked === '' || !isAbsolute(picked)) return { canceled: true };

            return { canceled: false, path: picked };
        },
    };
}
