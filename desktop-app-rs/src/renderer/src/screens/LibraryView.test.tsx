import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem, VideosListResult } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';
import { waitForPage } from '../testing/pager';

const KEY = 'hls-r2-studio:library-view';

function ok(data: VideoListItem[], page = 1, lastPage = 1): VideosListResult {
    return { ok: true, data, meta: { page, perPage: 24, total: data.length, lastPage } };
}

function clips(count: number): VideoListItem[] {
    return Array.from({ length: count }, (_, index) =>
        makeVideo({ id: index + 1, title: `Clip ${index + 1}`, duration: 75 }),
    );
}

async function openLibrary(list: (params?: unknown) => Promise<VideosListResult>) {
    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const spy = vi.spyOn(videos, 'list').mockImplementation(list);
    const bulkDelete = vi.spyOn(videos, 'bulkDelete').mockImplementation((ids) =>
        Promise.resolve({
            ok: true,
            deleted: ids.length,
            failed: 0,
            skipped: 0,
            message: `Deleted ${ids.length} videos.`,
        }),
    );

    vi.spyOn(videos, 'get').mockImplementation((id) =>
        Promise.resolve({ ok: true, video: makeVideoDetail({ id, title: `Clip ${id}` }) }),
    );

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return { ...rendered, spy, bulkDelete };
}

function viewButton(name: 'Grid' | 'List'): HTMLElement {
    return within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name });
}

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

describe('Library view toggle', () => {
    it('defaults to Grid, switches to List and back, and follows aria-pressed', async () => {
        const { user } = await openLibrary(() => Promise.resolve(ok(clips(2))));

        expect(viewButton('Grid')).toHaveAttribute('aria-pressed', 'true');
        expect(viewButton('List')).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('list', { name: 'Videos' })).not.toHaveClass('videos-list');
        expect(screen.queryByText('Duration')).toBeNull();

        await user.click(viewButton('List'));

        expect(viewButton('Grid')).toHaveAttribute('aria-pressed', 'false');
        expect(viewButton('List')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('list', { name: 'Videos' })).toHaveClass('videos-list');
        expect(screen.getByText('Duration')).toBeInTheDocument();
        expect(window.localStorage.getItem(KEY)).toBe('list');

        await user.click(viewButton('Grid'));

        expect(viewButton('Grid')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('list', { name: 'Videos' })).not.toHaveClass('videos-list');
        expect(window.localStorage.getItem(KEY)).toBe('grid');
    });

    it('starts in List when that was saved', async () => {
        window.localStorage.setItem(KEY, 'list');
        await openLibrary(() => Promise.resolve(ok(clips(1))));

        expect(viewButton('List')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('list', { name: 'Videos' })).toHaveClass('videos-list');
    });

    it('falls back to Grid for an invalid saved value', async () => {
        window.localStorage.setItem(KEY, 'table');
        await openLibrary(() => Promise.resolve(ok(clips(1))));

        expect(viewButton('Grid')).toHaveAttribute('aria-pressed', 'true');
    });

    it('falls back to Grid and does not crash when storage throws', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });

        const { user } = await openLibrary(() => Promise.resolve(ok(clips(1))));

        expect(viewButton('Grid')).toHaveAttribute('aria-pressed', 'true');

        await user.click(viewButton('List'));

        expect(viewButton('List')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('list', { name: 'Videos' })).toHaveClass('videos-list');
    });

    it('keeps page, search and selection and does not reload when the view changes', async () => {
        const { user, spy } = await openLibrary((params) => {
            const { page } = params as { page: number };

            return Promise.resolve(ok([makeVideo({ id: page, title: `Page ${page}` })], page, 3));
        });

        // A submitted search resets the page and the selection, so let it settle (wait for its
        // request) before going to page 2 and selecting.
        await user.type(screen.getByLabelText('Search videos'), 'ab{Enter}');
        await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ q: 'ab' })));
        await screen.findByText('Page 1');
        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        await screen.findByText('Page 2');
        await enterSelectMode(user, 'Page 2');

        const calls = spy.mock.calls.length;

        await user.click(viewButton('List'));

        expect(screen.getByLabelText('Search videos')).toHaveValue('ab');
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]!).toHaveValue('2');
        expect(screen.getByRole('checkbox', { name: 'Select Page 2' })).toBeChecked();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(spy.mock.calls.length).toBe(calls);

        await user.click(viewButton('Grid'));

        expect(screen.getByRole('checkbox', { name: 'Select Page 2' })).toBeChecked();
        expect(spy.mock.calls.length).toBe(calls);
    });
});

