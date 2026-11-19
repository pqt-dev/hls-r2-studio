import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem, VideosListResult } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';

function ok(data: VideoListItem[], lastPage = 1): VideosListResult {
    return { ok: true, data, meta: { page: 1, perPage: 24, total: data.length, lastPage } };
}

async function openLibrary(data: VideoListItem[], lastPage = 1, expectList = true) {
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
    if (expectList) await screen.findByRole('list', { name: 'Videos' });
    else await screen.findByRole('navigation', { name: 'Pagination, top' });

    return { ...rendered, list, get, remove };
}

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

describe('Library card details', () => {
    it('shows media info as tiered chips below the thumbnail, omitting missing values', async () => {
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
        const chipsOf = (row: HTMLElement) =>
            Array.from(row.querySelectorAll('.video-chips .spec')) as HTMLElement[];

        // Nothing is drawn over the thumbnail; the chips live in ONE wrapping area in the text block.
        expect(first!.querySelector('.video-media .spec')).toBeNull();
        expect(first!.querySelector('.video-badge')).toBeNull();
        expect(first!.querySelectorAll('.video-main .video-chips')).toHaveLength(1);
        expect(first!.querySelector('.video-chip-row')).toBeNull();

        // Same chips and order as the list row: quality, dimensions, orientation, bitrate, duration, size.
        const chips = chipsOf(first!);

        expect(chips.map((chip) => chip.textContent)).toEqual([
            '1080p',
            '1280\u00d72770',
            'Vertical',
            '2400 kbps',
            '1:02:05',
            '62 MB',
        ]);
        const [qualityChip, dimsChip, orientationChip, bitrateChip, duration, size] = chips;

        // Dimensions carry the quality tier.
        expect(qualityChip).toHaveClass('chip-tier-3');
        expect(dimsChip).toHaveClass('chip-tier-3');
        expect(bitrateChip).toHaveClass('chip-tier-3');
        expect(orientationChip!.className).not.toMatch(/chip-tier-/);
        expect(qualityChip!.querySelector('svg.icon')).not.toBeNull();
        expect(dimsChip!.querySelector('svg.icon')).toHaveAttribute('data-orientation', 'portrait');
        // Duration and size reuse the Home pills (same classes and icons).
        const added = first!.querySelector('.video-tools .video-added');

        expect(duration).toHaveClass('spec', 'spec-duration');
        expect(duration!.querySelector('svg.icon')).not.toBeNull();
        expect(size).toHaveClass('spec', 'spec-size');
        expect(size!.querySelector('svg.icon')).not.toBeNull();
        // The upload time is plain caption text in the footer: no chip, no icon.
        expect(added).not.toBeNull();
        expect(added).not.toHaveClass('spec');
        expect(added!.querySelector('svg')).toBeNull();
        // Value chips are hidden from assistive tech (the summary below carries them); the date is not.
        expect(chips.every((chip) => chip.getAttribute('aria-hidden') === 'true')).toBe(true);
        expect(added).not.toHaveAttribute('aria-hidden');
        expect(chipsOf(third!)[0]).toHaveTextContent('4K');
        expect(chipsOf(third!)[0]).toHaveClass('chip-tier-1');
        expect(chipsOf(third!)[1]).toHaveClass('chip-tier-1');

        // The old plain meta lines and the verbose "Added ..." line are gone.
        expect(first!.textContent).not.toContain('62 MB \u00b7');
        expect(first!.textContent).not.toMatch(/Added /);

        // Missing values have no chip (and no dash): nothing is left to draw.
        expect(second!.querySelector('.video-chips')).toBeNull();
        expect(within(second!).queryByText('\u2014')).toBeNull();
    });

    it('uses one neutral icon for the quality chip, whatever the resolution', async () => {
        await openLibrary([
            makeVideo({ id: 1, title: 'Wide', width: 1920, height: 1080 }),
            makeVideo({ id: 2, title: 'Small', width: 1280, height: 720 }),
        ]);

        const rows = screen.getAllByRole('listitem');
        const icon = (row: HTMLElement) => row.querySelector('.video-chips .spec svg.icon')!;
        const path = (row: HTMLElement) => icon(row).querySelector('path')!.getAttribute('d');

        // 1080p and 720p share the same neutral icon (no HD badge).
        expect(path(rows[0]!)).toBe(path(rows[1]!));
        expect(path(rows[0]!)).toMatch(/^M8\.77 7\.08/);
        expect(icon(rows[0]!)).not.toHaveAttribute('data-orientation');
        expect(icon(rows[0]!)).toHaveClass('icon-regular');
    });

    it('gives the dimensions chip the quality tier of the same video', async () => {
        await openLibrary([
            makeVideo({ id: 1, title: 'Tall', width: 1280, height: 2770 }),
            makeVideo({ id: 2, title: 'Wide', width: 3840, height: 2160 }),
            makeVideo({ id: 3, title: 'Small', width: 854, height: 480 }),
        ]);

        for (const row of screen.getAllByRole('listitem')) {
            const quality = row.querySelector('.video-chips [title="Quality"]')!;
            const dims = row.querySelector('.video-chips [title="Dimensions"]')!;
            const tier = /chip-tier-\d/.exec(quality.className)![0];

            expect(dims).toHaveClass(tier);
        }
    });

    it('exposes the media info once for assistive tech, after the title', async () => {
        await openLibrary([
            makeVideo({
                id: 1,
                title: 'Alpha',
                duration: 75,
                width: 1920,
                height: 1080,
                sizeBytes: 62 * 1024 * 1024,
                fps: 30,
                bitrateKbps: 2400,
            }),
        ]);

        const [row] = screen.getAllByRole('listitem');
        const summary = row!.querySelector('.video-open > .visually-hidden');
        const texts = Array.from(row!.querySelectorAll('.video-open > .visually-hidden')).map(
            (node) => node.textContent,
        );

        expect(summary).not.toBeNull();
        expect(texts).toContain(
            '1080p, Duration 1:15, 2400 kbps, 30 fps, 1920\u00d71080, Horizontal, 62 MB',
        );
        const title = row!.querySelector('.video-title')!;

        expect(
            title.compareDocumentPosition(summary!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it('shows a compact upload time with the full date-time as tooltip', async () => {
        const thisYear = new Date().getFullYear();

        await openLibrary([
            makeVideo({
                id: 1,
                title: 'Recent',
                createdAt: new Date(thisYear, 0, 5, 11, 59).toISOString(),
            }),
            makeVideo({
                id: 2,
                title: 'Old',
                createdAt: new Date(2001, 10, 18, 23, 5).toISOString(),
            }),
        ]);

        const [recent, old] = screen.getAllByRole('listitem');
        const flat = (node: Element | null) => node!.textContent!.replace(/\s/g, ' ');

        expect(recent!.querySelector('.spec-date')).toBeNull();
        expect(flat(recent!.querySelector('.video-added'))).toBe('Jan 5, 11:59 AM');
        expect(flat(old!.querySelector('.video-added'))).toBe('Nov 18, 2001, 11:05 PM');
        expect(recent!.querySelector('.video-added')).toHaveAttribute(
            'title',
            expect.stringMatching(/^Jan 5, \d{4}/),
        );
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

    it('reserves two title lines and keeps the chips at the bottom of the text block', async () => {
        await openLibrary([
            makeVideo({ id: 1, title: 'Short' }),
            makeVideo({ id: 2, title: 'A very long title '.repeat(8) }),
        ]);

        for (const row of screen.getAllByRole('listitem')) {
            // The chip rows are the last child of the text block (pushed down by margin-top: auto).
            const main = row.querySelector('.video-main') as HTMLElement;

            expect(main.lastElementChild).toHaveClass('video-chips');
            expect(row.querySelector('.video-title')).toBeInTheDocument();
        }
    });

    it('shows the compact date as plain text left of the three quick buttons in the footer', async () => {
        await openLibrary([
            makeVideo({
                id: 1,
                title: 'Alpha',
                thumbnailUrl: 'https://cdn.example.com/a.jpg',
                createdAt: new Date(2001, 10, 18, 23, 5).toISOString(),
            }),
        ]);

        const [card] = screen.getAllByRole('listitem');
        const tools = card!.querySelector('.video-tools')!;
        const children = Array.from(tools.children);

        // The caption, then the shared quick actions cluster (shortcode, thumbnail, menu).
        expect(children).toHaveLength(2);
        expect(children[0]).toHaveClass('video-added');
        expect(children[0]!.tagName).toBe('SPAN');
        expect(children[1]).toHaveClass('video-actions');
        expect(within(children[1] as HTMLElement).getAllByRole('button')).toHaveLength(3);
        expect(card!.querySelector('.spec-date')).toBeNull();
        expect(card!.querySelector('.video-chips .video-added')).toBeNull();
        // The date text appears once.
        expect(card!.textContent!.match(/Nov 18, 2001/g)).toHaveLength(1);
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
        // Grouped side by side: the shortcode button sits immediately before the menu button.
        const menuButton = within(tools).getByRole('button', { name: 'More actions for Alpha' });

        expect(menuButton.closest('.video-menu')!.previousElementSibling).toBe(
            within(tools).getByRole('button', { name: 'Copy shortcode for Alpha' }),
        );
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
        // Saved as a UI preference.
        expect(window.localStorage.getItem('hls.library.perPage')).toBe('36');
    });

    it('starts with the saved page size, and with 24 when the saved value is not an option', async () => {
        window.localStorage.setItem('hls.library.perPage', '12');

        const first = await openLibrary([makeVideo({ title: 'Alpha' })]);

        expect(first.list).toHaveBeenCalledWith({ page: 1, perPage: 12 });
        expect(screen.getByRole('combobox', { name: 'Items per page' })).toHaveValue('12');
        cleanup();

        window.localStorage.setItem('hls.library.perPage', '7');

        const second = await openLibrary([makeVideo({ title: 'Alpha' })]);

        expect(second.list).toHaveBeenCalledWith({ page: 1, perPage: 24 });
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

    it('toggles select all / unselect all with distinct none / some / all states', async () => {
        const { user } = await openLibrary([
            makeVideo({ id: 1, title: 'One' }),
            makeVideo({ id: 2, title: 'Two' }),
        ]);

        await enterSelectMode(user, 'One');
        expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

        const toggle = () => screen.getByRole('button', { name: /all on this page$/ });
        const label = toggle().textContent;

        expect(label).toBe('Select all');
        expect(toggle().querySelector('svg')).toBeNull();
        // One is already picked by the menu entry; "Two" is not.
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(toggle()).toHaveClass('btn-select-toggle', 'is-some');
        expect(toggle()).not.toHaveClass('is-all');
        // Some selected: still offers "select all".
        await user.click(screen.getByRole('button', { name: 'Select all on this page' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();

        expect(toggle().textContent).toBe('Unselect all');
        expect(toggle()).toHaveClass('btn-select-toggle', 'is-all');
        expect(toggle()).not.toHaveClass('is-some');

        await user.click(screen.getByRole('button', { name: 'Unselect all on this page' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        expect(toggle().textContent).toBe(label);
        expect(toggle()).toHaveClass('btn-select-toggle');
        expect(toggle()).not.toHaveClass('is-some');
        expect(toggle()).not.toHaveClass('is-all');
    });

    it('marks a picked card with a class and a checked checkbox, without a check icon', async () => {
        const { user } = await openLibrary([
            makeVideo({ id: 1, title: 'One' }),
            makeVideo({ id: 2, title: 'Two' }),
        ]);

        await enterSelectMode(user, 'One');

        const one = screen.getByRole('checkbox', { name: 'Select One' });
        const two = screen.getByRole('checkbox', { name: 'Select Two' });

        expect(one).toBeChecked();
        expect(one.closest('li')).toHaveClass('is-picked');
        expect(one.closest('li')?.querySelector('svg.icon-regular path[d^="M3.37"]')).toBeNull();
        expect(one.closest('li')?.querySelector('.video-check-box')).toBeNull();
        expect(two).not.toBeChecked();
        expect(two.closest('li')).not.toHaveClass('is-picked');
    });
});

describe('Library card menu', () => {
    it('Details opens the detail page', async () => {
        const { user, get } = await openLibrary([makeVideo({ id: 1, title: 'Alpha' })]);

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Details' }));

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
        expect(skeleton).toHaveClass('videos-skeleton-grid');
        expect(skeleton.querySelectorAll('.video-skeleton-card').length).toBeGreaterThan(0);
        expect(skeleton.querySelector('.video-skeleton-row')).toBeNull();
        expect(skeleton.querySelector('.thumb-frame')).not.toBeNull();
        expect(skeleton.querySelectorAll('.skeleton-chip').length).toBeGreaterThanOrEqual(4);
        expect(skeleton.querySelectorAll('.skeleton-btn')).toHaveLength(
            3 * skeleton.querySelectorAll('.video-skeleton-card').length,
        );
        const refresh = screen.getByRole('button', { name: 'Refresh' });

        expect(refresh).toHaveAttribute('aria-busy', 'true');
        expect(refresh).toHaveClass('is-spinning');
        expect(
            screen.getAllByRole('status').some((node) => node.getAttribute('aria-busy') === 'true'),
        ).toBe(true);
        expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);

        finish(ok([makeVideo({ title: 'Alpha' })]));
        await screen.findByRole('list', { name: 'Videos' });
        expect(document.querySelector('.videos-skeleton')).toBeNull();
        expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
            'aria-busy',
            'false',
        );
        expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveClass('is-spinning');
    });

    it('shows list row placeholders with the list header in List mode', async () => {
        window.localStorage.setItem('hls-r2-studio:library-view', 'list');

        const rendered = await renderApp();

        vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation(
            () => new Promise<VideosListResult>(() => undefined),
        );
        await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));

        const skeleton = document.querySelector('.videos-skeleton') as HTMLElement;
        const wrap = skeleton.closest('.videos-wrap') as HTMLElement;

        expect(wrap).toHaveAttribute('aria-hidden', 'true');
        expect(wrap).toHaveClass('is-list');
        expect(wrap.querySelector('.videos-head')).not.toBeNull();
        expect(skeleton).toHaveClass('videos-list', 'videos-skeleton-list');
        expect(skeleton.querySelector('.video-skeleton-card')).toBeNull();
        expect(skeleton.querySelectorAll('.video-skeleton-row')).toHaveLength(6);
        expect(skeleton.querySelectorAll('.skeleton-status')).toHaveLength(6);
        expect(skeleton.querySelectorAll('.skeleton-btn')).toHaveLength(18);
        expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
            'aria-busy',
            'true',
        );
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

    it('Upload videos in the top pager row opens the picker and then the Queue when something was added', async () => {
        const { user, fake } = await openLibrary([makeVideo({ title: 'Alpha' })]);
        const addFiles = vi.fn(() => Promise.resolve({ added: 1, rejected: [], canceled: false }));

        fake.api.jobs.addFiles = addFiles;
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        await waitFor(() => expect(addFiles).toHaveBeenCalledTimes(1));
        expect(await screen.findByText('Added 1 video to the queue.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('Upload videos stays on Library when nothing was added and is disabled while adding', async () => {
        const { user, fake } = await openLibrary([makeVideo({ title: 'Alpha' })]);
        let finish: (value: { added: number; rejected: never[]; canceled: boolean }) => void = () =>
            undefined;
        const addFiles = vi.fn(
            () =>
                new Promise<{ added: number; rejected: never[]; canceled: boolean }>((resolve) => {
                    finish = resolve;
                }),
        );

        fake.api.jobs.addFiles = addFiles;
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        expect(screen.getByRole('button', { name: 'Upload videos' })).toBeDisabled();

        finish({ added: 0, rejected: [], canceled: true });

        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Upload videos' })).toBeEnabled(),
        );
        expect(addFiles).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
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
        expect(inToolbar.queryByRole('button', { name: 'Upload videos' })).toBeNull();

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

    it('places Upload videos at the start of the top pager row, before the pager', async () => {
        await openLibrary([makeVideo({ title: 'Alpha' })]);

        const row = document.querySelector<HTMLElement>('.pager-row')!;
        const upload = within(row).getByRole('button', { name: 'Upload videos' });
        const pagerTop = within(row).getByRole('navigation', { name: 'Pagination, top' });

        expect(
            upload.compareDocumentPosition(pagerTop) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            within(screen.getByRole('navigation', { name: 'Pagination, bottom' })).queryByRole(
                'button',
                { name: 'Upload videos' },
            ),
        ).toBeNull();
    });

    it('keeps Upload videos available in an empty library', async () => {
        await openLibrary([], 1, false);

        const row = document.querySelector<HTMLElement>('.pager-row')!;

        expect(within(row).getByRole('button', { name: 'Upload videos' })).toBeEnabled();
    });
});
