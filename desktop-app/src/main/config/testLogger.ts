/** Test helper: a real file logger writing to a temp dir, with its lines readable afterwards. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLogger, type Logger } from '../logger';

export function createFileLoggerForTest(): { logger: Logger; lines: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hls-log-test-'));
    const logger = createFileLogger({ dir, level: 'debug' });

    return {
        logger,
        lines: () => readFileSync(join(dir, 'app.log'), 'utf8').split('\n').filter(Boolean),
    };
}
