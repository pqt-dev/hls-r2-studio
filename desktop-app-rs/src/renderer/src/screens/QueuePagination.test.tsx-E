import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobDto } from '../../../shared/ipc';
import { makeJob } from '../testing/fakeApi';
import { push, renderQueue } from '../testing/renderApp';

const names = () =>
    within(screen.getByRole('list', { name: 'Video queue' }))
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.job-name')?.textContent);

/** `count` finished jobs, done-0 oldest, done-(count-1) newest (the Queue lists newest first). */
function finishedJobs(count: number, from = 0): JobDto[] {
    return Array.from({ length: count }, (_, i) =>
        makeJob({
            id: `d${from + i}`,
            fileName: `done-${from + i}.mp4`,
            state: 'done',
            createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, from + i)).toISOString(),
        }),
    );
}

const perPage = () => screen.getByRole('combobox', { name: 'Items per page' });
const pageField = (label: string) =>
    within(screen.getByRole('navigation', { name: label })).getByRole('textbox', {
        name: 'Current page',
    });

async function openFinished(jobs: JobDto[]) {
    const rendered = await renderQueue({ jobs });
    const toggle = screen.getByRole('button', { name: /Finished/ });

    if (toggle.getAttribute('aria-expanded') === 'false') await rendered.user.click(toggle);

    return rendered;
}

