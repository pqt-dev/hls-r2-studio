/** Typed pipeline failure. `message` is safe English text for the UI (no absolute user paths). */
import type { JobState } from '../../shared/types';
import type { RegisterPayload } from './register';

export type PipelineErrorKind =
    | 'cancelled'
    | 'failed'
    | 'register_failed'
    | 'needs_sign_in'
    /**
     * The network stayed down for the whole stall budget while uploading. The R2 objects and the
     * temp dir are kept (`resumable`), so `resumeUpload` can continue without transcoding again.
     */
    | 'upload_interrupted';

/** `PipelineError.code` of a resume that cannot work because the kept temp files are gone. */
export const RESUME_UNAVAILABLE = 'resume_unavailable';

export const UPLOAD_INTERRUPTED_MESSAGE =
    'Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.';

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
    /** Machine readable reason, e.g. {@link RESUME_UNAVAILABLE}. */
    code?: string;
    /** True when the upload can be continued with `resumeUpload` (kind `upload_interrupted`). */
    resumable?: boolean;
    /** Kept temp directory of a resumable failure. */
    tmpDir?: string | null;
    cause?: unknown;
}

export class PipelineError extends Error {
    readonly kind: PipelineErrorKind;
    readonly step: JobState;
    readonly exitCode: number | null;
    stderrTail: string[];
    /** Set for register_failed / needs_sign_in / upload_interrupted so register can be retried without re-uploading. */
    registerPayload: RegisterPayload | undefined;
    prefix: string | null;
    readonly definitive: boolean;
    readonly code: string | null;
    /** Set (by runPipeline / resumeUpload) for `upload_interrupted`; `registerPayload` is set too. */
    resumable: boolean;
    tmpDir: string | null;

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
        this.code = init.code ?? null;
        this.resumable = init.resumable ?? false;
        this.tmpDir = init.tmpDir ?? null;
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

export function uploadInterruptedError(): PipelineError {
    return new PipelineError({
        kind: 'upload_interrupted',
        step: 'uploading',
        message: UPLOAD_INTERRUPTED_MESSAGE,
        resumable: true,
    });
}
