import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem, VideosListResult } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';

function ok(data: VideoListItem[], lastPage = 1): VideosListResult {
    return { ok: true, data, meta: { page: 1, perPage: 24, total: data.length, lastPage } };
}

async function openLibrary(data: VideoListItem[], lastPage = 1) {
    window.localStorage.setItem('hls-r2-studio:library-view', 'grid');

    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const list = vi
        .spyOn(videos, 'list')
        .mockImplementation(() => Promise.resolve(ok(data, lastPage)));
    const get = vi
        .spyOn(videos, 'get')
        .mockImplementation((id) =>
            Promise.resolve({ ok: true, video: makeVideoDetail({ id, title: 'Alpha' }) }),
        );
    const remove = vi.spyOn(videos, 'delete');

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return { ...rendered, list, get, remove };
}

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

describe('Library card details', () => {
    it('shows duration and quality as badges on the thumbnail and ONE muted meta line, omitting missing values', async () => {
        await openLibrary([
            makeVideo({
                id: 1,
                title: 'Alpha',
                duration: 3725,
                width: 1280,
                height: 2770,
                sizeBytes: 62 * 1024 * 1024,
                fps: 30,
                bitrateKbps: 2400,
            }),
            makeVideo({
                id: 2,
                title: 'Beta',
                status: 'processing',
                duration: null,
                width: null,
                height: null,
                sizeBytes: null,
                fps: null,
                bitrateKbps: null,
            }),
            makeVideo({ id: 3, title: 'Gamma', width: 3840, height: 2160 }),
        ]);

        const [first, second, third] = screen.getAllByRole('listitem');
        const media = (row: HTMLElement) => row.querySelector('.video-media') as HTMLElement;

        // Duration badge: bottom right of the thumbnail; quality badge: one compact badge.
        expect(within(media(first!)).getByText('1:02:05')).toHaveClass('video-badge-duration');
        expect(within(media(first!)).getByText('1080p')).toHaveClass('video-badge-quality');
        expect(within(media(third!)).getByText('4K')).toBeInTheDocument();

        // Under the title: plain muted lines, no pill backgrounds, no colored chips.
        const lines = Array.from(first!.querySelectorAll('.video-meta')).map(
            (line) => line.textContent,
        );

        expect(lines[0]).toBe('62 MB \u00b7 1280\u00d72770');
        expect(lines[1]).toBe('30 fps \u00b7 2400 kbps');
        expect(first!.querySelector('.spec')).toBeNull();
        expect(lines[2]).toMatch(/^Added Jan 1, 2026/);

        // Missing values are simply omitted (no badges, no dashes, only the date line is left).
        expect(second!.querySelector('.video-badge')).toBeNull();
        expect(
            Array.from(second!.querySelectorAll('.video-meta')).map((l) => l.textContent),
        ).toEqual([expect.stringMatching(/^Added /)]);
        expect(within(second!).queryByText('\u2014')).toBeNull();
    });

    it('shows the status chip only when the video is not ready; Ready stays available to assistive tech', async () => {
        await openLibrary([
            makeVideo({ id: 1, title: 'Alpha', status: 'ready' }),
            makeVideo({ id: 2, title: 'Beta', status: 'processing' }),
            makeVideo({ id: 3, title: 'Gamma', status: 'failed' }),
            makeVideo({ id: 4, title: 'Delta', status: 'pending' }),
        ]);

        const [ready, processing, failed, pending] = screen.getAllByRole('listitem');

        expect(ready!.querySelector('.chip')).toBeNull();
        expect(within(ready!).getByText('Ready')).toHaveClass('visually-hidden');
        expect(processing!.querySelector('.video-open > .chip')).toHaveTextContent('Processing');
        expect(failed!.querySelector('.video-open > .chip')).toHaveTextContent('Failed');
        expect(pending!.querySelector('.video-open > .chip')).toHaveTextContent('Pending');
    });

    it('reserves two title lines and lines the date up at the bottom of every card', async () => {
        await openLibrary([
            makeVideo({ id: 1, title: 'Short' }),
            makeVideo({ id: 2, title: 'A very long title '.repeat(8) }),
        ]);

        for (const row of screen.getAllByRole('listitem')) {
            // The date line is the last child of the text block (pushed down by margin-top: auto).
            const main = row.querySelector('.video-main') as HTMLElement;

            expect(main.lastElementChild).toHaveClass('video-added');
            expect(row.querySelector('.video-title')).toBeInTheDocument();
        }
    });

    it('shows every thumbnail in a square frame, whatever the video size', async () => {
        await openLibrary([
            makeVideo({
                id: 1,
                title: 'Portrait',
                width: 1080,
                height: 1920,
                thumbnailUrl: 'https://cdn.example.com/p.jpg',
            }),
            makeVideo({
                id: 2,
                title: 'Landscape',
                width: 1920,
                height: 800,
                thumbnailUrl: 'https://cdn.example.com/l.jpg',
            }),
            makeVideo({ id: 3, title: 'Unknown', width: null, height: null, thumbnailUrl: null }),
        ]);

        const frames = document.querySelectorAll('.video-media .thumb-frame');

        expect(frames).toHaveLength(3);
        // One shared square box (CSS: aspect-ratio 1 / 1, object-fit cover): no per-video ratio.
        for (const frame of frames) expect((frame as HTMLElement).getAttribute('style')).toBeNull();
        expect(document.querySelector('.thumb-ratio')).toBeNull();
        expect(frames[0]!.querySelector('img.thumb')).not.toBeNull();
        expect(frames[2]).toHaveTextContent('No thumbnail');
    });

    it('keeps the page title once: the in-page heading is only for assistive tech', async () => {
        await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);

        const heading = screen.getByRole('heading', { level: 2, name: 'Library' });

        expect(heading).toHaveClass('visually-hidden');
        expect(screen.getAllByText('1 video')[0]!).toBeInTheDocument();
    });

    it('puts the single quick action and the kebab in the card footer', async () => {
        await openLibrary([makeVideo({ id: 1, title: 'Alpha', status: 'ready' })]);

        const card = screen.getAllByRole('listitem')[0]!;
        const tools = card.querySelector('.video-tools') as HTMLElement;

        expect(
            within(tools).getByRole('button', { name: 'Copy shortcode for Alpha' }),
        ).toBeVisible();
        expect(within(tools).getByRole('button', { name: 'More actions for Alpha' })).toBeVisible();
        expect(within(tools).getAllByRole('button')).toHaveLength(2);
    });
});

