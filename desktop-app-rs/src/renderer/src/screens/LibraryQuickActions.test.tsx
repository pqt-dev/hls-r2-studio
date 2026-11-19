import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';

const KEY = 'hls-r2-studio:library-view';

async function openLibrary(view: 'grid' | 'list') {
    window.localStorage.setItem(KEY, view);

    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const data = [
        makeVideo({ id: 1, title: 'Alpha', status: 'ready' }),
        makeVideo({ id: 2, title: 'Beta', status: 'processing', embedUrl: null }),
        makeVideo({ id: 3, title: 'Gamma', status: 'failed', embedUrl: null }),
    ];

    vi.spyOn(videos, 'list').mockResolvedValue({
        ok: true,
        data,
        meta: { page: 1, perPage: 24, total: 3, lastPage: 1 },
    });
    const get = vi
        .spyOn(videos, 'get')
        .mockImplementation((id) =>
            Promise.resolve({ ok: true, video: makeVideoDetail({ id, title: 'Alpha' }) }),
        );
    const copyLink = vi.spyOn(videos, 'copyLink');
    const openEmbed = vi.spyOn(videos, 'openEmbed');

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return { ...rendered, get, copyLink, openEmbed };
}

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

/** Opens the kebab menu of a video and clicks one of its items. */
async function fromMenu(
    user: Awaited<ReturnType<typeof openLibrary>>['user'],
    video: string,
    item: string,
) {
    await user.click(screen.getByRole('button', { name: `More actions for ${video}` }));
    await user.click(screen.getByRole('menuitem', { name: `${item} for ${video}` }));
}

describe.each(['grid', 'list'] as const)('Library quick actions (%s)', (view) => {
    it('keeps ONE accented quick action (Copy shortcode) on a ready video; the rest is in the menu', async () => {
        const { user } = await openLibrary(view);
        const button = screen.getByRole('button', { name: 'Copy shortcode for Alpha' });

        expect(button).toHaveClass('video-quick-primary');
        expect(button).not.toHaveClass('video-quick-ghost');
        expect(button).not.toHaveClass('btn-accent-share');
        expect(button).toHaveAttribute('title', 'Copy shortcode');
        // Only that one button of the family is visible on a card.
        expect(screen.getAllByRole('button', { name: /^(Copy|Open in)/ })).toHaveLength(1);
        expect(screen.queryByRole('button', { name: /^(Copy|Open in).* for Beta/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^(Copy|Open in).* for Gamma/ })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        expect(
            within(screen.getByRole('menu'))
                .getAllByRole('menuitem')
                .map((item) => item.textContent),
        ).toEqual(['Select', 'Copy direct URL', 'Open in browser', 'Details', 'Delete']);
    });

    it('offers only Select, Details and Delete in the menu of a video that is not ready', async () => {
        const { user } = await openLibrary(view);

        await user.click(screen.getByRole('button', { name: 'More actions for Beta' }));
        expect(
            within(screen.getByRole('menu'))
                .getAllByRole('menuitem')
                .map((item) => item.textContent),
        ).toEqual(['Select', 'Details', 'Delete']);
    });

    it('keeps the buttons out of the open button (no nested interactive markup)', async () => {
        await openLibrary(view);

        const open = screen.getByRole('button', { name: /^Alpha/ });
        const row = open.closest('li') as HTMLElement;

        for (const button of within(row).getAllByRole('button', {
            name: /(for Alpha|More actions for Alpha)/,
        })) {
            expect(open.contains(button)).toBe(false);
            expect(button.closest('.video-open')).toBeNull();
            expect(button.closest('li')).toBe(row);
        }
    });

    it('is hidden in select mode and back afterwards', async () => {
        const { user } = await openLibrary(view);

        await enterSelectMode(user, 'Alpha');
        expect(screen.queryByRole('button', { name: /(for Alpha|More actions)/ })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Exit select mode' }));
        expect(
            screen.getByRole('button', { name: 'Copy shortcode for Alpha' }),
        ).toBeInTheDocument();
    });

    it('copies the shortcode and the direct URL and opens the embed page, with toasts', async () => {
        const { user, copyLink, openEmbed } = await openLibrary(view);

        // The renderer only sends the id and the kind; the main process builds the text.
        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        expect(copyLink).toHaveBeenLastCalledWith(1, 'shortcode');
        expect(await screen.findByText('Shortcode copied.')).toBeInTheDocument();

        await fromMenu(user, 'Alpha', 'Copy direct URL');
        expect(copyLink).toHaveBeenLastCalledWith(1, 'embed-url');
        expect(await screen.findByText('Direct URL copied.')).toBeInTheDocument();

        await fromMenu(user, 'Alpha', 'Open in browser');
        expect(openEmbed).toHaveBeenLastCalledWith(1);
        expect(await screen.findByText('Opened in your browser.')).toBeInTheDocument();
    });

    it('neither opens the detail page nor changes the selection', async () => {
        const { user, get, copyLink } = await openLibrary(view);

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        await screen.findByText('Shortcode copied.');
        screen.getByRole('button', { name: 'Copy shortcode for Alpha' }).focus();
        await user.keyboard('{Enter}');
        await user.keyboard(' ');

        expect(get).not.toHaveBeenCalled();
        expect(screen.queryByText('Information')).toBeNull();
        expect(screen.getByRole('list', { name: 'Videos' })).toBeVisible();
        // Select mode was never on, so there is no checkbox and no selection summary.
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(copyLink).toHaveBeenCalledTimes(3);
    });

    it('disables the buttons of the row only while the copy runs (aria-busy)', async () => {
        const { user, copyLink } = await openLibrary(view);
        let finish: (result: ActionResult) => void = () => undefined;

        copyLink.mockImplementation(
            () =>
                new Promise<ActionResult>((resolve) => {
                    finish = resolve;
                }),
        );

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));

        const shortcode = screen.getByRole('button', { name: 'Copy shortcode for Alpha' });
        const kebab = screen.getByRole('button', { name: 'More actions for Alpha' });

        expect(shortcode).toBeDisabled();
        expect(shortcode).toHaveAttribute('aria-busy', 'true');
        expect(kebab).toBeDisabled();

        finish({ ok: true });
        await screen.findByText('Shortcode copied.');
        await waitFor(() => expect(shortcode).toBeEnabled());
        expect(shortcode).toHaveAttribute('aria-busy', 'false');
        expect(copyLink).toHaveBeenCalledTimes(1);
    });

    it('shows the error the main process returns as a toast', async () => {
        const { user, copyLink } = await openLibrary(view);

        copyLink.mockResolvedValue({ ok: false, error: 'This video has no direct URL yet.' });
        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        expect(await screen.findByText(/This video has no direct URL yet\./)).toBeInTheDocument();

        copyLink.mockResolvedValue({ ok: false, error: 'Could not copy to the clipboard.' });
        await fromMenu(user, 'Alpha', 'Copy direct URL');
        expect(await screen.findByText(/Could not copy to the clipboard\./)).toBeInTheDocument();
        expect(screen.queryByText('Direct URL copied.')).toBeNull();
    });

    it('opening the embed page stays with the main process and reports a failure safely', async () => {
        const { user, openEmbed } = await openLibrary(view);

        openEmbed.mockRejectedValue(new Error('boom'));
        await fromMenu(user, 'Alpha', 'Open in browser');
        expect(
            await screen.findByText(/Something went wrong\. Please try again\./),
        ).toBeInTheDocument();
        expect(screen.queryByText('boom')).toBeNull();
    });
});
