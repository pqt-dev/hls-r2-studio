import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
    ActionResult,
    VideoDetail,
    VideoListItem,
    VideosGetResult,
    VideosListResult,
} from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { waitForPage } from '../testing/pager';

const SITE_EMBED = 'https://site.example.com/embed/abcdefghijkl';

function listOf(items: VideoListItem[], page = 1, lastPage = 1): VideosListResult {
    return { ok: true, data: items, meta: { page, perPage: 24, total: 30, lastPage } };
}

interface Options {
    list?: (params?: unknown) => Promise<VideosListResult>;
    get?: (id: number) => Promise<VideosGetResult>;
}

/** Renders the app, opens the Library tab and (optionally) the first video. */
async function openLibrary(options: Options = {}) {
    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const list = vi
        .spyOn(videos, 'list')
        .mockImplementation(
            options.list ??
                (() => Promise.resolve(listOf([makeVideo({ id: 7, title: 'Holiday' })]))),
        );
    const get = vi.spyOn(videos, 'get').mockImplementation(
        options.get ??
            ((id) =>
                Promise.resolve({
                    ok: true,
                    video: makeVideoDetail({ id, title: 'Holiday' }),
                })),
    );
    const copyLink = vi.spyOn(videos, 'copyLink');
    const openEmbed = vi.spyOn(videos, 'openEmbed');

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));

    return { ...rendered, list, get, copyLink, openEmbed };
}

async function openFirst(user: Awaited<ReturnType<typeof openLibrary>>['user']) {
    await user.click(await screen.findByRole('button', { name: /^Holiday/ }));
}

function detail(partial: Partial<VideoDetail>): Options {
    return {
        get: (id) => Promise.resolve({ ok: true, video: makeVideoDetail({ id, ...partial }) }),
    };
}

