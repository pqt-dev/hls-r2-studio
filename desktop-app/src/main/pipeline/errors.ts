/** Typed pipeline failure. `message` is safe English text for the UI (no absolute user paths). */
import type { JobState } from '../../shared/types';
import type { RegisterPayload } from './register';

export type PipelineErrorKind = 'cancelled' | 'failed' | 'register_failed' | 'needs_sign_in';

export interface PipelineErrorInit {
    kind: PipelineErrorKind;
    step: JobState;
    message: string;
    exitCode?: number | null;
    stderrTail?: string[];
    registerPayload?: RegisterPayload;
    prefix?: string | null;
    /**
     * True only when the site answered with a code that proves the video can never be registered
     * (`playlist_not_found`, `public_id_conflict`). Only then may the R2 files be deleted.
     */
    definitive?: boolean;
    cause?: unknown;
}

export class PipelineError extends Error {
    readonly kind: PipelineErrorKind;
    readonly step: JobState;
    readonly exitCode: number | null;
    stderrTail: string[];
    /** Set for register_failed / needs_sign_in so register can be retried without re-uploading. */
    registerPayload: RegisterPayload | undefined;
    prefix: string | null;
    readonly definitive: boolean;

    constructor(init: PipelineErrorInit) {
        super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
        this.name = 'PipelineError';
        this.kind = init.kind;
        this.step = init.step;
        this.exitCode = init.exitCode ?? null;
        this.stderrTail = init.stderrTail ?? [];
        this.registerPayload = init.registerPayload;
        this.prefix = init.prefix ?? null;
        this.definitive = init.definitive ?? false;
    }
}

export function isCancelled(error: unknown): error is PipelineError {
    return error instanceof PipelineError && error.kind === 'cancelled';
}

export function cancelledError(step: JobState): PipelineError {
    return new PipelineError({ kind: 'cancelled', step, message: 'The job was cancelled.' });
}

/** Replaces the given absolute paths in each line with placeholders (longest path first). */
export function scrubPaths(
    lines: readonly string[],
    replacements: readonly { path: string; label: string }[],
): string[] {
    const sorted = replacements
        .filter((r) => r.path.length > 2)
        .sort((a, b) => b.path.length - a.path.length);

    return lines.map((line) => {
        let out = line;
        for (const { path, label } of sorted) {
            const variants = new Set([path, path.replace(/\\/g, '/'), path.replace(/\//g, '\\')]);
            for (const variant of variants) out = out.split(variant).join(label);
        }

        return out;
    });
}
