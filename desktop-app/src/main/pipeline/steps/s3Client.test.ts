import { describe, expect, it } from 'vitest';
import { CONNECTION_TIMEOUT_MS, SOCKET_TIMEOUT_MS, createR2Client } from './s3Client';

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

    it.each(['upload', 'cleanup'] as const)(
        'times out a stalled connection (%s client): 15 s to connect, 60 s socket inactivity',
        async (purpose) => {
            const client = createR2Client(R2, purpose);
            // The handler resolves its options lazily (on the first request).
            const handler = client.config.requestHandler as unknown as {
                configProvider: Promise<{ connectionTimeout?: number; socketTimeout?: number }>;
            };
            const configs = await handler.configProvider;

            expect(configs.connectionTimeout).toBe(CONNECTION_TIMEOUT_MS);
            expect(configs.socketTimeout).toBe(SOCKET_TIMEOUT_MS);
            client.destroy();
        },
    );
});
