import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem, VideoListMeta, VideosListResult } from '../../../shared/ipc';
import { makeVideo } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { waitForPage } from '../testing/pager';

function meta(partial: Partial<VideoListMeta> = {}): VideoListMeta {
    return { page: 1, perPage: 24, total: 1, lastPage: 1, ...partial };
}

function ok(data: VideoListItem[], m: Partial<VideoListMeta> = {}): VideosListResult {
    return { ok: true, data, meta: meta({ total: data.length, ...m }) };
}

/** Renders the app with `list` mocked, then opens the Library tab. */
async function openLibrary(list: (params?: unknown) => Promise<VideosListResult>) {
    const rendered = await renderApp();
    const spy = vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation(list);

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));

    return { ...rendered, spy };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('Library screen', () => {
    it('renders rows with title, badge, duration and date', async () => {
        await openLibrary(() =>
            Promise.resolve(
                ok([
                    makeVideo({
                        id: 1,
                        title: 'Holiday',
                        duration: 75,
                        thumbnailUrl: 'https://cdn.example.com/a.jpg',
                    }),
                    makeVideo({ id: 2, title: 'Long one', status: 'processing', duration: 3725 }),
                    makeVideo({ id: 3, title: 'Broken', status: 'failed', duration: null }),
                    makeVideo({ id: 4, title: 'Odd', status: 'archived' }),
                ]),
            ),
        );

        const rows = await screen.findAllByRole('listitem');

        expect(rows).toHaveLength(4);
        expect(within(rows[0]!).getByText('Holiday')).toBeInTheDocument();
        expect(within(rows[0]!).getByText('Ready')).toBeInTheDocument();
        expect(within(rows[0]!).getByText('1:15')).toBeInTheDocument();
        expect(within(rows[0]!).getByText(/^Added Jan 1, 2026/)).toBeInTheDocument();
        expect(rows[0]!.querySelector('img')).toHaveAttribute(
            'src',
            'https://cdn.example.com/a.jpg',
        );
        expect(within(rows[1]!).getByText('Processing')).toBeInTheDocument();
        expect(within(rows[1]!).getByText('1:02:05')).toBeInTheDocument();
        expect(rows[1]!.querySelector('img')).toBeNull();
        expect(within(rows[1]!).getByText('No thumbnail')).toBeInTheDocument();
        expect(within(rows[2]!).getByText('Failed')).toBeInTheDocument();
        expect(within(rows[3]!).getByText('Unknown')).toBeInTheDocument();
        expect(screen.getAllByText('4 videos')[0]!).toBeInTheDocument();
    });

    it('falls back to the placeholder when the image fails to load', async () => {
        await openLibrary(() =>
            Promise.resolve(ok([makeVideo({ thumbnailUrl: 'https://cdn.example.com/a.jpg' })])),
        );

        const row = (await screen.findAllByRole('listitem'))[0]!;

        fireEvent.error(row.querySelector('img')!);

        expect(row.querySelector('img')).toBeNull();
        expect(within(row).getByText('No thumbnail')).toBeInTheDocument();
    });

    it('searches only on submit (Enter or the Search button) and resets to page 1', async () => {
        const { spy, user } = await openLibrary((params) => {
            const { page } = params as { page: number };

            return Promise.resolve(ok([makeVideo()], { page, lastPage: 3, total: 50 }));
        });

        await screen.findAllByRole('listitem');
        await act(async () => {
            fireEvent.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        });
        await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ page: 2, perPage: 24 }));

        const box = screen.getByLabelText('Search videos');
        const calls = spy.mock.calls.length;

        // Typing alone never calls the API, however long we wait.
        await user.type(box, ' cat ');
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(spy.mock.calls.length).toBe(calls);

        await user.type(box, '{Enter}');
        await waitFor(() =>
            expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24, q: 'cat' }),
        );

        // The Search button does the same.
        await user.clear(box);
        await user.type(box, 'dog');
        await user.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() =>
            expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24, q: 'dog' }),
        );
    });

    it('clears the box and applies the empty search at once', async () => {
        const { spy, user } = await openLibrary(() => Promise.resolve(ok([makeVideo()])));
        const box = screen.getByLabelText('Search videos');

        await screen.findAllByRole('listitem');
        expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();

        await user.type(box, 'cat{Enter}');
        await waitFor(() =>
            expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24, q: 'cat' }),
        );

        await user.click(screen.getByRole('button', { name: 'Clear search' }));
        expect(box).toHaveValue('');
        await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24 }));
        expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    });

    it('moves between pages with Previous and Next', async () => {
        const { spy, user } = await openLibrary((params) => {
            const { page } = params as { page: number };

            return Promise.resolve(
                ok([makeVideo({ title: `Page ${page}` })], { page, lastPage: 2, total: 30 }),
            );
        });

        await waitForPage(1);
        expect(screen.getAllByRole('button', { name: 'Previous page' })[0]!).toBeDisabled();

        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
        await waitForPage(2);
        expect(spy).toHaveBeenLastCalledWith({ page: 2, perPage: 24 });
        expect(screen.getAllByRole('button', { name: 'Next page' })[0]!).toBeDisabled();

        await user.click(screen.getAllByRole('button', { name: 'Previous page' })[0]!);
        await waitForPage(1);
        expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24 });
    });

    it('shows the error and retries', async () => {
        let attempt = 0;
        const { user } = await openLibrary(() => {
            attempt += 1;

            return Promise.resolve(
                attempt === 1
                    ? ({
                          ok: false,
                          error: 'Too many requests. Please try again in a moment.',
                      } as const)
                    : ok([makeVideo({ title: 'Back again' })]),
            );
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');

        await user.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByText('Back again')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the empty states', async () => {
        const { user } = await openLibrary(() => Promise.resolve(ok([])));

        expect(await screen.findByText('No videos yet')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Search videos'), 'zzz{Enter}');

        expect(await screen.findByText('No videos match your search')).toBeInTheDocument();
    });

    it('ignores a stale answer when a newer request was made', async () => {
        const resolvers: Array<(result: VideosListResult) => void> = [];
        const { user } = await openLibrary(
            () => new Promise<VideosListResult>((resolve) => resolvers.push(resolve)),
        );

        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(resolvers).toHaveLength(2);

        await act(async () => {
            resolvers[1]!(ok([makeVideo({ title: 'Latest upload' })]));
        });
        await act(async () => {
            resolvers[0]!(ok([makeVideo({ title: 'Stale' })]));
        });

        expect(screen.getByText('Latest upload')).toBeInTheDocument();
        expect(screen.queryByText('Stale')).toBeNull();
    });
});
