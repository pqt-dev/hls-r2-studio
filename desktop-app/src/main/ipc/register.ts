import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { Logger } from '../logger';
import type { IpcHandler } from './handlers';

/**
 * Registers handlers on ipcMain. Calls from frames outside the app are rejected,
 * and handler errors are logged but only a generic message reaches the renderer.
 */
export function registerIpcHandlers(
    handlers: Record<string, IpcHandler>,
    isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
    logger: Logger,
): void {
    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
            if (!isTrustedSender(event)) {
                logger.warn('Rejected IPC call from untrusted sender', { channel });
                throw new Error('Forbidden');
            }
            try {
                return await handler(args);
            } catch (error) {
                logger.error('IPC handler failed', { channel, error });
                throw new Error('Request failed', { cause: error });
            }
        });
    }
}
