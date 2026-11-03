import type { IpcMainInvokeEvent } from 'electron';
import { isAppUrl, type AppLocation } from '../security/navigation';

/** Minimal view of the main window's web contents. */
export interface TrustedContents {
    mainFrame: unknown;
}

/**
 * Accepts an IPC call only when it comes from the top frame of the app window, and that frame
 * shows the app's own page (never a remote or sub frame).
 */
export function createSenderGuard(
    getMainContents: () => (TrustedContents & object) | null,
    location: AppLocation,
): (event: IpcMainInvokeEvent) => boolean {
    return (event) => {
        const contents = getMainContents();

        if (contents === null) return false;

        const frame = event.senderFrame;

        return (
            (event.sender as unknown) === contents &&
            frame !== null &&
            frame !== undefined &&
            (frame as unknown) === contents.mainFrame &&
            isAppUrl(frame.url, location)
        );
    };
}