describe('Library List view', () => {
    it('shows thumbnail, title, status, duration and date cells', async () => {
        window.localStorage.setItem(KEY, 'list');
        await openLibrary(() =>
            Promise.resolve(
                ok([
                    makeVideo({
                        id: 1,
                        title: 'Holiday',
                        duration: 75,
                        thumbnailUrl: 'https://cdn.example.com/a.jpg',
                    }),
                    makeVideo({ id: 2, title: 'Broken', status: 'failed', thumbnailUrl: null }),
                ]),
            ),
        );

        const rows = screen.getAllByRole('listitem');

        expect(rows).toHaveLength(2);
        expect(within(rows[0]!).getByText('Holiday')).toHaveAttribute('title', 'Holiday');
        expect(within(rows[0]!).getByText('Ready')).toBeInTheDocument();
        expect(within(rows[0]!).getByText('1:15')).toBeInTheDocument();
        expect(within(rows[0]!).getByText(/Jan 1, 2026/)).toBeInTheDocument();
        expect(rows[0]!.querySelector('img')).toHaveAttribute(
            'src',
            'https://cdn.example.com/a.jpg',
        );
        expect(within(rows[1]!).getByText('No thumbnail')).toBeInTheDocument();
        expect(within(rows[1]!).getByText('Failed')).toBeInTheDocument();

        // The narrow-width hiding is CSS only: every cell stays in the DOM.
        expect(rows[0]!.querySelector('.video-duration')).not.toBeNull();
        expect(rows[0]!.querySelector('.video-created')).not.toBeNull();
    });

    it('falls back to the placeholder when the image fails to load', async () => {
        window.localStorage.setItem(KEY, 'list');
        await openLibrary(() =>
            Promise.resolve(ok([makeVideo({ thumbnailUrl: 'https://cdn.example.com/a.jpg' })])),
        );

        const row = screen.getAllByRole('listitem')[0]!;

        fireEvent.error(row.querySelector('img')!);

        expect(row.querySelector('img')).toBeNull();
        expect(within(row).getByText('No thumbnail')).toBeInTheDocument();
    });

    it('opens the detail page by click and by keyboard, and returns focus after Back', async () => {
        window.localStorage.setItem(KEY, 'list');

        const { user } = await openLibrary(() => Promise.resolve(ok(clips(2))));
        const opener = screen.getByRole('button', { name: /^Clip 2/ });

        await user.click(opener);
        expect(await screen.findByRole('region', { name: 'Video details' })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        await waitFor(() => expect(opener).toHaveFocus());

        opener.focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('region', { name: 'Video details' })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        await waitFor(() => expect(opener).toHaveFocus());

        await user.keyboard(' ');
        expect(await screen.findByRole('region', { name: 'Video details' })).toBeInTheDocument();
    });

    it('toggles selection instead of opening, and confirms the bulk delete count', async () => {
        window.localStorage.setItem(KEY, 'list');

        const { user, bulkDelete } = await openLibrary(() => Promise.resolve(ok(clips(3))));

        await enterSelectMode(user, 'Clip 1');
        expect(screen.queryByRole('button', { name: /^Clip 1/ })).toBeNull();
        expect(screen.getByRole('checkbox', { name: 'Select Clip 1' })).toBeChecked();

        await user.click(screen.getByText('Clip 2'));

        expect(screen.getByRole('checkbox', { name: 'Select Clip 2' })).toBeChecked();
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Video details' })).toBeNull();
        expect(screen.getByRole('checkbox', { name: 'Select Clip 2' }).closest('li')).toHaveClass(
            'is-picked',
        );

        await user.click(screen.getByRole('button', { name: 'Delete selected' }));

        const dialog = screen.getByRole('alertdialog');

        expect(within(dialog).getByText(/^Delete 2 videos\?/)).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        expect(bulkDelete).toHaveBeenCalledWith([1, 2]);
    });
});
