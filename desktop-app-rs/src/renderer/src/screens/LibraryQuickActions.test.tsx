import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

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

describe.each(['grid', 'list'] as const)('Library quick actions (%s)', (view) => {
    it('shows the three buttons only for ready videos, with labels that include the title', async () => {
        await openLibrary(view);

        for (const name of [
            'Copy shortcode for Alpha',
            'Copy embed URL for Alpha',
            'Open in browser for Alpha',
        ]) {
            const button = screen.getByRole('button', { name });

            expect(button).toHaveClass('btn-accent-share');
            expect(button).toHaveAttribute('title', name.replace(/ for .*/, ''));
        }

        expect(screen.getAllByRole('button', { name: /^(Copy|Open in)/ })).toHaveLength(3);
        expect(screen.queryByRole('button', { name: /for Beta/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /for Gamma/ })).toBeNull();
    });

    it('keeps the buttons out of the open button (no nested interactive markup)', async () => {
        await openLibrary(view);

        const open = screen.getByRole('button', { name: /^Alpha/ });
        const row = open.closest('li') as HTMLElement;

        for (const button of within(row).getAllByRole('button', { name: /for Alpha/ })) {
            expect(open.contains(button)).toBe(false);
            expect(button.closest('.video-open')).toBeNull();
            expect(button.closest('li')).toBe(row);
        }
    });

    it('is hidden in select mode and back afterwards', async () => {
        const { user } = await openLibrary(view);

        await user.click(screen.getByRole('button', { name: 'Select' }));
        expect(screen.queryByRole('button', { name: /for Alpha/ })).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Select' }));
        expect(
            screen.getByRole('button', { name: 'Copy shortcode for Alpha' }),
        ).toBeInTheDocument();
    });

    it('copies the shortcode and the embed URL and opens the embed page, with toasts', async () => {
        const { user, copyLink, openEmbed } = await openLibrary(view);

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        expect(copyLink).toHaveBeenLastCalledWith(1, 'shortcode');
        expect(await screen.findByText('Shortcode copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Copy embed URL for Alpha' }));
        expect(copyLink).toHaveBeenLastCalledWith(1, 'embed-url');
        expect(await screen.findByText('Embed URL copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open in browser for Alpha' }));
        expect(openEmbed).toHaveBeenLastCalledWith(1);
        expect(await screen.findByText('Opened in your browser.')).toBeInTheDocument();
    });

    it('neither opens the detail page nor changes the selection', async () => {
        const { user, get, copyLink } = await openLibrary(view);

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        await screen.findByText('Shortcode copied.');
        screen.getByRole('button', { name: 'Open in browser for Alpha' }).focus();
        await user.keyboard('{Enter}');
        await user.keyboard(' ');

        expect(get).not.toHaveBeenCalled();
        expect(screen.queryByText('Information')).toBeNull();
        expect(screen.getByRole('list', { name: 'Videos' })).toBeVisible();
        // Select mode was never on, so there is no checkbox and no selection summary.
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(copyLink).toHaveBeenCalledTimes(1);
    });

    it('disables the buttons of the row while the request is in flight (aria-busy)', async () => {
        const { user, copyLink } = await openLibrary(view);
        let finish: (result: ActionResult) => void = () => undefined;

        copyLink.mockImplementation(
            () =>
                new Promise<ActionResult>((resolve) => {
                    finish = resolve;
                }),
        );

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));

        const buttons = screen.getAllByRole('button', { name: /for Alpha/ }).slice(-3);

        expect(buttons).toHaveLength(3);

        for (const button of buttons) {
            expect(button).toBeDisabled();
            expect(button).toHaveAttribute('aria-busy', 'true');
        }

        finish({ ok: true });
        await screen.findByText('Shortcode copied.');
        await waitFor(() => expect(buttons[0]).toBeEnabled());
        expect(buttons[0]).toHaveAttribute('aria-busy', 'false');
        expect(copyLink).toHaveBeenCalledTimes(1);
    });

    it('shows the safe error as a toast when the action fails', async () => {
        const { user, copyLink, openEmbed } = await openLibrary(view);

        copyLink.mockResolvedValue({ ok: false, error: 'This video has no embed URL yet.' });
        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        expect(await screen.findByText(/This video has no embed URL yet\./)).toBeInTheDocument();

        openEmbed.mockRejectedValue(new Error('boom'));
        await user.click(screen.getByRole('button', { name: 'Open in browser for Alpha' }));
        expect(
            await screen.findByText(/Something went wrong\. Please try again\./),
        ).toBeInTheDocument();
        expect(screen.queryByText('boom')).toBeNull();
    });
});
