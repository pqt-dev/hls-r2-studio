import { describe, expect, it, vi } from 'vitest';
import { runCollect, runProcess, STDERR_TAIL_LINES } from './runner';

const NODE = process.execPath;
const posixIt = it.skipIf(process.platform === 'win32');

function node(script: string): { command: string; args: string[] } {
    return { command: NODE, args: ['-e', script] };
}

describe('runProcess', () => {
    it('collects stdout and reports the exit code', async () => {
        const result = await runCollect({
            ...node('process.stdout.write("héllo\\n"); process.exit(3)'),
            timeoutMs: 20000,
        });

        expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false });
        expect(result.stdoutText).toBe('héllo\n');
    });

    it('streams stdout chunks and complete stderr lines', async () => {
        const chunks: string[] = [];
        const lines: string[] = [];
        const result = await runProcess({
            ...node('console.log("a=1"); console.error("one"); console.error("two\\rthree")'),
            timeoutMs: 20000,
            onStdout: (c) => chunks.push(c),
            onStderrLine: (l) => lines.push(l),
        });

        expect(chunks.join('')).toBe('a=1\n');
        expect(lines).toEqual(['one', 'two', 'three']);
        expect(result.stdoutText).toBeUndefined();
        expect(result.stderrTail).toEqual(['one', 'two', 'three']);
    });

    it('keeps only the last 200 stderr lines and redacts them', async () => {
        const result = await runProcess({
            ...node(
                'for (let i = 0; i < 300; i++) console.error("line " + i + " Authorization: Bearer abc.def")',
            ),
            timeoutMs: 20000,
        });

        expect(result.stderrTail).toHaveLength(STDERR_TAIL_LINES);
        expect(result.stderrTail[0]).toBe('line 100 Authorization: [REDACTED]');
        expect(result.stderrTail.at(-1)).toContain('line 299');
        expect(result.stderrTail.join('\n')).not.toContain('abc.def');
    });

    it('does not use a shell (metacharacters are plain arguments)', async () => {
        const result = await runCollect({
            command: NODE,
            args: ['-p', 'process.argv[1]', '$(echo hacked); `id` | cat'],
            timeoutMs: 20000,
        });

        expect(result.stdoutText.trim()).toBe('$(echo hacked); `id` | cat');
    });

    it('lowers the priority and survives a failing setPriority', async () => {
        const setPriority = vi.fn(() => {
            throw new Error('EPERM');
        });
        const result = await runProcess({
            ...node('0'),
            timeoutMs: 20000,
            setPriority,
        });

        expect(setPriority).toHaveBeenCalledWith(expect.any(Number), 10);
        expect(result.exitCode).toBe(0);
    });

    posixIt('kills the tree through the injected killer on timeout', async () => {
        const killTree = vi.fn((pid: number) => {
            process.kill(-pid, 'SIGKILL');
        });
        const result = await runProcess({
            ...node('setInterval(() => {}, 1000)'),
            timeoutMs: 300,
            platform: 'linux',
            killTree,
        });

        expect(result.timedOut).toBe(true);
        expect(result.aborted).toBe(false);
        expect(result.exitCode).toBeNull();
        expect(killTree).toHaveBeenCalledTimes(1);
        expect(killTree).toHaveBeenCalledWith(expect.any(Number), 'linux');
    });

    posixIt('kills on abort and does not spawn when already aborted', async () => {
        const killTree = vi.fn((pid: number) => {
            process.kill(-pid, 'SIGKILL');
        });
        const controller = new AbortController();
        const pending = runProcess({
            ...node('setInterval(() => {}, 1000)'),
            timeoutMs: 60000,
            signal: controller.signal,
            platform: 'linux',
            killTree,
        });

        setTimeout(() => controller.abort(), 200);
        const result = await pending;

        expect(result.aborted).toBe(true);
        expect(killTree).toHaveBeenCalledTimes(1);

        const again = await runProcess({
            command: '/definitely/not/a/binary',
            args: [],
            timeoutMs: 1000,
            signal: controller.signal,
        });

        expect(again).toMatchObject({ aborted: true, exitCode: null });
    });

    it('rejects when the binary cannot be started', async () => {
        await expect(
            runProcess({ command: '/definitely/not/a/binary', args: [], timeoutMs: 1000 }),
        ).rejects.toThrow(/Failed to start process/);
    });
});
