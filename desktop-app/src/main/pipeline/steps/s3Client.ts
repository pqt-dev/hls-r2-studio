import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfigR2 } from '../../../shared/appConfig';

const noop = (): void => undefined;

/**
 * `upload`: PutObject with a streaming body, which the SDK cannot replay, so it never retries
 * (the app has its own withRetry). `cleanup`: list/delete calls are replayable, so the SDK's
 * normal retries (3 attempts) apply.
 */
export type S3ClientPurpose = 'upload' | 'cleanup';

/** A connection that cannot be opened within this time fails with a (network) TimeoutError. */
export const CONNECTION_TIMEOUT_MS = 15_000;
/**
 * Socket inactivity timeout: a stalled connection (no bytes in either direction) fails with a
 * TimeoutError instead of hanging forever. Unlike `requestTimeout` (total time, which only warns
 * unless `throwOnRequestTimeout` is set) it never cuts a slow but moving upload short.
 */
export const SOCKET_TIMEOUT_MS = 60_000;

const MAX_ATTEMPTS: Record<S3ClientPurpose, number> = { upload: 1, cleanup: 3 };

/**
 * S3 client for Cloudflare R2: region `auto`, path-style addressing, credentials from the config
 * (RAM only). Request/response checksums are only computed when the API requires them, because
 * R2 does not accept the SDK's newer default CRC32 trailer encoding on streamed uploads.
 */
export function createR2Client(r2: AppConfigR2, purpose: S3ClientPurpose = 'upload'): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: r2.endpoint,
        forcePathStyle: true,
        maxAttempts: MAX_ATTEMPTS[purpose],
        credentials: { accessKeyId: r2.access_key_id, secretAccessKey: r2.secret_access_key },
        requestHandler: {
            connectionTimeout: CONNECTION_TIMEOUT_MS,
            socketTimeout: SOCKET_TIMEOUT_MS,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        // The SDK would print to the console (e.g. "non-retryable streaming request"); errors are
        // surfaced through the thrown exceptions and our own logger instead.
        logger: { debug: noop, info: noop, warn: noop, error: noop },
    });
}
