/** Spawns child processes (no shell, args array) with a timeout, abort support and a stderr tail. */
import { spawn } from 'node:child_process';
import { constants as osConstants, setPriority as osSetPriority } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { redact } from '../logger/redact';
import { defaultTreeKiller, type TreeKiller } from './killTree';

export const STDERR_TAIL_LINES = 200;
const MAX_LINE_LENGTH = 2000;
const MAX_COLLECTED_STDOUT_BYTES = 8 * 1024 * 1024;
/** Safety net: how long to wait for the pipes to close after the tree has been killed. */
const POST_KILL_GRACE_MS = 5000;

export interface RunProcessInput {
    command: string;
    args: readonly string[];
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Raw stdout chunks (decoded as UTF-8), e.g. the `-progress pipe:1` stream. */
    onStdout?: (chunk: string) => void;
    /** Called for every complete stderr line (already redacted). */
    onStderrLine?: (line: string) => void;
    /** Collect stdout into `stdoutText` (for ffprobe). */
    collectStdout?: boolean;
    platform?: NodeJS.Platform;
    /** Injectable for tests; defaults to taskkill (Windows) / process-group SIGKILL (POSIX). */
    killTree?: TreeKiller;
    /** Injectable for tests; defaults to `os.setPriority`. */
    setPriority?: (pid: number, priority: number) => void;
}

export interface RunResult {
    /** Null when the process was killed by a signal or never started (aborted before spawn). */
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    stdoutText?: string;
    /** Last 200 stderr lines, redacted. */
    stderrTail: string[];
}

/** A bound runner (platform, killer and priority already chosen); this is what steps receive. */
export type ProcessRunner = (input: RunProcessInput) => Promise<RunResult>;

export async function runProcess(input: RunProcessInput): Promise<RunResult> {
    const platform = input.platform ?? process.platform;
    const killTree = input.killTree ?? defaultTreeKiller;
    const setPriority = input.setPriority ?? osSetPriority;

    if (input.signal?.aborted) {
        return {
            exitCode: null,
            signal: null,
            timedOut: false,
            aborted: true,
            stdoutText: input.collectStdout ? '' : undefined,
            stderrTail: [],
        };
    }

    return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
            cwd: input.cwd,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // POSIX: own process group so the whole tree can be killed with one signal.
            detached: platform !== 'win32',
        });

        const tail: string[] = [];
        const stdoutParts: string[] = [];
        let stdoutBytes = 0;
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let graceTimer: NodeJS.Timeout | undefined;

        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let stderrPending = '';

        function pushLine(rawLine: string): void {
            if (rawLine === '') return;
            const line = redact(rawLine.slice(0, MAX_LINE_LENGTH));
            tail.push(line);
            if (tail.length > STDERR_TAIL_LINES) tail.shift();
            input.onStderrLine?.(line);
        }

        function drainStderr(text: string, final: boolean): void {
            // ffmpeg separates progress updates with a lone '\r'.
            const parts = (stderrPending + text).split(/\r\n|\n|\r/);
            stderrPending = final ? '' : (parts.pop() ?? '');
            for (const part of parts) pushLine(part);
        }

        function kill(): void {
            if (child.pid !== undefined) killTree(child.pid, platform);
            graceTimer ??= setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
            }, POST_KILL_GRACE_MS);
        }

        const timeout = setTimeout(() => {
            timedOut = true;
            kill();
        }, input.timeoutMs);

        function onAbort(): void {
            aborted = true;
            kill();
        }

        input.signal?.addEventListener('abort', onAbort, { once: true });

        function finish(result: () => RunResult): void {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (graceTimer) clearTimeout(graceTimer);
            input.signal?.removeEventListener('abort', onAbort);
            resolve(result());
        }

        child.stdout.on('data', (chunk: Buffer) => {
            const text = stdoutDecoder.write(chunk);
            if (text === '') return;
            input.onStdout?.(text);
            if (input.collectStdout && stdoutBytes < MAX_COLLECTED_STDOUT_BYTES) {
                stdoutParts.push(text);
                stdoutBytes += text.length;
            }
        });

        child.stderr.on('data', (chunk: Buffer) => {
            drainStderr(stderrDecoder.write(chunk), false);
        });

        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (graceTimer) clearTimeout(graceTimer);
            input.signal?.removeEventListener('abort', onAbort);
            reject(new Error(`Failed to start process: ${error.message}`));
        });

        child.once('close', (exitCode, exitSignal) => {
            drainStderr(stderrDecoder.end(), true);
            const rest = stdoutDecoder.end();
            if (rest !== '') {
                input.onStdout?.(rest);
                if (input.collectStdout) stdoutParts.push(rest);
            }
            finish(() => ({
                exitCode,
                signal: exitSignal,
                timedOut,
                aborted,
                stdoutText: input.collectStdout ? stdoutParts.join('') : undefined,
                stderrTail: tail,
            }));
        });

        if (child.pid !== undefined) {
            try {
                setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
            } catch {
                // Lowering the priority is best effort (e.g. the process already exited).
            }
        }
    });
}

/** Convenience for ffprobe-style calls: always returns the collected stdout text. */
export async function runCollect(
    input: Omit<RunProcessInput, 'collectStdout'>,
): Promise<RunResult & { stdoutText: string }> {
    const result = await runProcess({ ...input, collectStdout: true });

    return { ...result, stdoutText: result.stdoutText ?? '' };
}

/** Binds platform/killer defaults into a {@link ProcessRunner}. */
export function createRunner(
    defaults: Pick<RunProcessInput, 'platform' | 'killTree' | 'setPriority'> = {},
): ProcessRunner {
    return (input) => runProcess({ ...defaults, ...input });
}
