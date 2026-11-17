export interface CspOptions {
    /** Development mode relaxes the policy just enough for the Vite dev server (HMR). */
    dev: boolean;
    /** Origin of the Vite dev server, e.g. http://localhost:5173. Only used when `dev` is true. */
    devServerOrigin?: string;
}

/**
 * Builds the Content-Security-Policy string.
 * The renderer never talks to the network (connect-src stays local): only the main process
 * does. The one exception is `<img>` thumbnails from the CDN (img-src https:).
 */
export function buildCsp({ dev, devServerOrigin }: CspOptions): string {
    const connect = ["'self'"];
    const script = ["'self'"];
    const style = ["'self'"];

    if (dev) {
        // The Vite React plugin injects an inline preamble script and inline <style> tags in dev.
        script.push("'unsafe-inline'");
        style.push("'unsafe-inline'");
        if (devServerOrigin) {
            const url = new URL(devServerOrigin);
            connect.push(devServerOrigin, `ws://${url.host}`);
        }
    }

    return [
        "default-src 'self'",
        `script-src ${script.join(' ')}`,
        `style-src ${style.join(' ')}`,
        // https: only for the video thumbnails served from the R2 CDN (`<img>` loads).
        "img-src 'self' data: https:",
        `connect-src ${connect.join(' ')}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}
