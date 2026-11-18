import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideosListResult } from '../../../shared/ipc';
import { makeVideo } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

const LAST = 120;

async function openLibrary() {
    const rendered = await renderApp();
    const list = vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation((params) => {
        const { page } = params as { page: number };

        return Promise.resolve<VideosListResult>({
            ok: true,
            data: [makeVideo({ id: page, title: `Clip ${page}` })],
            meta: { page, perPage: 24, total: LAST * 24, lastPage: LAST },
        });
    });

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByText(`Page 1 of ${LAST} · ${LAST * 24} videos`);

    return { ...rendered, list };
}

const pagesRequested = (list: { mock: { calls: unknown[][] } }) =>
    list.mock.calls.map((call) => (call[0] as { page: number }).page);

describe('Library pagination', () => {
    it('uses the pager component with the numbers and the jump field', async () => {
        await openLibrary();

        expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
        expect(screen.getByRole('textbox', { name: 'Go to page' })).toBeInTheDocument();
    });

    it('fetches the clicked page, and Last / First move to the ends', async () => {
        const { user, list } = await openLibrary();

        await user.click(screen.getByRole('button', { name: 'Page 3' }));
        await screen.findByText(`Page 3 of ${LAST} · ${LAST * 24} videos`);

        await user.click(screen.getByRole('button', { name: 'Last page' }));
        await screen.findByText(`Page ${LAST} of ${LAST} · ${LAST * 24} videos`);
        expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

        await user.click(screen.getByRole('button', { name: 'First page' }));
        await screen.findByText(`Page 1 of ${LAST} · ${LAST * 24} videos`);

        expect(pagesRequested(list).slice(-3)).toEqual([3, LAST, 1]);
    });

    it('jumps with the field (clamped) and ignores invalid input', async () => {
        const { user, list } = await openLibrary();
        const field = screen.getByRole('textbox', { name: 'Go to page' });
        const calls = list.mock.calls.length;

        await user.type(field, 'x{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Enter a page number from 1 to 120.');
        expect(list.mock.calls.length).toBe(calls);

        await user.clear(field);
        await user.type(field, '5000{Enter}');
        await screen.findByText(`Page ${LAST} of ${LAST} · ${LAST * 24} videos`);

        await user.type(screen.getByRole('textbox', { name: 'Go to page' }), '42{Enter}');
        await screen.findByText(`Page 42 of ${LAST} · ${LAST * 24} videos`);
        await waitFor(() => expect(pagesRequested(list).slice(-2)).toEqual([LAST, 42]));
    });

    it('scrolls the panel back to the top and resets the selection on a page change', async () => {
        const { user } = await openLibrary();
        const scroller = document
            .querySelector<HTMLElement>('.library')
            ?.closest<HTMLElement>('.panel');

        expect(scroller).toBeTruthy();
        scroller!.scrollTop = 300;

        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 1' }));
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('0 selected');

        expect(scroller!.scrollTop).toBe(0);
    });

    it('colours the bulk delete button red and keeps Select and Refresh neutral', async () => {
        const { user } = await openLibrary();

        await user.click(screen.getByRole('button', { name: 'Select' }));
        expect(screen.getByRole('button', { name: 'Delete selected' })).toHaveClass(
            'btn-accent-danger',
        );
        expect(screen.getByRole('button', { name: 'Select' }).className).not.toContain('accent');
        expect(screen.getAllByRole('button', { name: 'Refresh' })[0]!.className).not.toContain(
            'accent',
        );
    });
});
