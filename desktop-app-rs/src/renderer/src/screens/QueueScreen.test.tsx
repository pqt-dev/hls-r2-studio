import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobDto } from '../../../shared/ipc';
import type { JobState } from '../../../shared/types';
import { makeJob, makeSummary } from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';

const EMBED = 'https://site.example.com/embed/abc123';

const detail = {
    step: 'transcoding' as const,
    exitCode: 1,
    stderrTail: ['line one', 'line two: Invalid data found'],
};

/** One representative DTO per state, with the flags the main process would set. */
const CASES: ReadonlyArray<{
    state: JobState;
    stage: string;
    buttons: string[];
    job: Partial<JobDto>;
}> = [
    { state: 'waiting', stage: 'Waiting', buttons: ['Cancel'], job: { canCancel: true } },
    {
        state: 'transcoding',
        stage: 'Transcoding',
        buttons: ['Cancel'],
        job: { canCancel: true, progress: 40 },
    },
    {
        state: 'thumbnail',
        stage: 'Thumbnail',
        buttons: ['Cancel'],
        job: { canCancel: true, progress: 60 },
    },
    {
        state: 'storyboard',
        stage: 'Storyboard',
        buttons: ['Cancel'],
        job: { canCancel: true, progress: 65 },
    },
    {
        state: 'uploading',
        stage: 'Uploading',
        buttons: ['Cancel'],
        job: { canCancel: true, progress: 80 },
    },
    {
        state: 'registering',
        stage: 'Registering',
        buttons: ['Cancel'],
        job: { canCancel: true, progress: 98 },
    },
    {
        state: 'done',
        stage: 'Done',
        buttons: ['Copy embed URL', 'Copy shortcode', 'Open on site', 'Remove'],
        job: { canRemove: true, progress: 100, embedUrl: EMBED, publicId: 'abc123' },
    },
    {
        state: 'failed',
        stage: 'Failed',
        buttons: ['Retry', 'View details', 'Remove'],
        job: {
            canRetry: true,
            canRemove: true,
            errorMessage: 'ffmpeg failed',
            errorDetail: detail,
        },
    },
    {
        state: 'cancelled',
        stage: 'Cancelled',
        buttons: ['Retry', 'Remove'],
        job: { canRetry: true, canRemove: true },
    },
    {
        state: 'interrupted',
        stage: 'Interrupted',
        buttons: ['Retry', 'View details', 'Remove'],
        job: { canRetry: true, canRemove: true, errorMessage: 'The app was closed.' },
    },
    {
        state: 'register_failed',
        stage: 'Register failed',
        buttons: ['Cancel', 'Retry register', 'View details'],
        job: { canCancel: true, canRetryRegister: true, errorMessage: 'Site unreachable.' },
    },
    {
        state: 'upload_interrupted',
        stage: 'Upload paused',
        buttons: ['Resume', 'Start over', 'View details', 'Remove'],
        job: {
            canResume: true,
            canRetry: true,
            canRemove: true,
            errorMessage: 'Upload stopped: the network was unavailable for 30 minutes.',
        },
    },
    {
        state: 'needs_sign_in',
        stage: 'Sign-in needed',
        buttons: ['Cancel', 'Retry register'],
        job: { canCancel: true, canRetryRegister: true },
    },
];

const ALL_ACTIONS = [
    'Cancel',
    'Resume',
    'Start over',
    'Retry',
    'Retry register',
    'Remove',
    'Copy embed URL',
    'Copy shortcode',
    'Open on site',
    'View details',
];

function actionsIn(item: HTMLElement): string[] {
    return within(item)
        .queryAllByRole('button')
        .map((button) => (button.getAttribute('aria-label') ?? '').split(':')[0] ?? '');
}

