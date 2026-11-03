/** Everything the pipeline needs from the outside world. No Electron, no global state. */
import type { S3Client } from '@aws-sdk/client-s3';
import type { AppConfigR2 } from '../../shared/appConfig';
import type { Binaries } from '../ffmpeg/binaries';
import type { ProcessRunner } from '../ffmpeg/runner';
import type { Logger } from '../logger';
import type { S3ClientPurpose } from './steps/s3Client';
import type { RegisterPayload } from './register';

export interface RegisteredVideo {
    id: number;
    public_id: string;
    embed_url: string;
}

/**
 * Calls `POST /api/app/videos` (implemented in B4). On failure it MUST throw a
 * {@link RegisterRequestError} so the B2 `mapRegisterError` can classify it.
 */
export interface RegisterClient {
    register(payload: RegisterPayload): Promise<RegisteredVideo>;
}

export interface PipelineDeps {
    binaries: Binaries;
    /** Spawns a child process (kill-tree/priority already bound). */
    run: ProcessRunner;
    /** The caller must `destroy()` the client when done. */
    createS3Client: (r2: AppConfigR2, purpose?: S3ClientPurpose) => S3Client;
    register: RegisterClient;
    /** Parent folder of the per-job temp directories (`<tmpRoot>/<publicId>/`). */
    tmpRoot: string;
    now: () => Date;
    /** Waits `ms`; resolves early when the signal aborts. */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Free bytes on the volume that holds `dir`. */
    freeBytes: (dir: string) => Promise<number>;
    logger: Logger;
    /** Optional encoder thread limit (PHP `FFMPEG_THREADS`). */
    threads?: number | null;
}

export interface PipelineJob {
    id: string;
    sourcePath: string;
    filename: string;
    publicId: string;
}
