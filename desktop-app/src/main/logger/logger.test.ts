import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLogger } from './logger';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hls-logger-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-01-02T03:04:05.000Z');

describe('file logger', () => {
    it('writes lines with level and redacted content', () => {
        const logger = createFileLogger({ dir, homeDir: '/Users/bob', now: fixedNow });
        logger.info('open /Users/bob/a.mp4', { token: 'abc', n: 1 });
        const text = readFileSync(join(dir, 'app.log'), 'utf8');
        expect(text).toBe(
            '2026-01-02T03:04:05.000Z INFO open ~/a.mp4 {"token":"[REDACTED]","n":1}\n',
        );
    });

    it('respects the minimum level', () => {
        const logger = createFileLogger({ dir, level: 'warn' });
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        const lines = readFileSync(join(dir, 'app.log'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('WARN w');
        expect(lines[1]).toContain('ERROR e');
    });

    it('rotates by size and keeps at most maxFiles files', () => {
        const logger = createFileLogger({ dir, maxBytes: 200, maxFiles: 3 });
        for (let i = 0; i < 40; i++) logger.info(`message number ${i} ${'x'.repeat(30)}`);
        const files = readdirSync(dir).sort();
        expect(files).toEqual(['app.log', 'app.log.1', 'app.log.2']);
        for (const f of files) {
            expect(readFileSync(join(dir, f), 'utf8').length).toBeLessThanOrEqual(200);
        }
        // The newest message is in the active file, older ones in rotated files.
        expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('message number 39');
        expect(readFileSync(join(dir, 'app.log.1'), 'utf8')).not.toContain('message number 39');
    });

    it('continues appending to an existing file after restart', () => {
        createFileLogger({ dir }).info('first');
        createFileLogger({ dir }).info('second');
        const lines = readFileSync(join(dir, 'app.log'), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });

    it('never throws when the directory is unusable', () => {
        const blocker = join(dir, 'blocker');
        writeFileSync(blocker, 'a file, not a directory');
        const logger = createFileLogger({ dir: join(blocker, 'sub') });
        expect(() => logger.error('still fine')).not.toThrow();
    });
});
