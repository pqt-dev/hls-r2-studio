export interface AppLocation {
    /** Dev server origin (http://localhost:5173) when running with the Vite dev server. */
    devServerUrl?: string;
    /** file:// URL of the packaged renderer index.html. */
    indexFileUrl?: string;
}

/** True only for URLs that belong to the app itself (dev server origin or the packaged index.html). */
export function isAppUrl(target: string, location: AppLocation): boolean {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return false;
    }

    if (location.devServerUrl) {
        try {
            if (url.origin === new URL(location.devServerUrl).origin) return true;
        } catch {
            // Ignore a malformed dev server URL.
        }
    }

    if (location.indexFileUrl) {
        try {
            const index = new URL(location.indexFileUrl);
            if (url.protocol === 'file:' && url.pathname === index.pathname) return true;
        } catch {
            // Ignore a malformed index URL.
        }
    }

    return false;
}

export interface AppLocationInput {
    isPackaged: boolean;
    /** Value of `ELECTRON_RENDERER_URL`. Ignored completely in a packaged app. */
    rendererUrlEnv: string | undefined;
    indexFileUrl: string;
}

/** Builds the allow-list of app URLs; the dev server URL is only honored when not packaged. */
export function buildAppLocation(input: AppLocationInput): AppLocation {
    const location: AppLocation = { indexFileUrl: input.indexFileUrl };

    if (!input.isPackaged && input.rendererUrlEnv) location.devServerUrl = input.rendererUrlEnv;

    return location;
}
