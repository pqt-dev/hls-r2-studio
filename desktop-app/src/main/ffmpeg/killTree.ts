/** Killing a whole process tree: command selection is pure (testable), execution is injectable. */
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export type KillPlan =
    /** Windows: run `taskkill /PID <pid> /T /F`. */
    | { kind: 'spawn'; command: string; args: string[] }
    /** POSIX: SIGKILL the process group (the child was spawned detached, so pgid = pid). */
    | { kind: 'signal-group'; pid: number; signal: 'SIGKILL' };

/** Absolute path of taskkill.exe, so a planted `taskkill` earlier on PATH / in the cwd is never run. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
    return win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

export function planKill(
    platform: NodeJS.Platform,
    pid: number,
    env: NodeJS.ProcessEnv = process.env,
): KillPlan {
    if (platform === 'win32') {
        return {
            kind: 'spawn',
            command: taskkillPath(env),
            args: ['/PID', String(pid), '/T', '/F'],
        };
    }

    return { kind: 'signal-group', pid: -pid, signal: 'SIGKILL' };
}

/** Kills `pid` and all of its descendants. Never throws. */
export type TreeKiller = (pid: number, platform: NodeJS.Platform) => void;

export const defaultTreeKiller: TreeKiller = (pid, platform) => {
    const plan = planKill(platform, pid);

    try {
        if (plan.kind === 'spawn') {
            const killer = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });

            killer.on('error', () => undefined);
        } else {
            process.kill(plan.pid, plan.signal);
        }
    } catch {
        // The process may already be gone (ESRCH); nothing else to do.
    }
};
