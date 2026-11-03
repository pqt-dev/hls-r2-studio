import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../testing/memoryStore';
import { handleStartupFailure, STARTUP_ERROR_TITLE } from './startupFailure';

describe('handleStartupFailure', () => {
    it('logs, shows an English dialog without the error text and quits', () => {
        const logger = recordingLogger();
        const showError = vi.fn();
        const quit = vi.fn();

        handleStartupFailure(new Error('Cannot read properties of undefined (reading jobs)'), {
            logger,
            showError,
            quit,
        });

        expect(logger.entries[0]).toMatchObject({ level: 'error', message: 'Startup failed' });
        expect(showError).toHaveBeenCalledWith(STARTUP_ERROR_TITLE, expect.any(String));
        expect(String(showError.mock.calls[0]?.[1])).not.toContain('jobs');
        expect(quit).toHaveBeenCalledTimes(1);
    });

    it('still quits when there is no logger or the dialog / logger throw', () => {
        const quit = vi.fn();

        handleStartupFailure('x', {
            logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: () => {
                    throw new Error('log failed');
                },
            },
            showError: () => {
                throw new Error('no dialog');
            },
            quit,
        });
        handleStartupFailure('x', { logger: null, showError: vi.fn(), quit });

        expect(quit).toHaveBeenCalledTimes(2);
    });
});
