import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobDto } from '../../../shared/ipc';
import { makeJob, makeSummary } from '../testing/fakeApi';
import { clickJobAction, openJobMenu } from '../testing/jobMenu';
import { push, renderQueue } from '../testing/renderApp';

const names = () =>
    within(screen.getByRole('list', { name: 'Video queue' }))
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.job-name')?.textContent);

const EMBED = 'https://site.example.com/embed/abc123';

describe('Queue order', () => {
    it('shows a running job before a done job, and a newer job before an older one', async () => {
        await renderQueue({
            jobs: [
                makeJob({
                    id: 'a',
                    fileName: 'done-old.mp4',
                    state: 'done',
                    createdAt: '2026-01-01T10:00:00.000Z',
                }),
                makeJob({
                    id: 'b',
                    fileName: 'done-new.mp4',
                    state: 'done',
                    createdAt: '2026-01-03T10:00:00.000Z',
                }),
                makeJob({
                    id: 'c',
                    fileName: 'running.mp4',
                    state: 'uploading',
                    createdAt: '2026-01-02T10:00:00.000Z',
                }),
                makeJob({
                    id: 'd',
                    fileName: 'waiting.mp4',
                    state: 'waiting',
                    createdAt: '2026-01-04T10:00:00.000Z',
                }),
                makeJob({
                    id: 'e',
                    fileName: 'failed.mp4',
                    state: 'failed',
                    createdAt: '2026-01-01T09:00:00.000Z',
                }),
            ],
        });

        expect(names()).toEqual([
            'running.mp4',
            'waiting.mp4',
            'done-new.mp4',
            'done-old.mp4',
            'failed.mp4',
        ]);
    });

    it('collapses a long finished group by default and expands it on demand', async () => {
        const done = Array.from({ length: 25 }, (_, i) =>
            makeJob({
                id: `d${i}`,
                fileName: `done-${i}.mp4`,
                state: 'done',
                createdAt: `2026-01-01T10:00:${String(i).padStart(2, '0')}.000Z`,
            }),
        );
        const { user } = await renderQueue({
            jobs: [...done, makeJob({ id: 'r', fileName: 'live.mp4', state: 'uploading' })],
        });

        expect(names()).toEqual(['live.mp4']);

        const toggle = screen.getByRole('button', { name: /Finished/ });

        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveTextContent('25');

        await user.click(toggle);
        expect(names()).toHaveLength(26);
        // Newest finished job first.
        expect(names()[1]).toBe('done-24.mp4');
        expect(screen.getByRole('button', { name: /Finished/ })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
    });

    it('keeps a short finished group open', async () => {
        await renderQueue({
            jobs: [makeJob({ id: 'd', fileName: 'one.mp4', state: 'done' })],
        });

        expect(names()).toEqual(['one.mp4']);
        expect(screen.getByRole('button', { name: /Finished/ })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
    });

    it('re-orders when a job changes state, keeping the row, the summary and the dialog', async () => {
        const failed = makeJob({
            id: 'f',
            fileName: 'broken.mp4',
            state: 'failed',
            errorMessage: 'Disk is full.',
            canRetry: true,
            canRemove: true,
            createdAt: '2026-01-01T10:00:00.000Z',
        });
        const waiting = makeJob({
            id: 'w',
            fileName: 'next.mp4',
            state: 'waiting',
            canCancel: true,
            createdAt: '2026-01-02T10:00:00.000Z',
        });
        const { fake, user } = await renderQueue({ jobs: [waiting, failed] });

        push(() => fake.emitSummary(makeSummary({ waiting: 1, failed: 1, total: 2 })));
        expect(names()).toEqual(['next.mp4', 'broken.mp4']);

        // Open the details dialog of the failed job, then let the other job start running.
        await clickJobAction(user, 'View details: broken.mp4');
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        push(() =>
            fake.emitJobs([
                { ...waiting, state: 'transcoding', progress: 10 } satisfies JobDto,
                failed,
            ]),
        );

        expect(names()).toEqual(['next.mp4', 'broken.mp4']);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText('1 waiting')).toBeInTheDocument();
        expect(screen.getByText('1 failed')).toBeInTheDocument();
    });

    it('keeps the keyboard focus on the button of a job that moves to another group', async () => {
        const first = makeJob({
            id: 'f',
            fileName: 'first.mp4',
            state: 'waiting',
            canCancel: true,
            createdAt: '2026-01-02T10:00:00.000Z',
        });
        const second = makeJob({
            id: 's',
            fileName: 'second.mp4',
            state: 'waiting',
            canCancel: true,
            createdAt: '2026-01-01T10:00:00.000Z',
        });
        const { fake } = await renderQueue({ jobs: [first, second] });

        expect(names()).toEqual(['first.mp4', 'second.mp4']);

        const button = screen.getByRole('button', { name: 'More actions for second.mp4' });

        button.focus();
        expect(button).toHaveFocus();

        push(() => fake.emitJobs([first, { ...second, state: 'transcoding', progress: 5 }]));

        expect(names()).toEqual(['second.mp4', 'first.mp4']);
        expect(screen.getByRole('button', { name: 'More actions for second.mp4' })).toHaveFocus();
    });

    it('does not take the focus back after the user moved it elsewhere', async () => {
        const first = makeJob({
            id: 'f',
            fileName: 'first.mp4',
            state: 'waiting',
            canCancel: true,
            createdAt: '2026-01-02T10:00:00.000Z',
        });
        const second = makeJob({
            id: 's',
            fileName: 'second.mp4',
            state: 'waiting',
            canCancel: true,
            createdAt: '2026-01-01T10:00:00.000Z',
        });
        const { fake, user } = await renderQueue({ jobs: [first, second] });

        screen.getByRole('button', { name: 'More actions for second.mp4' }).focus();
        await user.tab({ shift: true });
        expect(screen.getByRole('button', { name: 'More actions for first.mp4' })).toHaveFocus();

        push(() => fake.emitJobs([first, { ...second, state: 'transcoding', progress: 5 }]));

        expect(screen.getByRole('button', { name: 'More actions for first.mp4' })).toHaveFocus();
    });

    it('keeps one shortcut on the row and marks destructive menu items as danger', async () => {
        const { user } = await renderQueue({
            jobs: [
                makeJob({ id: 'r', fileName: 'run.mp4', state: 'uploading', canCancel: true }),
                makeJob({
                    id: 'p',
                    fileName: 'paused.mp4',
                    state: 'upload_interrupted',
                    canResume: true,
                    canRetry: true,
                    canRemove: true,
                }),
                makeJob({
                    id: 'd',
                    fileName: 'done.mp4',
                    state: 'done',
                    embedUrl: EMBED,
                    canRemove: true,
                }),
            ],
        });
        const row = (file: string) =>
            document.querySelector<HTMLElement>(`li[data-job-id="${file}"]`) as HTMLElement;

        // The only visible action of a done row is the shortcode button.
        expect(
            screen.getByRole('button', { name: 'Copy shortcode: done.mp4' }).className,
        ).toContain('btn-accent-share');
        expect(screen.queryByRole('button', { name: /^Remove:/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Cancel:/ })).toBeNull();

        const check = async (id: string, danger: string[], plain: string[]) => {
            const menu = await openJobMenu(user, row(id));

            for (const label of danger) {
                expect(within(menu).getByRole('menuitem', { name: label }).className).toContain(
                    'video-menu-danger',
                );
            }

            for (const label of plain) {
                expect(within(menu).getByRole('menuitem', { name: label }).className).not.toContain(
                    'video-menu-danger',
                );
            }

            await user.keyboard('{Escape}');
        };

        await check('r', ['Cancel: run.mp4'], []);
        await check('p', ['Remove: paused.mp4'], ['Resume: paused.mp4', 'Start over: paused.mp4']);
        await check(
            'd',
            ['Remove: done.mp4'],
            ['Copy embed URL: done.mp4', 'Open on site: done.mp4'],
        );

        expect(screen.getByRole('button', { name: 'Clear finished' }).className).toContain(
            'btn-accent-danger',
        );
        // Upload videos stays the solid primary action.
        expect(screen.getByRole('button', { name: 'Upload videos' }).className).toContain(
            'btn-primary',
        );
    });
});
