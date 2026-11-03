export type ExternalOpener = (url: string) => Promise<void>;

/**
 * Opens a URL in the default browser, but only when it is a plain https URL.
 * Returns true when the URL was handed to the opener.
 */
export async function openExternalHttps(url: string, opener: ExternalOpener): Promise<boolean> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
        return false;
    }
    await opener(parsed.toString());
    return true;
}