describe('Library sort and page size', () => {
    it('sends the sort to the server and goes back to page 1', async () => {
        const { user, list } = await openLibrary([makeVideo({ title: 'Alpha' })]);

        await user.selectOptions(screen.getByLabelText('Sort by'), 'Title A-Z');
        await waitFor(() =>
            expect(list).toHaveBeenLastCalledWith({ page: 1, perPage: 24, sort: 'title_asc' }),
        );

        await user.selectOptions(screen.getByLabelText('Sort by'), 'Newest');
        await waitFor(() => expect(list).toHaveBeenLastCalledWith({ page: 1, perPage: 24 }));
    });

    it('offers 12 / 24 / 36 / 48 items per page in a styled dropdown and refetches from page 1', async () => {
        const { user, list } = await openLibrary([makeVideo({ title: 'Alpha' })]);
        // One select, in the toolbar (the pagers no longer carry it).
        const select = screen.getByRole('combobox', { name: 'Items per page' });

        expect(
            within(select!)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['12', '24', '36', '48']);
        expect(select).toHaveValue('24');
        // The shared select draws its chevron as an inline SVG, not as a text glyph.
        expect(select!.closest('.select')?.querySelector('svg.icon')).not.toBeNull();

        await user.selectOptions(select!, '36');
        await waitFor(() => expect(list).toHaveBeenLastCalledWith({ page: 1, perPage: 36 }));
        expect(select).toHaveValue('36');
        // Not persisted: only the session keeps the choice.
        expect(window.localStorage.getItem('hls-r2-studio:library-page-size')).toBeNull();
    });

    it('always starts with 24 per page, whatever an old saved value says', async () => {
        window.localStorage.setItem('hls-r2-studio:library-page-size', '12');

        const { list } = await openLibrary([makeVideo({ title: 'Alpha' })]);

        expect(list).toHaveBeenCalledWith({ page: 1, perPage: 24 });
        expect(screen.getByRole('combobox', { name: 'Items per page' })).toHaveValue('24');
    });
});

