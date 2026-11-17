/**
 * Copies text from the renderer (used for the error details). Tries the async Clipboard API
 * first and falls back to a hidden textarea + execCommand, because the main process denies
 * every browser permission request.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(text);

            return true;
        }
    } catch {
        // Fall through to the legacy path.
    }

    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
        return false;
    }

    const scratch = document.createElement('textarea');

    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.className = 'clipboard-scratch';
    document.body.appendChild(scratch);
    scratch.select();

    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        scratch.remove();
    }
}
