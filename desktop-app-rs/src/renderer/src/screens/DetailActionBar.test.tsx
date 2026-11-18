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

const bar = () => within(screen.getByRole('toolbar', { name: 'Video actions' }));

describe('Video detail action bar', () => {
    it('sits right under the title row, before the cards, and is sticky', async () => {
        await openDetail();

        const toolbar = screen.getByRole('toolbar', { name: 'Video actions' });
        const head = document.querySelector('.detail-head') as HTMLElement;
        const grid = document.querySelector('.detail-grid') as HTMLElement;

        expect(toolbar).toHaveClass('detail-actionbar');
        expect(head.nextElementSibling).toBe(toolbar);
        expect(toolbar.nextElementSibling).toBe(grid);
        expect(toolbar.closest('.detail')).not.toBeNull();
        // The sticky rule itself is in styles.css (jsdom does not load it): the class is the hook.
    });

    it('orders the buttons: open, copy embed, rename, then the overflow menu at the end', async () => {
        await openDetail();

        expect(
            bar()
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual(['Open in browser', 'Copy embed URL', 'Rename', 'More actions']);

        const spacer = document.querySelector('.detail-actionbar .action-spacer');

        expect(spacer?.nextElementSibling).toBe(
            bar().getByRole('button', { name: 'More actions' }).parentElement,
        );
    });

    it('puts playlist, shortcode and a danger-styled Delete in the overflow menu', async () => {
        const { user } = await openDetail();

        await user.click(bar().getByRole('button', { name: 'More actions' }));

        const menu = within(screen.getByRole('menu', { name: 'More actions' }));

        expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
            'Copy playlist URL',
            'Copy shortcode',
            'Delete',
        ]);
        expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveClass('video-menu-danger');

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(bar().getByRole('button', { name: 'More actions' })).toHaveFocus();
    });

    it('colours the buttons by meaning', async () => {
        await openDetail();

        for (const name of ['Copy embed URL', 'Open in browser']) {
            expect(bar().getByRole('button', { name })).toHaveClass('btn-accent-share');
        }

        expect(bar().getByRole('button', { name: 'Rename' })).toHaveClass('btn-accent-edit');
        expect(screen.getByRole('button', { name: 'Choose image…' })).toHaveClass(
            'btn-accent-create',
        );
    });

    it('has no leftover Actions card', async () => {
        await openDetail();

        expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Copy embed URL' })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(1);
    });

    it('hides the copy and open buttons without URLs, and the empty menu entries', async () => {
        const { user } = await openDetail({
            embedUrl: null,
            playlistUrl: null,
            shortcode: null,
            iframeCode: null,
        });

        expect(
            bar()
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual(['Rename', 'More actions']);

        await user.click(bar().getByRole('button', { name: 'More actions' }));
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Delete']);
    });

    it('hides only the playlist entry without a playlist URL', async () => {
        const { user } = await openDetail({ playlistUrl: null });

        expect(bar().getByRole('button', { name: 'Copy embed URL' })).toBeInTheDocument();
        await user.click(bar().getByRole('button', { name: 'More actions' }));
        expect(screen.queryByRole('menuitem', { name: 'Copy playlist URL' })).toBeNull();
    });

    it('copies and opens from the bar and its menu', async () => {
        const { user, copyLink, openEmbed } = await openDetail();

        await user.click(bar().getByRole('button', { name: 'Copy embed URL' }));
        await user.click(bar().getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Copy playlist URL' }));
        await user.click(bar().getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Copy shortcode' }));
        await user.click(bar().getByRole('button', { name: 'Open in browser' }));

        expect(copyLink).toHaveBeenNthCalledWith(1, 7, 'embed-url');
        expect(copyLink).toHaveBeenNthCalledWith(2, 7, 'playlist-url');
        expect(copyLink).toHaveBeenNthCalledWith(3, 7, 'shortcode');
        await waitFor(() => expect(openEmbed).toHaveBeenCalledWith(7));
    });

    it('deletes from the menu after confirming, and Rename keeps its inline editor and focus', async () => {
        const { user, remove } = await openDetail();

        await user.click(bar().getByRole('button', { name: 'Rename' }));
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
        expect(bar().getByRole('button', { name: 'Rename' })).toBeDisabled();
        await user.keyboard('{Escape}');
        expect(bar().getByRole('button', { name: 'Rename' })).toHaveFocus();

        await user.click(bar().getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );
        expect(remove).toHaveBeenCalledWith(7);
    });

    it.each(['pending', 'processing'])(
        'disables Delete while the video is %s and explains why',
        async (status) => {
            const { user, remove } = await openDetail({ status } as Partial<VideoDetail>);

            await user.click(bar().getByRole('button', { name: 'More actions' }));

            const item = screen.getByRole('menuitem', { name: 'Delete' });

            expect(item).toHaveAttribute('aria-disabled', 'true');
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

        await user.click(bar().getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toHaveAttribute(
            'aria-disabled',
        );
        expect(document.getElementById('video-delete-blocked')).toBeNull();
    });
});
