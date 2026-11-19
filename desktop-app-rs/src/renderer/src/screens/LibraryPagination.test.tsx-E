import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideosListResult } from '../../../shared/ipc';
import { makeVideo } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';
import { waitForPage } from '../testing/pager';

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
    await waitForPage(1);

    return { ...rendered, list };
}

const pagesRequested = (list: { mock: { calls: unknown[][] } }) =>
    list.mock.calls.map((call) => (call[0] as { page: number }).page);

describe('Library pagination', () => {
    it('uses the pager component with the count and the current-page field', async () => {
        await openLibrary();

        expect(screen.getByRole('navigation', { name: 'Pagination, top' })).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: 'Pagination, bottom' })).toBeInTheDocument();
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]!).toHaveValue('1');
        expect(screen.getAllByText(`of ${LAST}`)).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'First page' })[0]!).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Page 1' })).toBeNull();
    });

    it('renders two identical pagers (top and bottom), neither of them sticky', async () => {
        await openLibrary();

        const top = screen.getByRole('navigation', { name: 'Pagination, top' });
        const bottom = screen.getByRole('navigation', { name: 'Pagination, bottom' });

        // The top one sits above the list, the bottom one below it, both in normal flow.
        const list = screen.getByRole('list', { name: 'Videos' });

        expect(top.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(
            list.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        // Same content in both: count, nav buttons, current-page field (Per page lives in the toolbar).
        expect(top.innerHTML.replace(/id="[^"]*"|for="[^"]*"|aria-describedby="[^"]*"/g, '')).toBe(
            bottom.innerHTML.replace(/id="[^"]*"|for="[^"]*"|aria-describedby="[^"]*"/g, ''),
        );
        expect(within(top).getByRole('status')).toHaveTextContent('2880 videos');
        expect(within(top).queryByRole('combobox')).toBeNull();
        expect(within(bottom).queryByRole('combobox')).toBeNull();
        expect(screen.getAllByRole('combobox', { name: 'Items per page' })).toHaveLength(1);
        expect(top.className).toBe(bottom.className);
        expect(top.className).not.toMatch(/sticky/);
    });

    it('keeps both pagers in sync: a page change in either one updates both, and a per-page change resets both to page 1', async () => {
        const { user, list } = await openLibrary();
        const top = () => screen.getByRole('navigation', { name: 'Pagination, top' });
        const bottom = () => screen.getByRole('navigation', { name: 'Pagination, bottom' });

        await user.click(within(top()).getByRole('button', { name: 'Next page' }));
        await waitFor(() =>
            expect(within(bottom()).getByRole('textbox', { name: 'Current page' })).toHaveValue(
                '2',
            ),
        );

        await user.selectOptions(screen.getByRole('combobox', { name: 'Items per page' }), '36');
        await waitFor(() =>
            expect(screen.getByRole('combobox', { name: 'Items per page' })).toHaveValue('36'),
        );
        await waitFor(() =>
            expect(within(bottom()).getByRole('textbox', { name: 'Current page' })).toHaveValue(
                '1',
            ),
        );
        expect(list).toHaveBeenLastCalledWith({ page: 1, perPage: 36 });
    });

    it('fetches the next page, and Last / First move to the ends', async () => {
        const { user, list } = await openLibrary();

        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        await waitForPage(2);

        await user.click(screen.getAllByRole('button', { name: 'Last page' })[0]!);
        await waitForPage(LAST);
        expect(screen.getAllByRole('button', { name: 'Next page' })[0]!).toBeDisabled();

        await user.click(screen.getAllByRole('button', { name: 'First page' })[0]!);
        await waitForPage(1);

        expect(pagesRequested(list).slice(-3)).toEqual([2, LAST, 1]);
    });

    it('jumps with the field (clamped) and ignores invalid input', async () => {
        const { user, list } = await openLibrary();
        const field = screen.getAllByRole('textbox', { name: 'Current page' })[0]!;
        const calls = list.mock.calls.length;

        await user.clear(field);
        await user.type(field, 'x{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Enter a page number from 1 to 120.');
        expect(list.mock.calls.length).toBe(calls);

        await user.clear(field);
        await user.type(field, '5000{Enter}');
        await waitForPage(LAST);

        const again = screen.getAllByRole('textbox', { name: 'Current page' })[0]!;

        await user.clear(again);
        await user.type(again, '42{Enter}');
        await waitForPage(42);
        await waitFor(() => expect(pagesRequested(list).slice(-2)).toEqual([LAST, 42]));
    });

    it('scrolls the panel back to the top and resets the selection on a page change', async () => {
        const { user } = await openLibrary();
        const scroller = document
            .querySelector<HTMLElement>('.library')
            ?.closest<HTMLElement>('.panel');

        expect(scroller).toBeTruthy();
        scroller!.scrollTop = 300;

        await enterSelectMode(user, 'Clip 1');
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        await screen.findByText('0 selected');

        expect(scroller!.scrollTop).toBe(0);
    });

    it('colours the bulk delete button red and keeps Cancel and Refresh neutral', async () => {
        const { user } = await openLibrary();

        await enterSelectMode(user, 'Clip 1');
        expect(screen.getByRole('button', { name: 'Delete selected' })).toHaveClass(
            'btn-accent-danger',
        );
        expect(screen.getByRole('button', { name: 'Exit select mode' }).className).not.toContain(
            'accent',
        );
        expect(screen.getAllByRole('button', { name: 'Refresh' })[0]!.className).not.toContain(
            'accent',
        );
    });
});
