import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideoDetail } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

async function openDetail(partial: Partial<VideoDetail> = {}) {
    const rendered = await renderApp();
    const { videos } = rendered.fake.api;

    vi.spyOn(videos, 'list').mockResolvedValue({
        ok: true,
        data: [makeVideo({ id: 7, title: 'Holiday' })],
        meta: { page: 1, perPage: 24, total: 1, lastPage: 1 },
    });
    vi.spyOn(videos, 'get').mockImplementation((id) =>
        Promise.resolve({ ok: true, video: makeVideoDetail({ id, title: 'Holiday', ...partial }) }),
    );

    const copyLink = vi.spyOn(videos, 'copyLink');
    const openEmbed = vi.spyOn(videos, 'openEmbed');
    const remove = vi.spyOn(videos, 'delete').mockResolvedValue({
        ok: true,
        status: 'deleted',
        message: 'Video deleted.',
    });

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await rendered.user.click(await screen.findByRole('button', { name: /^Holiday/ }));
    await screen.findByText('Information');

    return { ...rendered, copyLink, openEmbed, remove };
}

const preview = () => within(screen.getByRole('region', { name: 'Preview' }));
const bar = () => within(screen.getByRole('toolbar', { name: 'Video actions' }));

describe('Video detail action bar', () => {
    const names = () =>
        bar()
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label') ?? button.textContent);

    it('is one sticky header (Back, title with Rename, actions) placed before the cards', async () => {
        await openDetail();

        const toolbar = screen.getByRole('toolbar', { name: 'Video actions' });
        const header = document.querySelector('.detail-header') as HTMLElement;
        const grid = document.querySelector('.detail-grid') as HTMLElement;
        const back = screen.getByRole('button', { name: 'Back to Library' });
        const title = screen.getByRole('heading', { level: 2, name: 'Holiday' });
        const rename = screen.getByRole('button', { name: 'Rename' });
        const titlebar = title.parentElement as HTMLElement;

        expect(toolbar).toHaveClass('detail-actionbar');
        expect(Array.from(header.children)).toEqual([back, titlebar, toolbar]);
        expect(Array.from(titlebar.children)).toEqual([title, rename]);
        expect(header.nextElementSibling).toBe(grid);
        expect(header.closest('.detail')).not.toBeNull();
        expect(document.querySelector('.detail-head')).toBeNull();
        // The sticky rule itself is in styles.css (jsdom does not load it): the class is the hook.
    });

    it('has only an icon-only Delete in the toolbar for a ready video (no Refresh)', async () => {
        await openDetail();

        expect(names()).toEqual(['Delete']);
        expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeNull();
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();

        const del = bar().getByRole('button', { name: 'Delete' });

        expect(del).toHaveClass('btn-accent-danger');
        expect(del).toHaveAttribute('title', 'Delete');
        expect(del).toHaveTextContent('');
        expect(del.querySelector('svg')).not.toBeNull();
    });

    it.each(['pending', 'processing', 'failed'])(
        'shows an icon-only Refresh before Delete while the video is %s',
        async (status) => {
            const { user } = await openDetail({ status } as Partial<VideoDetail>);

            expect(names()).toEqual(['Refresh', 'Delete']);

            const refresh = bar().getByRole('button', { name: 'Refresh' });

            expect(refresh).toHaveAttribute('title', 'Refresh');
            expect(refresh).toHaveTextContent('');
            expect(refresh.querySelector('svg')).not.toBeNull();
            await user.click(refresh);
            await screen.findByText('Information');
        },
    );

    it('has an icon-only Rename next to the title, outside the toolbar', async () => {
        await openDetail();

        const rename = screen.getByRole('button', { name: 'Rename' });

        expect(bar().queryByRole('button', { name: 'Rename' })).toBeNull();
        expect(rename).not.toHaveClass('btn-accent-edit');
        expect(rename).toHaveAttribute('title', 'Rename');
        expect(rename).toHaveTextContent('');
        expect(rename.querySelector('svg')).not.toBeNull();
        expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(1);
    });

    it('styles Open in browser neutrally and has no leftover Actions card', async () => {
        await openDetail();

        expect(preview().getByRole('button', { name: 'Open in browser' })).not.toHaveClass(
            'btn-accent-share',
        );
        expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Open in browser' })).toHaveLength(1);
    });

    it('keeps Open in browser out of the toolbar and hides it without an embed URL', async () => {
        await openDetail({ embedUrl: null, playlistUrl: null, shortcode: null, iframeCode: null });

        expect(names()).toEqual(['Delete']);
        expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    });

    it('has an icon-only Open in browser button in the Preview card heading row', async () => {
        await openDetail();

        const button = preview().getByRole('button', { name: 'Open in browser' });

        expect(bar().queryByRole('button', { name: 'Open in browser' })).toBeNull();
        expect(button).toHaveAttribute('title', 'Open in browser');
        expect(button).toHaveTextContent('');
        expect(button.querySelector('svg')).not.toBeNull();
        expect(button.parentElement).toContainElement(
            preview().getByRole('heading', { name: 'Preview' }),
        );
    });

    it('opens from the Preview card', async () => {
        const { user, openEmbed, copyLink } = await openDetail();

        await user.click(preview().getByRole('button', { name: 'Open in browser' }));

        await waitFor(() => expect(openEmbed).toHaveBeenCalledWith(7));
        expect(copyLink).not.toHaveBeenCalled();
    });

    it('deletes from the bar after confirming, and Rename keeps its inline editor and focus', async () => {
        const { user, remove } = await openDetail();

        await user.click(screen.getByRole('button', { name: 'Rename' }));
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
        await user.keyboard('{Escape}');
        expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();

        await user.click(bar().getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );
        expect(remove).toHaveBeenCalledWith(7);
    });

    it.each(['pending', 'processing'])(
        'disables Delete while the video is %s and explains why',
        async (status) => {
            const { user, remove } = await openDetail({ status } as Partial<VideoDetail>);

            const item = bar().getByRole('button', { name: 'Delete' });

            expect(item).toBeDisabled();
            expect(item).toHaveAccessibleDescription(/cannot be deleted/);
            expect(document.getElementById('video-delete-blocked')).toBeInTheDocument();
            // The explanation is outside the sticky bar so the bar keeps one line.
            expect(document.querySelector('.detail-actionbar #video-delete-blocked')).toBeNull();
            await user.click(item);
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(remove).not.toHaveBeenCalled();
        },
    );

    it('keeps Delete enabled for a ready video, with no explanation', async () => {
        const { user } = await openDetail();

        expect(bar().getByRole('button', { name: 'Delete' })).toBeEnabled();
        expect(document.getElementById('video-delete-blocked')).toBeNull();
    });
});