describe('Queue screen', () => {
    it('shows the empty state and the drop zone', async () => {
        await renderApp();

        expect(
            screen.getAllByText('Drop video files here, or click Add videos').length,
        ).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: 'Add videos' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear finished' })).toBeDisabled();
    });

    it.each(CASES)('renders a $state job with the right stage and actions', async (c) => {
        await renderApp({ jobs: [makeJob({ id: 'x', state: c.state, ...c.job })] });

        const item = screen.getByRole('listitem');

        expect(within(item).getByText(c.stage)).toBeInTheDocument();
        expect(actionsIn(item)).toEqual(c.buttons);

        for (const action of ALL_ACTIONS.filter((name) => !c.buttons.includes(name))) {
            expect(actionsIn(item)).not.toContain(action);
        }

        const running = ['transcoding', 'thumbnail', 'storyboard', 'uploading', 'registering'];

        if (running.includes(c.state)) {
            expect(within(item).getByRole('progressbar')).toHaveValue(c.job.progress ?? 0);
            expect(within(item).getByText(`${c.job.progress ?? 0}%`)).toBeInTheDocument();
        } else {
            expect(within(item).queryByRole('progressbar')).not.toBeInTheDocument();
        }
    });

    it('shows a paused upload with its message, help text and a non-color status icon', async () => {
        await renderApp({
            jobs: [
                makeJob({
                    id: 'p',
                    state: 'upload_interrupted',
                    canResume: true,
                    canRetry: true,
                    canRemove: true,
                    errorMessage: 'The app was closed during upload. Resume to continue.',
                }),
            ],
        });

        const item = screen.getByRole('listitem');

        expect(item).toHaveClass('job-paused');
        expect(item.querySelector('.chip-icon')).toHaveTextContent('‖');
        expect(within(item).getByText(/closed during upload/)).toBeInTheDocument();
        expect(
            within(item).getByText(/kept on disk until you resume or remove/),
        ).toBeInTheDocument();
        expect(screen.getByText('1 upload paused.')).toBeInTheDocument();
        expect(within(item).queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('shows "Waiting for network" while an upload retries, keeping the progress bar', async () => {
        const { fake } = await renderApp({
            jobs: [
                makeJob({
                    state: 'uploading',
                    progress: 72,
                    canCancel: true,
                    waitingForNetwork: true,
                    networkWaitSince: '2026-01-01T10:00:00.000Z',
                }),
            ],
        });
        const item = screen.getByRole('listitem');

        expect(within(item).getByText('Waiting for network…')).toBeInTheDocument();
        expect(within(item).queryByText('Uploading')).not.toBeInTheDocument();
        expect(within(item).getByText('Retrying automatically')).toBeInTheDocument();
        expect(within(item).getByRole('progressbar')).toHaveValue(72);
        expect(actionsIn(item)).toEqual(['Cancel']);

        push(() =>
            fake.emitJobs([
                makeJob({
                    state: 'uploading',
                    progress: 73,
                    canCancel: true,
                    waitingForNetwork: false,
                }),
            ]),
        );
        expect(screen.getByText('Uploading')).toBeInTheDocument();
        expect(screen.queryByText('Retrying automatically')).not.toBeInTheDocument();
    });

    describe('paused upload confirmations', () => {
        const paused = () =>
            makeJob({
                id: 'p',
                fileName: 'clip.mp4',
                state: 'upload_interrupted',
                canResume: true,
                canRetry: true,
                canRemove: true,
            });

        it('Resume calls the API directly without a confirmation', async () => {
            const { fake, user } = await renderApp({ jobs: [paused()] });
            const resume = vi.spyOn(fake.api.jobs, 'resume');

            await user.click(screen.getByRole('button', { name: /^Resume:/ }));
            expect(resume).toHaveBeenCalledWith('p');
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });

        it.each([
            {
                button: /^Start over:/,
                title: 'Start over?',
                body: 'The saved progress for clip.mp4 will be discarded and the video will be processed again from the beginning.',
                confirm: 'Start over',
                cancel: 'Keep paused',
                api: 'retry' as const,
            },
            {
                button: /^Remove:/,
                title: 'Remove this video?',
                body: 'The temporary files for clip.mp4 will be deleted, so it can no longer be resumed.',
                confirm: 'Remove',
                cancel: 'Keep',
                api: 'remove' as const,
            },
        ])('$title asks first and only calls the API after confirming', async (c) => {
            const { fake, user } = await renderApp({ jobs: [paused()] });
            const spy = vi.spyOn(fake.api.jobs, c.api);

            await user.click(screen.getByRole('button', { name: c.button }));

            const dialog = screen.getByRole('alertdialog', { name: c.title });

            expect(dialog).toHaveTextContent(c.body);
            expect(spy).not.toHaveBeenCalled();
            expect(within(dialog).getByRole('button', { name: c.cancel })).toHaveFocus();

            await user.click(within(dialog).getByRole('button', { name: c.confirm }));
            expect(spy).toHaveBeenCalledWith('p');
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });

        it.each([
            { button: /^Start over:/, cancel: 'Keep paused', api: 'retry' as const },
            { button: /^Remove:/, cancel: 'Keep', api: 'remove' as const },
        ])('the cancel button does nothing ($api)', async (c) => {
            const { fake, user } = await renderApp({ jobs: [paused()] });
            const spy = vi.spyOn(fake.api.jobs, c.api);

            await user.click(screen.getByRole('button', { name: c.button }));
            await user.click(screen.getByRole('button', { name: c.cancel }));

            expect(spy).not.toHaveBeenCalled();
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });

        it.each([{ button: /^Start over:/ }, { button: /^Remove:/ }])(
            'Escape closes the dialog and restores focus to the opener',
            async (c) => {
                const { fake, user } = await renderApp({ jobs: [paused()] });
                const retry = vi.spyOn(fake.api.jobs, 'retry');
                const remove = vi.spyOn(fake.api.jobs, 'remove');
                const opener = screen.getByRole('button', { name: c.button });

                await user.click(opener);
                await user.keyboard('{Escape}');

                expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
                expect(opener).toHaveFocus();
                expect(retry).not.toHaveBeenCalled();
                expect(remove).not.toHaveBeenCalled();
            },
        );

        it('other states keep Retry and Remove without a confirmation', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'f', state: 'failed', canRetry: true, canRemove: true })],
            });
            const retry = vi.spyOn(fake.api.jobs, 'retry');
            const remove = vi.spyOn(fake.api.jobs, 'remove');

            await user.click(screen.getByRole('button', { name: /^Retry:/ }));
            await user.click(screen.getByRole('button', { name: /^Remove:/ }));

            expect(retry).toHaveBeenCalledWith('f');
            expect(remove).toHaveBeenCalledWith('f');
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });
    });

    it('shows an error toast when Resume is refused', async () => {
        const { fake, user } = await renderApp({
            jobs: [makeJob({ id: 'p', state: 'upload_interrupted', canResume: true })],
        });

        vi.spyOn(fake.api.jobs, 'resume').mockResolvedValue({
            ok: false,
            error: 'Sign in to resume this upload.',
        });
        await user.click(screen.getByRole('button', { name: /^Resume:/ }));
        expect(await screen.findByText(/Sign in to resume this upload\./)).toBeInTheDocument();
    });

    it('shows the file name with a tooltip, formatted size and relative time', async () => {
        await renderApp({
            jobs: [
                makeJob({
                    fileName: 'a-very-long-name.mp4',
                    sizeBytes: 2.5 * 1024 ** 3,
                    state: 'done',
                    finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
                }),
            ],
        });

        expect(screen.getByText('a-very-long-name.mp4')).toHaveAttribute(
            'title',
            'a-very-long-name.mp4',
        );
        expect(screen.getByText('2.5 GB')).toBeInTheDocument();
        expect(screen.getByText('Finished 5 minutes ago')).toBeInTheDocument();
    });

    it('updates the progress bar when a jobs:updated event is pushed', async () => {
        const { fake } = await renderApp({
            jobs: [makeJob({ state: 'transcoding', progress: 10, canCancel: true })],
        });

        expect(screen.getByRole('progressbar')).toHaveValue(10);

        push(() =>
            fake.emitJobs([makeJob({ state: 'transcoding', progress: 55, canCancel: true })]),
        );
        expect(screen.getByRole('progressbar')).toHaveValue(55);
        expect(screen.getByText('55%')).toBeInTheDocument();

        push(() => fake.emitJobs([makeJob({ state: 'uploading', progress: 80, canCancel: true })]));
        expect(screen.getByText('Uploading')).toBeInTheDocument();
    });

    it('renders the summary footer from queue:summary events', async () => {
        const { fake } = await renderApp();

        push(() => fake.emitSummary(makeSummary({ running: 2, waiting: 3, done: 4, failed: 1 })));

        const footer = screen.getByText('2 running').closest('footer');

        expect(footer).toHaveTextContent('2 running');
        expect(footer).toHaveTextContent('3 waiting');
        expect(footer).toHaveTextContent('4 done');
        expect(footer).toHaveTextContent('1 failed');
        expect(footer).not.toHaveTextContent('need attention');
    });

    it('counts paused uploads under "need attention" in the footer', async () => {
        const { fake } = await renderApp();

        push(() => fake.emitSummary(makeSummary({ attention: 2, total: 2 })));
        expect(screen.getByText('2 need attention').closest('footer')).toBeInTheDocument();
    });

    it('computes the local attention count from the jobs before the first summary', async () => {
        await renderApp({
            jobs: [
                makeJob({ id: 'a', state: 'upload_interrupted' }),
                makeJob({ id: 'b', state: 'register_failed' }),
            ],
        });

        expect(screen.getByText('2 need attention')).toBeInTheDocument();
    });

    it('adds dropped files through the preload helper', async () => {
        const { fake } = await renderApp();
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');
        const files = [
            new File(['a'], 'one.mp4', { type: 'video/mp4' }),
            new File(['b'], 'two.mov', { type: 'video/quicktime' }),
        ];

        fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files } });

        await waitFor(() => expect(addDropped).toHaveBeenCalledTimes(1));
        expect(addDropped.mock.calls[0]?.[0]).toEqual(files);
        expect(await screen.findByText('Added 2 videos to the queue.')).toBeInTheDocument();
    });

    it('ignores drops without files and highlights the zone while dragging', async () => {
        const { fake } = await renderApp();
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');
        const zone = screen.getByTestId('dropzone');

        fireEvent.dragEnter(zone, { dataTransfer: { files: [] } });
        expect(zone).toHaveClass('is-dragging');
        fireEvent.drop(zone, { dataTransfer: { files: [] } });
        expect(zone).not.toHaveClass('is-dragging');
        expect(addDropped).not.toHaveBeenCalled();
    });

    it('opens the native dialog from the Add videos button and reports skipped files', async () => {
        const { fake, user } = await renderApp();

        vi.spyOn(fake.api.jobs, 'addFiles').mockResolvedValue({
            added: 1,
            rejected: [{ name: 'notes.txt', reason: 'Not a video file' }],
            canceled: false,
        });
        await user.click(screen.getByRole('button', { name: 'Add videos' }));

        expect(await screen.findByText('Added 1 video to the queue.')).toBeInTheDocument();
        expect(
            screen.getByText(/Skipped 1 file: notes\.txt \(Not a video file\)/),
        ).toBeInTheDocument();
    });

    it('shows nothing when the file dialog was cancelled', async () => {
        const { user } = await renderApp();

        await user.click(screen.getByRole('button', { name: 'Add videos' }));
        expect(screen.queryByText(/Added/)).not.toBeInTheDocument();
    });

    describe('banners', () => {
        it('shows the offline banner with a working Reload config button', async () => {
            const { fake, user } = await renderApp({
                auth: { status: 'offline', username: 'a', siteUrl: 'https://s.example.com' },
            });
            const reload = vi.spyOn(fake.api.auth, 'reloadConfig');

            expect(screen.getByText('Cannot reach the site.')).toBeInTheDocument();
            await user.click(screen.getByRole('button', { name: 'Reload config' }));
            expect(reload).toHaveBeenCalled();
        });

        it('explains how to fix an R2 setup that is missing on the site', async () => {
            await renderApp({
                auth: {
                    status: 'signed_in',
                    username: 'a',
                    siteUrl: 'https://s.example.com',
                    r2Configured: false,
                },
            });

            expect(screen.getByRole('alert')).toHaveTextContent(
                'Ask an admin to set up R2 in the site dashboard (Settings -> Storage)',
            );
        });

        it('shows a blocking banner when the ffmpeg self-check failed', async () => {
            await renderApp({
                diagnostics: {
                    appVersion: '1',
                    platform: 'win32 x64',
                    ffmpeg: {
                        checked: true,
                        ok: false,
                        version: null,
                        missing: ['libx264', 'ffprobe'],
                    },
                },
            });

            const banner = screen.getByText('Video tools are not working.').closest('.banner');

            expect(banner).toHaveTextContent('libx264');
            expect(banner).toHaveTextContent('ffprobe');
        });

        it('picks up the ffmpeg result when the self-check finishes after startup', async () => {
            const { fake } = await renderApp({
                diagnostics: {
                    appVersion: '1',
                    platform: 'win32 x64',
                    ffmpeg: { checked: false, ok: false, version: null, missing: [] },
                },
            });

            expect(screen.queryByText('Video tools are not working.')).not.toBeInTheDocument();

            fake.state.diagnostics = {
                ...fake.state.diagnostics,
                ffmpeg: { checked: true, ok: false, version: null, missing: ['libx264'] },
            };

            expect(
                await screen.findByText('Video tools are not working.', {}, { timeout: 3000 }),
            ).toBeInTheDocument();
        });

        it('tells the user to sign in again for jobs that need it', async () => {
            await renderApp({
                jobs: [
                    makeJob({ id: 'a', state: 'needs_sign_in' }),
                    makeJob({ id: 'b', state: 'needs_sign_in' }),
                ],
            });

            expect(screen.getByText('Sign in again to finish 2 videos.')).toBeInTheDocument();
        });

        it('shows no banner when everything is fine', async () => {
            await renderApp();

            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        });
    });

    describe('actions, toasts and confirmations', () => {
        it('copies the embed URL and shortcode and confirms with a toast', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'j', state: 'done', embedUrl: EMBED, canRemove: true })],
            });
            const copy = vi.spyOn(fake.api.jobs, 'copy');

            await user.click(screen.getByRole('button', { name: /^Copy embed URL/ }));
            expect(copy).toHaveBeenCalledWith('j', 'embed-url');
            expect(await screen.findByText('Embed URL copied.')).toBeInTheDocument();

            await user.click(screen.getByRole('button', { name: /^Copy shortcode/ }));
            expect(copy).toHaveBeenCalledWith('j', 'shortcode');
            expect(await screen.findByText('Shortcode copied.')).toBeInTheDocument();
        });

        it('opens the video on the site', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'j', state: 'done', embedUrl: EMBED })],
            });
            const open = vi.spyOn(fake.api.jobs, 'openEmbed');

            await user.click(screen.getByRole('button', { name: /^Open on site/ }));
            expect(open).toHaveBeenCalledWith('j');
        });

        it('announces errors returned by an action in an aria-live toast', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'j', state: 'failed', canRetry: true })],
            });

            vi.spyOn(fake.api.jobs, 'retry').mockResolvedValue({
                ok: false,
                error: 'Disk is full.',
            });
            await user.click(screen.getByRole('button', { name: /^Retry:/ }));

            const region = document.querySelector('.toasts');

            expect(region).toHaveAttribute('aria-live', 'polite');
            expect(
                await within(region as HTMLElement).findByText(/Disk is full\./),
            ).toBeInTheDocument();
        });

        it('shows a generic error when the call itself rejects', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'j', state: 'cancelled', canRemove: true })],
            });

            vi.spyOn(fake.api.jobs, 'remove').mockRejectedValue(new Error('boom'));
            await user.click(screen.getByRole('button', { name: /^Remove:/ }));
            expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
        });

        it('asks before cancelling a running job and only cancels after confirming', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'j', state: 'uploading', canCancel: true, progress: 50 })],
            });
            const cancel = vi.spyOn(fake.api.jobs, 'cancel');

            await user.click(screen.getByRole('button', { name: /^Cancel:/ }));

            const dialog = screen.getByRole('alertdialog', { name: 'Cancel this video?' });

            expect(cancel).not.toHaveBeenCalled();
            // The safe choice has the initial focus.
            expect(within(dialog).getByRole('button', { name: 'Keep running' })).toHaveFocus();

            await user.click(within(dialog).getByRole('button', { name: 'Cancel video' }));
            expect(cancel).toHaveBeenCalledWith('j');
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });

        it('cancels a waiting job without a confirmation', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'w', state: 'waiting', canCancel: true })],
            });
            const cancel = vi.spyOn(fake.api.jobs, 'cancel');

            await user.click(screen.getByRole('button', { name: /^Cancel:/ }));
            expect(cancel).toHaveBeenCalledWith('w');
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });

        it('confirms Clear finished only when something would be removed', async () => {
            const { fake, user } = await renderApp({
                jobs: [
                    makeJob({ id: 'a', state: 'done', canRemove: true }),
                    makeJob({ id: 'b', state: 'failed', canRemove: true }),
                    makeJob({ id: 'c', state: 'waiting', canCancel: true }),
                ],
            });
            const clear = vi.spyOn(fake.api.jobs, 'clearFinished');

            await user.click(screen.getByRole('button', { name: 'Clear finished' }));

            const dialog = screen.getByRole('alertdialog');

            expect(dialog).toHaveTextContent('removes 2 finished videos');
            expect(clear).not.toHaveBeenCalled();

            await user.click(within(dialog).getByRole('button', { name: 'Clear finished' }));
            expect(clear).toHaveBeenCalledTimes(1);
        });

        it('does not clear when the confirmation is dismissed with Escape', async () => {
            const { fake, user } = await renderApp({
                jobs: [makeJob({ id: 'a', state: 'done', canRemove: true })],
            });
            const clear = vi.spyOn(fake.api.jobs, 'clearFinished');
            const opener = screen.getByRole('button', { name: 'Clear finished' });

            await user.click(opener);
            await user.keyboard('{Escape}');

            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
            expect(clear).not.toHaveBeenCalled();
            expect(opener).toHaveFocus();
        });
    });

    describe('details dialog', () => {
        const failed = makeJob({
            id: 'f',
            fileName: 'bad.mp4',
            state: 'failed',
            errorMessage: 'ffmpeg could not convert this video.',
            errorDetail: detail,
            canRetry: true,
            canRemove: true,
        });

        it('shows message, failing step, exit code and the stderr tail', async () => {
            const { user } = await renderApp({ jobs: [failed] });

            await user.click(screen.getByRole('button', { name: /^View details/ }));

            const dialog = screen.getByRole('dialog', { name: 'Job details' });

            expect(dialog).toHaveTextContent('ffmpeg could not convert this video.');
            expect(within(dialog).getByText('Failing step').nextElementSibling).toHaveTextContent(
                'Transcoding',
            );
            expect(within(dialog).getByText('Exit code').nextElementSibling).toHaveTextContent('1');

            const log = within(dialog).getByLabelText('ffmpeg output');

            expect(log).toHaveTextContent('line two: Invalid data found');
            expect(log).toHaveAttribute('tabindex', '0');
        });

        it('shows the message of a paused upload without an ffmpeg log', async () => {
            const { user } = await renderApp({
                jobs: [
                    makeJob({
                        id: 'p',
                        state: 'upload_interrupted',
                        errorMessage: 'Upload stopped: the network was unavailable.',
                        errorDetail: { step: 'uploading', exitCode: null, stderrTail: [] },
                    }),
                ],
            });

            await user.click(screen.getByRole('button', { name: /^View details/ }));

            const dialog = screen.getByRole('dialog', { name: 'Job details' });

            expect(dialog).toHaveTextContent('Upload paused');
            expect(dialog).toHaveTextContent('Upload stopped: the network was unavailable.');
            expect(dialog).toHaveTextContent('kept on disk');
            expect(within(dialog).queryByLabelText('ffmpeg output')).not.toBeInTheDocument();
        });

        it('copies the details and closes with Escape, restoring focus', async () => {
            const { user } = await renderApp({ jobs: [failed] });
            const opener = screen.getByRole('button', { name: /^View details/ });

            await user.click(opener);
            await user.click(screen.getByRole('button', { name: 'Copy details' }));

            expect(await screen.findByText('Details copied.')).toBeInTheDocument();

            const copied = await navigator.clipboard.readText();

            expect(copied).toContain('Message: ffmpeg could not convert this video.');
            expect(copied).toContain('Exit code: 1');
            expect(copied).toContain('line two: Invalid data found');

            await user.keyboard('{Escape}');
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(opener).toHaveFocus();
        });

        it('shows an error toast when copying is not possible', async () => {
            const { user } = await renderApp({ jobs: [failed] });

            vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
            await user.click(screen.getByRole('button', { name: /^View details/ }));
            await user.click(screen.getByRole('button', { name: 'Copy details' }));
            expect(await screen.findByText(/Could not copy the details\./)).toBeInTheDocument();
        });
    });

    describe('modal focus handling', () => {
        it('traps Tab inside the dialog and wraps in both directions', async () => {
            const { user } = await renderApp({
                jobs: [makeJob({ id: 'a', state: 'done', canRemove: true })],
            });

            await user.click(screen.getByRole('button', { name: 'Clear finished' }));

            const dialog = screen.getByRole('alertdialog');
            const keep = within(dialog).getByRole('button', { name: 'Keep' });
            const confirm = within(dialog).getByRole('button', { name: 'Clear finished' });

            expect(keep).toHaveFocus();
            await user.tab();
            expect(confirm).toHaveFocus();
            await user.tab();
            expect(keep).toHaveFocus();
            await user.tab({ shift: true });
            expect(confirm).toHaveFocus();
        });

        it('closes when the backdrop is pressed', async () => {
            const { user } = await renderApp({
                jobs: [makeJob({ id: 'a', state: 'done', canRemove: true })],
            });

            await user.click(screen.getByRole('button', { name: 'Clear finished' }));
            fireEvent.mouseDown(screen.getByRole('alertdialog').parentElement as HTMLElement);
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        });
    });
});