describe('Queue Finished pagination', () => {
    it('pages only the Finished group: 20 per page by default, newest first', async () => {
        await openFinished(finishedJobs(45));

        expect(names()).toHaveLength(20);
        expect(names()[0]).toBe('done-44.mp4');
        expect(perPage()).toHaveValue('20');
        expect(
            within(perPage().closest('.select')!)
                .getAllByRole('option')
                .map((o) => o.textContent),
        ).toEqual(['10', '20', '50', '100']);

        const top = screen.getByRole('navigation', { name: 'Finished pagination, top' });

        expect(within(top).getByText('45 jobs')).toBeInTheDocument();
        expect(pageField('Finished pagination, top')).toHaveValue('1');
        expect(
            screen.getByRole('navigation', { name: 'Finished pagination, bottom' }),
        ).toBeVisible();
    });

    it('puts Per page on the left and the pager on the right, under the Finished heading', async () => {
        await openFinished(finishedJobs(45));

        const row = document.querySelector<HTMLElement>('.pager-row')!;
        const heading = screen.getByRole('button', { name: /Finished/ });

        expect(
            heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            perPage().compareDocumentPosition(
                within(row).getByRole('navigation', { name: 'Finished pagination, top' }),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it('goes to the next page from either pager', async () => {
        const { user } = await openFinished(finishedJobs(45));

        await user.click(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByRole(
                'button',
                { name: 'Next page' },
            ),
        );
        expect(names()[0]).toBe('done-24.mp4');
        expect(pageField('Finished pagination, bottom')).toHaveValue('2');

        await user.click(
            within(
                screen.getByRole('navigation', { name: 'Finished pagination, bottom' }),
            ).getByRole('button', { name: 'Next page' }),
        );
        expect(names()).toEqual([
            'done-4.mp4',
            'done-3.mp4',
            'done-2.mp4',
            'done-1.mp4',
            'done-0.mp4',
        ]);
    });

    it('returns to page 1 and saves the choice when the page size changes', async () => {
        const { user } = await openFinished(finishedJobs(45));

        await user.click(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByRole(
                'button',
                { name: 'Last page' },
            ),
        );
        expect(pageField('Finished pagination, top')).toHaveValue('3');

        await user.selectOptions(perPage(), '10');
        expect(names()).toHaveLength(10);
        expect(pageField('Finished pagination, top')).toHaveValue('1');
        expect(window.localStorage.getItem('hls.queue.perPage')).toBe('10');
    });

    it('starts with the saved page size', async () => {
        window.localStorage.setItem('hls.queue.perPage', '50');
        await openFinished(finishedJobs(60));

        expect(perPage()).toHaveValue('50');
        expect(names()).toHaveLength(50);
    });

    it('ignores a saved page size that is not an option', async () => {
        window.localStorage.setItem('hls.queue.perPage', '13');
        await openFinished(finishedJobs(30));

        expect(perPage()).toHaveValue('20');
    });

    it('clamps the page when the finished list shrinks', async () => {
        const jobs = finishedJobs(45);
        const { user, fake } = await openFinished(jobs);

        await user.click(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByRole(
                'button',
                { name: 'Last page' },
            ),
        );
        expect(names()).toHaveLength(5);

        // Clear finished: only 12 jobs are left, so the list has 1 page.
        push(() => fake.emitJobs(finishedJobs(12)));

        expect(names()).toHaveLength(12);
        expect(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByText(
                '12 jobs',
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole('navigation', { name: 'Finished pagination, bottom' }),
        ).toBeNull();

        // Everything is cleared: the group and its pager row are gone.
        push(() => fake.emitJobs([]));
        expect(document.querySelector('.pager-row')).toBeNull();
    });

    it('keeps the page when new finished jobs arrive', async () => {
        const { user, fake } = await openFinished(finishedJobs(45));

        await user.click(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByRole(
                'button',
                { name: 'Next page' },
            ),
        );
        push(() => fake.emitJobs(finishedJobs(46)));

        expect(pageField('Finished pagination, top')).toHaveValue('2');
        expect(names()).toHaveLength(20);
    });

    it('keeps the page while the group is collapsed', async () => {
        const { user } = await openFinished(finishedJobs(45));

        await user.click(
            within(screen.getByRole('navigation', { name: 'Finished pagination, top' })).getByRole(
                'button',
                { name: 'Next page' },
            ),
        );
        await user.click(screen.getByRole('button', { name: /Finished/ }));
        expect(document.querySelector('.pager-row')).toBeNull();

        await user.click(screen.getByRole('button', { name: /Finished/ }));
        expect(pageField('Finished pagination, top')).toHaveValue('2');
    });

    it('shows the count only (no page controls, no bottom pager) when everything fits one page', async () => {
        await openFinished(finishedJobs(15));

        const top = screen.getByRole('navigation', { name: 'Finished pagination, top' });

        expect(within(top).getByText('15 jobs')).toBeInTheDocument();
        expect(within(top).queryByRole('button', { name: 'Next page' })).toBeNull();
        expect(perPage()).toBeInTheDocument();
        expect(
            screen.queryByRole('navigation', { name: 'Finished pagination, bottom' }),
        ).toBeNull();
    });

    it('hides the whole pager row for a short list', async () => {
        await openFinished(finishedJobs(10));

        expect(names()).toHaveLength(10);
        expect(document.querySelector('.pager-row')).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Items per page' })).toBeNull();
    });

    it('never pages the Running, Waiting and Needs-attention groups', async () => {
        const live = [
            ...Array.from({ length: 25 }, (_, i) =>
                makeJob({ id: `r${i}`, fileName: `run-${i}.mp4`, state: 'uploading' }),
            ),
            ...Array.from({ length: 25 }, (_, i) =>
                makeJob({ id: `w${i}`, fileName: `wait-${i}.mp4`, state: 'waiting' }),
            ),
            ...Array.from({ length: 25 }, (_, i) =>
                makeJob({ id: `f${i}`, fileName: `fail-${i}.mp4`, state: 'register_failed' }),
            ),
        ];

        await renderQueue({ jobs: live });

        expect(names()).toHaveLength(75);
        expect(document.querySelector('.pager-row')).toBeNull();
        expect(screen.queryByRole('navigation', { name: /pagination/i })).toBeNull();
    });

    it('pages the Finished group only, next to full live groups', async () => {
        await openFinished([
            ...finishedJobs(30),
            ...Array.from({ length: 25 }, (_, i) =>
                makeJob({ id: `r${i}`, fileName: `run-${i}.mp4`, state: 'uploading' }),
            ),
        ]);

        // 25 live rows + 20 finished rows on the first page.
        expect(names()).toHaveLength(45);
    });
});