describe('Video detail page', () => {
    it('opens from a row (a real button) and loads the video once', async () => {
        const { user, get } = await openLibrary();

        const row = await screen.findByRole('button', { name: /^Holiday/ });

        expect(row.tagName).toBe('BUTTON');

        await user.click(row);

        const crumbs = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));

        // The back button is the only "Library" label; the breadcrumb shows just the title.
        expect(crumbs.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            'Holiday',
        ]);
        expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument();
        await screen.findByText('Information');
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith(7);
    });

    it('opens with the keyboard (Enter and Space)', async () => {
        const { user, get } = await openLibrary();

        (await screen.findByRole('button', { name: /^Holiday/ })).focus();
        await user.keyboard('{Enter}');
        await screen.findByText('Information');
        expect(get).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole('button', { name: 'Library' }));
        screen.getByRole('button', { name: /^Holiday/ }).focus();
        await user.keyboard(' ');
        await screen.findByText('Information');
        expect(get).toHaveBeenCalledTimes(2);
    });

    it('Back and Esc return to the same page and search without reloading the list', async () => {
        const { user, list } = await openLibrary({
            list: (params) => {
                const { page } = params as { page: number };

                return Promise.resolve(listOf([makeVideo({ id: 7, title: 'Holiday' })], page, 3));
            },
        });

        await screen.findByRole('button', { name: /^Holiday/ });
        // A submitted search always goes back to page 1, so let it settle first (wait for the
        // request it triggers); only then go to page 2.
        await user.type(screen.getByLabelText('Search videos'), 'ho{Enter}');
        await waitFor(() =>
            expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: 'ho' })),
        );
        await waitForPage(1);
        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        await waitForPage(2);

        const lists = list.mock.calls.length;

        await openFirst(user);
        await screen.findByText('Information');
        expect(screen.queryByLabelText('Search videos')).not.toBeVisible();

        await user.click(screen.getByRole('button', { name: 'Library' }));
        expect(screen.getByLabelText('Search videos')).toBeVisible();
        expect(screen.getByLabelText('Search videos')).toHaveValue('ho');
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]!).toHaveValue('2');
        expect(screen.queryByText('Information')).toBeNull();
        // The focus goes back to the row that was opened.
        expect(screen.getByRole('button', { name: /^Holiday/ })).toHaveFocus();

        await openFirst(user);
        await screen.findByText('Information');
        await user.keyboard('{Escape}');

        expect(screen.queryByText('Information')).toBeNull();
        expect(screen.getByLabelText('Search videos')).toHaveValue('ho');
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]!).toHaveValue('2');
        // Opening and closing the detail page never reloads the list.
        expect(list.mock.calls.length).toBe(lists);
    });

    it('shows loading, then the error with Retry', async () => {
        let attempt = 0;
        const resolvers: Array<(result: VideosGetResult) => void> = [];
        const { user } = await openLibrary({
            get: () =>
                new Promise<VideosGetResult>((resolve) => {
                    attempt += 1;
                    resolvers.push(resolve);
                }),
        });

        await openFirst(user);
        expect(screen.getByText('Loading…')).toBeInTheDocument();

        await act(async () => {
            resolvers[0]!({ ok: false, error: 'Video not found.' });
        });
        expect(await screen.findByRole('alert')).toHaveTextContent('Video not found.');

        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(attempt).toBe(2);

        await act(async () => {
            resolvers[1]!({ ok: true, video: makeVideoDetail({ title: 'Holiday' }) });
        });
        expect(await screen.findByText('Information')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('Refresh re-fetches and a stale answer is ignored', async () => {
        const resolvers: Array<(result: VideosGetResult) => void> = [];
        const { user, get } = await openLibrary({
            get: () => new Promise<VideosGetResult>((resolve) => resolvers.push(resolve)),
        });

        await openFirst(user);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(get).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolvers[1]!({ ok: true, video: makeVideoDetail({ publicId: 'newestnewest' }) });
        });
        await act(async () => {
            resolvers[0]!({ ok: true, video: makeVideoDetail({ publicId: 'stalestalest' }) });
        });

        expect(screen.getByText('newestnewest')).toBeInTheDocument();
        expect(screen.queryByText('stalestalest')).toBeNull();
    });

    it('renders the info card fields', async () => {
        const { user } = await openLibrary(
            detail({ duration: 3725, outputBitrateKbps: 4500, outputFps: 29.97 }),
        );

        await openFirst(user);
        await screen.findByText('Information');

        for (const text of [
            '1:02:05',
            '1920x1080',
            '29.97 fps',
            '4500 kbps',
            'h264',
            'holiday.mp4',
            '150 MB',
            'abcdefghijkl',
        ]) {
            expect(screen.getByText(text)).toBeInTheDocument();
        }
        expect(within(screen.getByLabelText('Information')).getByText('Ready')).toBeInTheDocument();
    });

    it('does not load the preview until asked, and then only for a same-host https embed URL', async () => {
        const { user } = await openLibrary(detail({ embedUrl: SITE_EMBED }));

        await openFirst(user);
        await screen.findByText('Information');

        expect(document.querySelector('iframe')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Load preview' }));

        const frame = document.querySelector('iframe')!;

        expect(frame).toHaveAttribute('src', SITE_EMBED);
        expect(frame).toHaveAttribute(
            'sandbox',
            'allow-scripts allow-same-origin allow-presentation',
        );
        expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
        expect(frame).toHaveAttribute('allow', 'fullscreen');
        expect(frame).toHaveAttribute('loading', 'lazy');
        expect(frame).toHaveAttribute('title');
        expect(screen.queryByRole('button', { name: 'Load preview' })).toBeNull();
    });

    it.each([
        ['a foreign host', 'https://evil.example.com/embed/abcdefghijkl'],
        ['a look-alike host', 'https://site.example.com.evil.test/embed/a'],
        ['another port', 'https://site.example.com:8443/embed/a'],
        ['plain http', 'http://site.example.com/embed/abcdefghijkl'],
        ['credentials', 'https://user:pw@site.example.com/embed/a'],
    ])('shows "Preview unavailable" and no iframe for %s', async (_name, embedUrl) => {
        const { user } = await openLibrary(detail({ embedUrl }));

        await openFirst(user);
        await screen.findByText('Information');

        expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Load preview' })).toBeNull();
        expect(document.querySelector('iframe')).toBeNull();
        expect(
            within(screen.getByLabelText('Preview')).getByRole('button', {
                name: 'Open in browser',
            }),
        ).toBeInTheDocument();
    });

    it('does not offer a preview for a video that is not ready', async () => {
        const { user } = await openLibrary(
            detail({ status: 'processing', stage: 'transcoding', progress: 40 }),
        );

        await openFirst(user);
        await screen.findByText('Information');

        expect(screen.getByText(/still being processed/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Load preview' })).toBeNull();
        expect(document.querySelector('iframe')).toBeNull();
        expect(screen.getByText('transcoding')).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'Processing progress' })).toHaveAttribute(
            'value',
            '40',
        );
    });

    it('copies and opens through the main process and shows toasts', async () => {
        const { user, copyLink, openEmbed } = await openLibrary(detail({ embedUrl: SITE_EMBED }));

        await openFirst(user);
        await screen.findByText('Information');

        await user.click(screen.getByRole('button', { name: 'Copy embed URL' }));
        expect(copyLink).toHaveBeenLastCalledWith(7, 'embed-url');
        expect(await screen.findByText('Embed URL copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Copy playlist URL' }));
        expect(copyLink).toHaveBeenLastCalledWith(7, 'playlist-url');
        expect(await screen.findByText('Playlist URL copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open in browser' }));
        expect(openEmbed).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Opened in your browser.')).toBeInTheDocument();
    });

    it('shows each embed value from the detail in its own block and copies through the main process', async () => {
        const shortcode = '[hls_embed_vl id="abcdefghijkl"]';
        const iframeCode =
            '<iframe src="' +
            SITE_EMBED +
            '" style="width:100%; aspect-ratio:1920 / 800; max-height:75vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>';
        const { user, copyLink } = await openLibrary(
            detail({ embedUrl: SITE_EMBED, shortcode, iframeCode }),
        );

        await openFirst(user);

        const card = within(await screen.findByLabelText('Embed'));

        // The strings are shown exactly as the main process built them (nothing is built here).
        expect(card.getByRole('heading', { name: 'Embed URL' })).toBeInTheDocument();
        expect(card.getByText(SITE_EMBED)).toBeInTheDocument();
        expect(card.getByText(iframeCode)).toBeInTheDocument();
        expect(card.getByText(shortcode)).toBeInTheDocument();

        await user.click(card.getByRole('button', { name: 'Copy Embed URL' }));
        expect(copyLink).toHaveBeenLastCalledWith(7, 'embed-url');
        expect(await screen.findByText('Embed URL copied.')).toBeInTheDocument();

        await user.click(card.getByRole('button', { name: 'Copy Iframe code' }));
        expect(copyLink).toHaveBeenLastCalledWith(7, 'iframe-code');
        expect(await screen.findByText('Iframe code copied.')).toBeInTheDocument();

        await user.click(card.getByRole('button', { name: 'Copy Shortcode' }));
        expect(copyLink).toHaveBeenLastCalledWith(7, 'shortcode');
        expect(await screen.findByText('Shortcode copied.')).toBeInTheDocument();
    });

    it('hides the blocks the main process could not build', async () => {
        const { user } = await openLibrary(
            detail({ embedUrl: SITE_EMBED, shortcode: null, iframeCode: null }),
        );

        await openFirst(user);

        const card = within(await screen.findByLabelText('Embed'));

        expect(card.getByText(SITE_EMBED)).toBeInTheDocument();
        expect(card.queryByRole('heading', { name: 'Iframe code' })).toBeNull();
        expect(card.queryByRole('heading', { name: 'Shortcode' })).toBeNull();
    });

    it('shows a failure toast when an action fails', async () => {
        const { user, copyLink, openEmbed } = await openLibrary();

        copyLink.mockResolvedValue({
            ok: false,
            error: 'Could not copy to the clipboard.',
        } as ActionResult);
        openEmbed.mockRejectedValue(new Error('boom'));

        await openFirst(user);
        await screen.findByText('Information');

        await user.click(screen.getByRole('button', { name: 'Copy embed URL' }));
        expect(await screen.findByText(/Could not copy to the clipboard\./)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open in browser' }));
        expect(
            await screen.findByText(/Something went wrong\. Please try again\./),
        ).toBeInTheDocument();
    });

    it('hides copy/open buttons for URLs the video does not have', async () => {
        const { user } = await openLibrary(detail({ playlistUrl: null, embedUrl: null }));

        await openFirst(user);
        await screen.findByText('Information');

        expect(screen.queryByRole('button', { name: 'Copy playlist URL' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Copy embed URL' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    });

    it('shows the error card for a failed video', async () => {
        const { user } = await openLibrary(
            detail({
                status: 'failed',
                error: {
                    message: 'Transcoding failed.',
                    detail: 'ffmpeg exited with code 1',
                    failedAt: '2026-01-01T10:00:00.000Z',
                },
            }),
        );

        await openFirst(user);

        const card = await screen.findByLabelText('Processing error');

        expect(within(card).getByText('Transcoding failed.')).toBeInTheDocument();
        expect(within(card).getByText('ffmpeg exited with code 1')).toBeInTheDocument();
        expect(
            within(screen.getByLabelText('Video details')).getByText('Failed'),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText('Processing error')).toBe(card);
    });

    it('does not show the error card for a ready video', async () => {
        const { user } = await openLibrary();

        await openFirst(user);
        await screen.findByText('Information');

        expect(screen.queryByLabelText('Processing error')).toBeNull();
    });

    it('shows storyboards with a caption, and hides the card when there are none', async () => {
        const first = await openLibrary(
            detail({
                storyboards: {
                    '3x3': { url: 'https://cdn.example.com/sb3.jpg', columns: 3, count: 9 },
                    '5x5': { url: 'https://cdn.example.com/sb5.jpg', columns: 5, count: 25 },
                    '9x9': { url: null, columns: 9, count: 81 },
                },
            }),
        );

        await openFirst(first.user);
        await screen.findByText('Information');

        const card = screen.getByLabelText('Storyboards');
        const images = within(card).getAllByRole('img');

        expect(images).toHaveLength(2);
        expect(images[0]).toHaveAttribute('src', 'https://cdn.example.com/sb3.jpg');
        expect(images[0]).toHaveAttribute('loading', 'lazy');
        expect(within(card).getByText('3 columns · 9 frames')).toBeInTheDocument();
        expect(within(card).getByText('5 columns · 25 frames')).toBeInTheDocument();
        first.unmount();

        const second = await openLibrary(detail({ storyboards: {} }));

        await openFirst(second.user);
        await screen.findByText('Information');
        expect(screen.queryByLabelText('Storyboards')).toBeNull();
    });

    it('keeps the list scroll position when going back', async () => {
        const { user } = await openLibrary();
        const panel = screen.getByRole('tabpanel');

        await screen.findByRole('button', { name: /^Holiday/ });
        panel.scrollTop = 240;
        await openFirst(user);
        await screen.findByText('Information');
        expect(panel.scrollTop).toBe(0);

        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        await waitFor(() => expect(panel.scrollTop).toBe(240));
    });
});
