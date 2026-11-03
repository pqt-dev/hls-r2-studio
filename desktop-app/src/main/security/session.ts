import type { Session } from 'electron';
import { buildCsp } from '../../shared/csp';
import type { AppLocation } from './navigation';

/**
 * Sets the CSP response header and denies every permission request AND permission check
 * (so e.g. `navigator.permissions.query` reports nothing as granted).
 */
export function hardenSession(session: Session, dev: boolean, location: AppLocation): void {
    const csp = buildCsp({ dev, devServerOrigin: dev ? location.devServerUrl : undefined });

    session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [csp],
            },
        });
    });

    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
}
