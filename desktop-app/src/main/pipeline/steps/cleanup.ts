/** Best-effort removal of everything under an R2 prefix (after a failed or cancelled job). */
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from '../../logger';
import { isValidPrefix } from '../prefix';

export const DELETE_BATCH_SIZE = 1000;

export interface DeleteResult {
    /** False when the prefix was refused or an error stopped the cleanup. */
    ok: boolean;
    deleted: number;
}

/** The 12 character public id at the end of `.../<slug>-<publicId>/`, or null. */
function publicIdOf(prefix: string): string | null {
    return /-([a-z0-9]{12})\/$/.exec(prefix)?.[1] ?? null;
}

/**
 * Lists the prefix page by page (ListObjectsV2) and deletes each page in one DeleteObjects batch
 * (max 1000 keys). Never throws: errors are logged and reported through the result. Refuses any
 * prefix that does not pass the strict `YYYY/MM/DD/<slug>-<publicId>/` check, so an empty or
 * short prefix can never wipe a bucket.
 */
export async function deleteR2Prefix(
    client: S3Client,
    bucket: string,
    prefix: string,
    logger?: Logger,
): Promise<DeleteResult> {
    const publicId = publicIdOf(prefix);

    if (publicId === null || !isValidPrefix(prefix, publicId)) {
        logger?.error('Refusing to delete an invalid R2 prefix.');

        return { ok: false, deleted: 0 };
    }

    let deleted = 0;
    let token: string | undefined;

    try {
        do {
            const page = await client.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    MaxKeys: DELETE_BATCH_SIZE,
                    ContinuationToken: token,
                }),
            );
            const keys = (page.Contents ?? [])
                .map((o) => o.Key)
                .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));

            if (keys.length > 0) {
                const response = await client.send(
                    new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
                    }),
                );
                const failures = response.Errors?.length ?? 0;

                deleted += keys.length - failures;

                if (failures > 0)
                    logger?.warn('Some R2 objects could not be deleted.', { failures });
            }

            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token !== undefined);
    } catch (error) {
        logger?.warn('Cleaning up the R2 prefix failed (best effort).', { error });

        return { ok: false, deleted };
    }

    return { ok: true, deleted };
}
