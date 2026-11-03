import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
    debug(message: string, meta?: unknown): void;
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
}

export interface FileLoggerOptions {
    /** Directory that holds the log files (app.getPath('userData')/logs). */
    dir: string;
    /** Base file name. Rotated files are `<name>.1`, `<name>.2`, ... Default `app.log`. */
    fileName?: string;
    /** Total number of files kept, including the active one. Default 5. */
    maxFiles?: number;
    /** Rotate when the active file would exceed this size. Default 1 MB. */
    maxBytes?: number;
    /** Minimum level written. Default `info`. */
    level?: LogLevel;
    /** Home directory to mask as `~`. Defaults to os.homedir(). */
    homeDir?: string;
    /** Clock, injectable for tests. */
    now?: () => Date;
}

/** Synchronous rotating file logger. Every message and metadata value goes through redact(). */
export function createFileLogger(options: FileLoggerOptions): Logger {
    const {
        dir,
        fileName = 'app.log',
        maxFiles = 5,
        maxBytes = 1024 * 1024,
        level = 'info',
        homeDir,
        now = () => new Date(),
    } = options;

    const activePath = join(dir, fileName);
    let size = 0;
    let ready = false;

    function init(): void {
        mkdirSync(dir, { recursive: true });
        try {
            size = statSync(activePath).size;
        } catch {
            size = 0;
        }
        ready = true;
    }

    function rotate(): void {
        rmSync(`${activePath}.${maxFiles - 1}`, { force: true });
        for (let i = maxFiles - 2; i >= 1; i--) {
            try {
                renameSync(`${activePath}.${i}`, `${activePath}.${i + 1}`);
            } catch {
                // Missing file: nothing to shift.
            }
        }
        if (maxFiles > 1) {
            try {
                renameSync(activePath, `${activePath}.1`);
            } catch {
                // Active file does not exist yet.
            }
        } else {
            rmSync(activePath, { force: true });
        }
        size = 0;
    }

    function write(lvl: LogLevel, message: string, meta?: unknown): void {
        if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
        try {
            if (!ready) init();
            const redactOptions = { homeDir };
            let line = `${now().toISOString()} ${lvl.toUpperCase()} ${redact(message, redactOptions)}`;
            if (meta !== undefined) {
                line += ` ${JSON.stringify(redact(meta, redactOptions))}`;
            }
            line += '\n';
            const bytes = Buffer.byteLength(line);
            if (size > 0 && size + bytes > maxBytes) rotate();
            appendFileSync(activePath, line);
            size += bytes;
        } catch {
            // Logging must never crash the app.
        }
    }

    return {
        debug: (message, meta) => write('debug', message, meta),
        info: (message, meta) => write('info', message, meta),
        warn: (message, meta) => write('warn', message, meta),
        error: (message, meta) => write('error', message, meta),
    };
}
