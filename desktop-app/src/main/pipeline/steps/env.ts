/** Shared context and helpers for the pipeline steps. */
import type { JobState } from '../../../shared/types';
import type { ProcessRunner, RunResult } from '../../ffmpeg/runner';
import type { Logger } from '../../logger';
import { PipelineError, cancelledError } from '../errors';

export interface StepEnv {
    run: ProcessRunner;
    ffmpeg: string;
    ffprobe: string;
    /** Job temp directory; every child process runs here and uses relative file names. */
    cwd: string;
    signal: AbortSignal;
    logger: Logger;
    /** Job state reported in errors raised by the step. */
    step: JobState;
}

export type Tool = 'ffmpeg' | 'ffprobe';

export interface ExecOptions {
    onStdout?: (chunk: string) => void;
    collectStdout?: boolean;
}

export function throwIfAborted(env: Pick<StepEnv, 'signal' | 'step'>): void {
    if (env.signal.aborted) throw cancelledError(env.step);
}

/**
 * Runs a tool in the job directory. Throws a `cancelled` PipelineError when the job was aborted;
 * otherwise returns the result (the caller decides what a non-zero exit or a timeout means).
 */
export async function exec(
    env: StepEnv,
    tool: Tool,
    args: readonly string[],
    timeoutMs: number,
    options: ExecOptions = {},
): Promise<RunResult> {
    throwIfAborted(env);

    const result = await env.run({
        command: tool === 'ffmpeg' ? env.ffmpeg : env.ffprobe,
        args,
        cwd: env.cwd,
        timeoutMs,
        signal: env.signal,
        onStdout: options.onStdout,
        collectStdout: options.collectStdout,
    });

    if (result.aborted || env.signal.aborted) throw cancelledError(env.step);

    return result;
}

export function succeeded(result: RunResult): boolean {
    return result.exitCode === 0 && !result.timedOut;
}

/** Short, path-free description of a failed run, for logs and error messages. */
export function describeFailure(tool: Tool, result: RunResult): string {
    if (result.timedOut) return `${tool} timed out`;

    return `${tool} exited with code ${result.exitCode ?? 'unknown'}`;
}

export function failed(
    env: Pick<StepEnv, 'step'>,
    message: string,
    result?: RunResult,
): PipelineError {
    return new PipelineError({
        kind: 'failed',
        step: env.step,
        message,
        exitCode: result?.exitCode ?? null,
        stderrTail: result?.stderrTail ?? [],
    });
}