describe('Library select mode controls', () => {
    it('has no Select button in the toolbar; Select is an item menu entry that picks that item', async () => {
        const { user } = await openLibrary([
            makeVideo({ id: 1, title: 'Alpha' }),
            makeVideo({ id: 2, title: 'Beta' }),
        ]);

        expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
        expect(screen.queryByRole('toolbar', { name: 'Selection' })).toBeNull();

        await enterSelectMode(user, 'Beta');

        expect(screen.getByRole('toolbar', { name: 'Selection' })).toBeInTheDocument();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).not.toBeChecked();
        // The per-item menus are hidden while selecting.
        expect(screen.queryByRole('button', { name: /^More actions for/ })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Exit select mode' }));
        expect(screen.queryByRole('toolbar', { name: 'Selection' })).toBeNull();
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(screen.getByRole('button', { name: 'More actions for Alpha' })).toBeInTheDocument();
    });

    it('offers Grid / List as icon-only buttons reachable by their accessible names', async () => {
        const { user } = await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);
        const group = screen.getByRole('group', { name: 'View' });
        const grid = within(group).getByRole('button', { name: 'Grid' });
        const list = within(group).getByRole('button', { name: 'List' });

        for (const button of [grid, list]) {
            expect(button.textContent).toBe('');
            expect(button.querySelectorAll('svg')).toHaveLength(1);
        }

        expect(grid).toHaveAttribute('title', 'Grid');
        expect(list).toHaveAttribute('title', 'List');
        expect(grid).toHaveAttribute('aria-pressed', 'true');

        await user.click(list);
        expect(list).toHaveAttribute('aria-pressed', 'true');
        expect(grid).toHaveAttribute('aria-pressed', 'false');
    });

    it('puts the view controls above the top pager, and the pager above the list', async () => {
        await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);

        const pager = screen.getAllByRole('navigation', { name: 'Pagination, top' })[0]!;
        const controls = screen.getByRole('group', { name: 'View' });
        const list = screen.getByRole('list', { name: 'Videos' });

        expect(
            controls.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(pager.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('toggles select all / unselect all, with a tri-state box and no Clear button', async () => {
        const { user } = await openLibrary([
            makeVideo({ id: 1, title: 'One' }),
            makeVideo({ id: 2, title: 'Two' }),
        ]);

        await enterSelectMode(user, 'One');
        expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

        const toggle = () => screen.getByRole('button', { name: /all on this page$/ });
        const label = toggle().textContent;

        expect(label).toBe('Select all');
        // One is already picked by the menu entry; "Two" is not.
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(toggle().textContent).toBe(label);
        // Some selected: still offers "select all".
        await user.click(screen.getByRole('button', { name: 'Select all on this page' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();

        // All selected: the visible text and the icon box are unchanged (only the accessible name
        // and the fill differ).
        expect(toggle().textContent).toBe(label);
        expect(toggle().querySelectorAll('svg')).toHaveLength(1);
        expect(toggle()).toHaveClass('btn-tonal');

        await user.click(screen.getByRole('button', { name: 'Unselect all on this page' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        expect(toggle().textContent).toBe(label);
    });
});

describe('Library card menu', () => {
    it('Edit opens the detail page', async () => {
        const { user, get } = await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

        await screen.findByText('Information');
        expect(get).toHaveBeenCalledWith(1);
    });

    it('Delete asks first, then deletes and reloads the list', async () => {
        const { user, remove, list } = await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);

        remove.mockResolvedValue({ ok: true, status: 'deleted', message: 'Video deleted.' });

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

        const dialog = screen.getByRole('alertdialog');

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(remove).not.toHaveBeenCalled();

        const calls = list.mock.calls.length;

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(remove).toHaveBeenCalledWith(1);
        expect(await screen.findByText('Video deleted.')).toBeInTheDocument();
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
    });

    it('Delete of a video that is still processing reports it and does not reload', async () => {
        const { user, remove } = await openLibrary([
            makeVideo({ id: 2, title: 'Beta', status: 'processing' }),
        ]);

        remove.mockResolvedValue({ ok: true, status: 'skipped', message: 'skipped' });

        await user.click(screen.getByRole('button', { name: 'More actions for Beta' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/still processing/)).toBeInTheDocument();
    });

    it('Esc closes the menu and returns the focus to the kebab button', async () => {
        const { user } = await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);
        const kebab = screen.getByRole('button', { name: 'More actions for Alpha' });

        await user.click(kebab);
        expect(screen.getByRole('menu')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(kebab).toHaveFocus();
    });
});

describe('Library bulk delete', () => {
    it('reports a partial failure from the server and leaves select mode', async () => {
        const { user, fake } = await openLibrary([
            makeVideo({ id: 1, title: 'One' }),
            makeVideo({ id: 2, title: 'Two' }),
        ]);
        const bulk = vi.spyOn(fake.api.videos, 'bulkDelete').mockResolvedValue({
            ok: true,
            deleted: 1,
            failed: 1,
            skipped: 0,
            message: 'Deleted 1 video, 1 failed.',
        });

        await enterSelectMode(user, 'One');
        await user.click(screen.getByRole('button', { name: 'Select all on this page' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(bulk).toHaveBeenCalledWith([1, 2]);
        expect(await screen.findByText(/Deleted 1 video, 1 failed\./)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
    });
});

describe('Library loading', () => {
    it('shows skeleton cards (hidden from assistive tech) and a status announcement while loading', async () => {
        window.localStorage.setItem('hls-r2-studio:library-view', 'grid');

        const rendered = await renderApp();
        let finish: (result: VideosListResult) => void = () => undefined;

        vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation(
            () =>
                new Promise<VideosListResult>((resolve) => {
                    finish = resolve;
                }),
        );
        await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));

        const skeleton = document.querySelector('.videos-skeleton') as HTMLElement;

        expect(skeleton).toHaveAttribute('aria-hidden', 'true');
        expect(skeleton.querySelectorAll('.video-skeleton').length).toBeGreaterThan(0);
        expect(skeleton.querySelector('.thumb-frame')).not.toBeNull();
        expect(
            screen.getAllByRole('status').some((node) => node.getAttribute('aria-busy') === 'true'),
        ).toBe(true);
        expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);

        finish(ok([makeVideo({ title: 'Alpha' })]));
        await screen.findByRole('list', { name: 'Videos' });
        expect(document.querySelector('.videos-skeleton')).toBeNull();
    });

    it('marks thumbnails as lazy and async decoded', async () => {
        await openLibrary([
            makeVideo({ title: 'Alpha', thumbnailUrl: 'https://cdn.example.com/a.jpg' }),
        ]);

        const img = document.querySelector('.video-media img') as HTMLImageElement;

        expect(img).toHaveAttribute('loading', 'lazy');
        expect(img).toHaveAttribute('decoding', 'async');
    });
});

describe('Library search box and count', () => {
    it('has an explicit primary Search button with the search icon next to the input', async () => {
        await openLibrary([makeVideo({ title: 'Alpha' })]);

        const form = screen.getByRole('search');
        const button = within(form).getByRole('button', { name: 'Search' });

        expect(button).toHaveClass('btn-primary');
        expect(button).toHaveAttribute('type', 'submit');
        expect(button.querySelector('svg.icon')).not.toBeNull();
        expect(within(form).getByLabelText('Search videos')).toBeInTheDocument();
        // The leading search icon is gone: the icon lives on the button.
        expect(form.querySelectorAll('svg.icon')).toHaveLength(1);
    });

    it('shows the total only in the pager, not in the toolbar, with no status filter', async () => {
        await openLibrary([makeVideo({ title: 'Alpha' })]);

        const total = within(screen.getByRole('navigation', { name: 'Pagination, top' })).getByRole(
            'status',
        );

        expect(total).toHaveTextContent('1 video');
        expect(document.querySelector('.library-total')).toBeNull();
        expect(
            within(document.querySelector<HTMLElement>('.library-toolbar')!).queryByText('1 video'),
        ).toBeNull();
        expect(screen.queryByRole('group', { name: 'Status filter' })).toBeNull();
        expect(document.querySelector('.library-subbar, .library-controls')).toBeNull();
    });

    it('puts search, sort, per page, Grid/List and Refresh in one toolbar, above the top pager and the list', async () => {
        await openLibrary([makeVideo({ title: 'Alpha' })]);

        const toolbar = document.querySelector<HTMLElement>('.library-toolbar')!;
        const inToolbar = within(toolbar);

        expect(inToolbar.getByRole('search')).toBeInTheDocument();
        expect(inToolbar.getByRole('button', { name: 'Search' })).toBeInTheDocument();
        expect(inToolbar.getByLabelText('Sort by')).toBeInTheDocument();
        expect(inToolbar.getByText('Per page')).toBeInTheDocument();
        expect(inToolbar.getByRole('combobox', { name: 'Items per page' })).toBeInTheDocument();
        expect(inToolbar.getByRole('button', { name: 'Grid' })).toBeInTheDocument();
        expect(inToolbar.getByRole('button', { name: 'List' })).toBeInTheDocument();
        expect(inToolbar.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

        const pagerTop = screen.getByRole('navigation', { name: 'Pagination, top' });
        const list = screen.getByRole('list', { name: 'Videos' });

        expect(toolbar.contains(pagerTop)).toBe(false);
        expect(
            toolbar.compareDocumentPosition(pagerTop) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            pagerTop.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
});
