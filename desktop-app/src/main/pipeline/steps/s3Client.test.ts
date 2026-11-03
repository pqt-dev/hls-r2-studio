import { describe, expect, it } from 'vitest';
import { createR2Client } from './s3Client';

const R2 = {
    access_key_id: 'k',
    secret_access_key: 's',
    bucket: 'b',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    url: 'https://cdn.example.com',
};

describe('createR2Client', () => {
    it('never retries inside the SDK for uploads (streaming bodies cannot be replayed)', async () => {
        const client = createR2Client(R2);

        expect(await client.config.maxAttempts()).toBe(1);
        client.destroy();
    });

    it('keeps SDK retries (3 attempts) for the replayable list/delete cleanup calls', async () => {
        const client = createR2Client(R2, 'cleanup');

        expect(await client.config.maxAttempts()).toBe(3);
        client.destroy();
    });
});
