/**
 * Dev-only mock of `window.hlsApi` so the UI can be opened in a normal browser:
 * `vite` dev server + `?mock=1` (optional `&auth=signed_out|offline`).
 * main.tsx imports this behind `import.meta.env.DEV`, so it is removed from production builds.
 */
import type { AuthState, JobDto } from '../../../shared/ipc';
import { createFakeApi, makeJob, makeSummary } from './fakeApi';

/** Searched for in the production bundle to prove this module is tree-shaken out. */
export const MOCK_API_MARKER = 'HLS_MOCK_API_MARKER_7f3a';

const MIN = 60_000;

function iso(msAgo: number): string {
    return new Date(Date.now() - msAgo).toISOString();
}

function seedJobs(): JobDto[] {
    const stderrTail = Array.from(
        { length: 40 },
        (_, i) => `frame=${i * 120} fps=48 q=28.0 size=${i * 512}kB`,
    );

    return [
        makeJob({
            id: 'm1',
            fileName: 'interview-final-cut-with-a-very-long-descriptive-file-name-2026.mov',
            sizeBytes: 2.4 * 1024 ** 3,
            state: 'transcoding',
            progress: 38,
            startedAt: iso(4 * MIN),
            createdAt: iso(5 * MIN),
            canCancel: true,
        }),
        makeJob({
            id: 'm2',
            fileName: 'product-demo.mp4',
            sizeBytes: 420 * 1024 ** 2,
            state: 'waiting',
            waitingReason: 'Waiting for a free slot.',
            createdAt: iso(5 * MIN),
            canCancel: true,
        }),
        makeJob({
            id: 'm3',
            fileName: 'trailer.mkv',
            sizeBytes: 88 * 1024 ** 2,
            state: 'done',
            progress: 100,
            publicId: 'abc123',
            embedUrl: 'https://mock.invalid/embed/abc123',
            createdAt: iso(40 * MIN),
            finishedAt: iso(30 * MIN),
            canRemove: true,
        }),
        makeJob({
            id: 'm4',
            fileName: 'broken-source.avi',
            sizeBytes: 12 * 1024 ** 2,
            state: 'failed',
            errorMessage: 'ffmpeg could not read this video.',
            errorDetail: { step: 'transcoding', exitCode: 1, stderrTail },
            createdAt: iso(2 * 60 * MIN),
            finishedAt: iso(2 * 60 * MIN),
            canRetry: true,
            canRemove: true,
        }),
        makeJob({
            id: 'm5',
            fileName: 'upload-ok-register-failed.mp4',
            sizeBytes: 64 * 1024 ** 2,
            state: 'register_failed',
            progress: 98,
            errorMessage: 'The site could not be reached.',
            errorDetail: { step: 'registering', exitCode: null, stderrTail: [] },
            createdAt: iso(3 * 60 * MIN),
            canCancel: true,
            canRetryRegister: true,
        }),
        makeJob({
            id: 'm6',
            fileName: 'needs-login.mp4',
            sizeBytes: 30 * 1024 ** 2,
            state: 'needs_sign_in',
            progress: 98,
            createdAt: iso(3 * 60 * MIN),
            canCancel: true,
            canRetryRegister: true,
        }),
        makeJob({
            id: 'm8',
            fileName: 'uploading-offline.mp4',
            sizeBytes: 900 * 1024 ** 2,
            state: 'uploading',
            progress: 72,
            waitingForNetwork: true,
            networkWaitSince: iso(2 * MIN),
            startedAt: iso(10 * MIN),
            createdAt: iso(12 * MIN),
            canCancel: true,
        }),
        makeJob({
            id: 'm9',
            fileName: 'paused-upload.mp4',
            sizeBytes: 1.2 * 1024 ** 3,
            state: 'upload_interrupted',
            errorMessage:
                'Upload stopped: the network was unavailable for 30 minutes. Resume when you are back online.',
            errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
            createdAt: iso(2 * 60 * MIN),
            canResume: true,
            canRetry: true,
            canRemove: true,
        }),
        makeJob({
            id: 'm7',
            fileName: 'cancelled-clip.webm',
            sizeBytes: 5 * 1024 ** 2,
            state: 'cancelled',
            createdAt: iso(26 * 60 * MIN),
            finishedAt: iso(26 * 60 * MIN),
            canRetry: true,
            canRemove: true,
        }),
    ];
}

export function installMockApi(search: string = window.location.search): void {
    const params = new URLSearchParams(search);
    const mode = params.get('auth');
    const auth: AuthState =
        mode === 'signed_out'
            ? { status: 'signed_out', siteUrl: 'https://mock.invalid' }
            : mode === 'offline'
              ? { status: 'offline', username: 'alice', siteUrl: 'https://mock.invalid' }
              : {
                    status: 'signed_in',
                    username: 'alice',
                    siteUrl: 'https://mock.invalid',
                    r2Configured: true,
                };
    const fake = createFakeApi({
        auth,
        jobs: params.get('empty') === '1' ? [] : seedJobs(),
        settings: {
            siteUrl: 'https://mock.invalid',
            tmpRoot: 'C:\\Users\\alice\\AppData\\Local\\Temp\\hls-r2-studio',
            maxConcurrent: 1,
        },
        nextDirectory: 'D:\\video-temp',
    });

    // Slowly advance the running job so the progress bar can be seen moving.
    window.setInterval(() => {
        const jobs = fake.state.jobs.map((job) =>
            job.state === 'transcoding' ? { ...job, progress: (job.progress + 1) % 100 } : job,
        );

        fake.emitJobs(jobs);
        fake.emitSummary(
            makeSummary({
                running: 1,
                waiting: 1,
                done: 1,
                failed: 1,
                attention: 2,
                total: jobs.length,
            }),
        );
    }, 1000);

    Object.defineProperty(window, 'hlsApi', { value: fake.api, configurable: true });
    console.info(MOCK_API_MARKER, 'mock API installed');
}
