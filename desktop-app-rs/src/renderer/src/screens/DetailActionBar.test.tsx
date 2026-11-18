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
    it('is one sticky header (Back, title, actions) placed before the cards', async () => {
        await openDetail();

        const toolbar = screen.getByRole('toolbar', { name: 'Video actions' });
        const header = document.querySelector('.detail-header') as HTMLElement;
        const grid = document.querySelector('.detail-grid') as HTMLElement;
        const back = screen.getByRole('button', { name: 'Back to Library' });
        const title = screen.getByRole('heading', { level: 2, name: 'Holiday' });

        expect(toolbar).toHaveClass('detail-actionbar');
        expect(Array.from(header.children)).toEqual([back, title, toolbar]);
        expect(header.nextElementSibling).toBe(grid);
        expect(header.closest('.detail')).not.toBeNull();
        expect(document.querySelector('.detail-head')).toBeNull();
        // The sticky rule itself is in styles.css (jsdom does not load it): the class is the hook.
    });

    it('has Open in browser, Rename, Refresh and Delete, with Delete last after the spacer', async () => {
        await openDetail();

        expect(
            bar()
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual(['Open in browser', 'Rename', 'Refresh', 'Delete']);
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
        expect(bar().queryByRole('button', { name: 'Copy embed URL' })).toBeNull();

        const spacer = document.querySelector('.detail-actionbar .action-spacer');

        expect(spacer?.nextElementSibling).toBe(bar().getByRole('button', { name: 'Delete' }));
    });

    it('styles Delete as a danger button', async () => {
        await openDetail();

        expect(bar().getByRole('button', { name: 'Delete' })).toHaveClass('btn-accent-danger');
    });

    it('colours the buttons by meaning', async () => {
        await openDetail();

        expect(bar().getByRole('button', { name: 'Open in browser' })).toHaveClass(
            'btn-accent-share',
        );
        expect(bar().getByRole('button', { name: 'Rename' })).toHaveClass('btn-accent-edit');
        expect(screen.getByRole('button', { name: '+ Upload image' })).toBeEnabled();
    });

    it('has no leftover Actions card and one Rename button', async () => {
        await openDetail();

        expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Actions' })).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Open in browser' })).toHaveLength(1);
    });

    it('hides Open in browser without an embed URL', async () => {
        await openDetail({ embedUrl: null, playlistUrl: null, shortcode: null, iframeCode: null });

        expect(
            bar()
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ).toEqual(['Rename', 'Refresh', 'Delete']);
    });

    it('opens from the bar', async () => {
        const { user, openEmbed, copyLink } = await openDetail();

        await user.click(bar().getByRole('button', { name: 'Open in browser' }));

        await waitFor(() => expect(openEmbed).toHaveBeenCalledWith(7));
        expect(copyLink).not.toHaveBeenCalled();
    });

    it('deletes from the bar after confirming, and Rename keeps its inline editor and focus', async () => {
        const { user, remove } = await openDetail();

        await user.click(bar().getByRole('button', { name: 'Rename' }));
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
        expect(bar().getByRole('button', { name: 'Rename' })).toBeDisabled();
        await user.keyboard('{Escape}');
        expect(bar().getByRole('button', { name: 'Rename' })).toHaveFocus();

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
