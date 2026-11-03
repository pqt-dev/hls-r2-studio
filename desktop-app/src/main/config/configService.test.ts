import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/appConfig';
import { SiteApiError } from '../api/siteClient';
import { createFileLoggerForTest } from './testLogger';
import { createConfigService, StaleConfigError } from './configService';

const CONFIG: AppConfig = {
    r2: {
        access_key_id: 'AKIA-SECRET-ID',
        secret_access_key: 'super-secret-value',
        bucket: 'bucket',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        url: 'https://cdn.example.com',
    },
    transcode: { resolution: '720', segment_seconds: 6, fps: 30 },
};

describe('configService', () => {
    it('is empty until refreshed', () => {
        const service = createConfigService({ getConfig: () => Promise.reject(new Error('x')) });
        expect(service.getConfig()).toBeNull();
        expect(service.getPublic()).toBeNull();
    });

    it('keeps the full config for main and exposes only a safe view', async () => {
        const service = createConfigService({ getConfig: () => Promise.resolve(CONFIG) });
        const view = await service.refresh();

        expect(service.getConfig()).toEqual(CONFIG);
        expect(view).toEqual({ r2Configured: true, transcode: CONFIG.transcode });

        for (const value of [view, service.getPublic()]) {
            const text = JSON.stringify(value);
            expect(text).not.toContain('super-secret-value');
            expect(text).not.toContain('AKIA-SECRET-ID');
            expect(text).not.toContain('bucket');
            expect(text).not.toContain('cloudflarestorage');
        }
    });

    it('does not leak the secret through the logger when the config is logged', async () => {
        const service = createConfigService({ getConfig: () => Promise.resolve(CONFIG) });
        const { logger, lines } = createFileLoggerForTest();

        await service.refresh();
        logger.info('config loaded', service.getConfig());
        logger.info('public', service.getPublic());

        const text = lines().join('\n');
        expect(text).not.toContain('super-secret-value');
        expect(text).not.toContain('AKIA-SECRET-ID');
    });

    it('maps 409 r2_not_configured to a clear not-configured state', async () => {
        let first = true;
        const service = createConfigService({
            getConfig: () => {
                if (first) {
                    first = false;

                    return Promise.resolve(CONFIG);
                }

                return Promise.reject(
                    new SiteApiError({ message: 'x', status: 409, code: 'r2_not_configured' }),
                );
            },
        });

        await service.refresh();
        const view = await service.refresh();

        expect(view).toEqual({ r2Configured: false, transcode: null });
        expect(service.getConfig()).toBeNull();
    });

    it('rethrows other errors and keeps the previous config', async () => {
        let fail = false;
        const service = createConfigService({
            getConfig: () =>
                fail
                    ? Promise.reject(new SiteApiError({ message: 'down', network: true }))
                    : Promise.resolve(CONFIG),
        });

        await service.refresh();
        fail = true;

        await expect(service.refresh()).rejects.toBeInstanceOf(SiteApiError);
        expect(service.getConfig()).toEqual(CONFIG);
    });

    it('clear() forgets everything', async () => {
        const service = createConfigService({ getConfig: () => Promise.resolve(CONFIG) });
        await service.refresh();
        service.clear();

        expect(service.getConfig()).toBeNull();
        expect(service.getPublic()).toBeNull();
    });
});

describe('configService races', () => {
    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        return { promise, resolve, reject };
    }

    it('discards a config that arrives after clear()', async () => {
        const pending = deferred<AppConfig>();
        const service = createConfigService({ getConfig: () => pending.promise });
        const refresh = service.refresh();

        service.clear();
        pending.resolve(CONFIG);

        await expect(refresh).rejects.toBeInstanceOf(StaleConfigError);
        expect(service.getConfig()).toBeNull();
        expect(service.getPublic()).toBeNull();
    });

    it('discards a 409 r2_not_configured answer and a failure that arrive after clear()', async () => {
        const pending = deferred<AppConfig>();
        const service = createConfigService({ getConfig: () => pending.promise });
        const refresh = service.refresh();

        service.clear();
        pending.reject(new SiteApiError({ message: 'x', status: 409, code: 'r2_not_configured' }));

        await expect(refresh).rejects.toBeInstanceOf(StaleConfigError);
        expect(service.getPublic()).toBeNull();
    });

    it('still stores the config of a refresh started after clear()', async () => {
        const service = createConfigService({ getConfig: () => Promise.resolve(CONFIG) });

        service.clear();
        await service.refresh();

        expect(service.getConfig()).toEqual(CONFIG);
    });
});
