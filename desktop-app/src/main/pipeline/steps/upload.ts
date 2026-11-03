/** R2 upload (spec 4.4 step 6): 5 concurrent PutObject streams, playlist.m3u8 strictly last. */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from '../../logger';
import { PLAYLIST_FILE } from '../fileNames';
import { PipelineError, cancelledError } from '../errors';
import { runPool } from '../pool';
import {
    UPLOAD_CONCURRENCY,
    UPLOAD_RETRY_DELAYS_MS,
    contentTypeFor,
    listUploadFiles,
    objectKey,
    progressFromUploaded,
    withRetry,
} from '../upload/plan';

export interface UploadInput {
    client: S3Client;
    bucket: string;
    prefix: string;
    /** Job directory holding the output files. */
    dir: string;
    signal: AbortSignal;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    logger: Logger;
    /** Upload stage fraction (files done / total), never decreasing. */
    onProgress: (fraction: number) => void;
    /** Called once, right before the first PutObject is sent (R2 may now hold objects). */
    onUploadStarted: () => void;
    /** Called once, after the playlist (the last file) was uploaded. */
    onPlaylistUploaded: () => void;
}

export interface UploadResult {
    /** Names of the uploaded files, playlist last. */
    files: string[];
}

export async function uploadDirectory(input: UploadInput): Promise<UploadResult> {
    const names = listUploadFiles(await readdir(input.dir));

    if (!names.includes(PLAYLIST_FILE)) {
        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message: 'The playlist file is missing, so nothing can be uploaded.',
        });
    }

    const sizes = new Map<string, number>();

    for (const name of names) sizes.set(name, (await stat(join(input.dir, name))).size);

    const others = names.filter((n) => n !== PLAYLIST_FILE);
    let done = 0;
    let started = false;

    function markStarted(): void {
        if (started) return;
        started = true;
        input.onUploadStarted();
    }

    async function putOne(name: string): Promise<void> {
        const size = sizes.get(name) ?? 0;

        await withRetry(
            async () => {
                if (input.signal.aborted) throw cancelledError('uploading');
                markStarted();
                const body = createReadStream(join(input.dir, name));

                try {
                    await input.client.send(
                        new PutObjectCommand({
                            Bucket: input.bucket,
                            Key: objectKey(input.prefix, name),
                            Body: body,
                            ContentLength: size,
                            ContentType: contentTypeFor(name),
                        }),
                        { abortSignal: input.signal },
                    );
                } finally {
                    body.destroy();
                }
            },
            {
                delaysMs: UPLOAD_RETRY_DELAYS_MS,
                sleep: (ms) => input.sleep(ms, input.signal),
                shouldRetry: () => !input.signal.aborted,
                onRetry: (error, attempt, delayMs) =>
                    input.logger.warn(`Upload of ${name} failed; retrying.`, {
                        attempt,
                        delayMs,
                        error,
                    }),
            },
        );

        done++;
        input.onProgress(progressFromUploaded(done, names.length));
    }

    try {
        await runPool(others, UPLOAD_CONCURRENCY, putOne);

        if (input.signal.aborted) throw cancelledError('uploading');

        await putOne(PLAYLIST_FILE);
    } catch (error) {
        if (input.signal.aborted) throw cancelledError('uploading');
        if (error instanceof PipelineError) throw error;
        input.logger.error('Upload failed.', { error });
        throw new PipelineError({
            kind: 'failed',
            step: 'uploading',
            message: 'Uploading to R2 failed. Check the R2 settings and your connection.',
            cause: error,
        });
    }

    input.onPlaylistUploaded();

    return { files: names };
}
