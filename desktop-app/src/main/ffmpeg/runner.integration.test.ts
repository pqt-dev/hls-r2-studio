import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCollect, runProcess } from './runner';

const posix = process.platform !== 'win32';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

async function waitDead(pid: number): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
        if (!isAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }

    return false;
}

// A parent that spawns a long-running grandchild and prints the grandchild pid.
const TREE_SCRIPT = `
const { spawn } = require('node:child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(gc.pid);
setInterval(() => {}, 1000);
`;

describe.skipIf(!posix)('runProcess process-tree kill (POSIX process group)', () => {
    it('kills the child and its grandchild on abort', async () => {
        const controller = new AbortController();
        let grandchild = 0;
        const pending = runProcess({
            command: process.execPath,
            args: ['-e', TREE_SCRIPT],
            timeoutMs: 60000,
            signal: controller.signal,
            onStdout: (chunk) => {
                grandchild = Number(chunk.trim());
                controller.abort();
            },
        });
        const result = await pending;

        expect(result.aborted).toBe(true);
        expect(grandchild).toBeGreaterThan(0);
        expect(await waitDead(grandchild)).toBe(true);
    }, 30000);

    it('kills the whole tree on timeout', async () => {
        let grandchild = 0;
        const result = await runCollect({
            command: process.execPath,
            args: ['-e', TREE_SCRIPT],
            timeoutMs: 1500,
            onStdout: (chunk) => {
                grandchild = Number(chunk.trim());
            },
        });

        expect(result.timedOut).toBe(true);
        expect(grandchild).toBeGreaterThan(0);
        expect(await waitDead(grandchild)).toBe(true);
        expect(spawnSync('ps', ['-p', String(grandchild)]).status).not.toBe(0);
    }, 30000);
});
