import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    VideoListItem,
    VideosBulkDeleteResult,
    VideosDeleteResult,
    VideosListResult,
} from '../../../shared/ipc';
import { makeVideo } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';

function ok(data: VideoListItem[]): VideosListResult {
    return { ok: true, data, meta: { page: 1, perPage: 24, total: data.length, lastPage: 1 } };
}

/** A promise settled from the test (the server answer). */
function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

async function openLibrary(view: 'grid' | 'list', initial: VideoListItem[]) {
    window.localStorage.setItem('hls-r2-studio:library-view', view);

    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const server = { items: initial };
    const list = vi
        .spyOn(videos, 'list')
        .mockImplementation(() => Promise.resolve(ok(server.items)));
    const remove = vi.spyOn(videos, 'delete');
    const bulk = vi.spyOn(videos, 'bulkDelete');

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return { ...rendered, server, list, remove, bulk };
}

const rowOf = (title: string): HTMLElement =>
    screen.getByText(title, { selector: '.video-title' }).closest('li')!;

const liveRegion = (): HTMLElement => document.querySelector('p[aria-live="polite"]')!;

async function confirmDelete(
    user: Awaited<ReturnType<typeof openLibrary>>['user'],
    title: string,
): Promise<void> {
    await user.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
}

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
});

describe.each(['grid', 'list'] as const)('Library delete state (%s)', (view) => {
    const items = () => [
        makeVideo({ id: 1, title: 'Alpha' }),
        makeVideo({ id: 2, title: 'Beta', thumbnailUrl: 'https://x/t.jpg' }),
    ];

    it('marks the row while the server works and removes it only after success', async () => {
        const { user, remove, server, list } = await openLibrary(view, items());
        const answer = deferred<VideosDeleteResult>();

        remove.mockReturnValue(answer.promise);
        await confirmDelete(user, 'Alpha');

        const row = rowOf('Alpha');

        expect(remove).toHaveBeenCalledWith(1);
        expect(row).toHaveClass('is-deleting');
        expect(row).toHaveAttribute('aria-busy', 'true');
        expect(within(row).getByText('Deleting…')).toBeInTheDocument();
        expect(within(row).getByText('Deleting…')).toHaveAttribute('aria-hidden', 'true');
        expect(within(row).getByRole('button', { name: /^Alpha/ })).toBeDisabled();
        expect(within(row).getByRole('button', { name: 'More actions for Alpha' })).toBeDisabled();
        expect(
            within(row).getByRole('button', { name: 'Copy shortcode for Alpha' }),
        ).toBeDisabled();
        expect(liveRegion()).toHaveTextContent('Deleting Alpha…');
        // The other row is untouched.
        expect(rowOf('Beta')).not.toHaveClass('is-deleting');

        const calls = list.mock.calls.length;

        server.items = [items()[1]!];
        await act(async () => {
            answer.resolve({ ok: true, status: 'deleted', message: 'Video deleted.' });
        });

        expect(await screen.findByText('Video deleted.')).toBeInTheDocument();
        expect(liveRegion()).toHaveTextContent('Deleted Alpha');
        await waitFor(() =>
            expect(screen.queryByText('Alpha', { selector: '.video-title' })).toBeNull(),
        );
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
        expect(rowOf('Beta')).not.toHaveClass('is-deleting');
    });

    it('returns the row to normal on a failure, a skipped delete and an exception', async () => {
        const { user, remove } = await openLibrary(view, items());

        remove.mockResolvedValueOnce({ ok: false, error: 'Server said no.' });
        await confirmDelete(user, 'Alpha');
        expect(await screen.findByText(/Server said no\./)).toBeInTheDocument();
        await waitFor(() => expect(rowOf('Alpha')).not.toHaveClass('is-deleting'));
        expect(rowOf('Alpha')).not.toHaveAttribute('aria-busy');
        expect(
            within(rowOf('Alpha')).getByRole('button', { name: 'More actions for Alpha' }),
        ).toBeEnabled();

        remove.mockResolvedValueOnce({ ok: true, status: 'skipped', message: 'skipped' });
        await confirmDelete(user, 'Alpha');
        expect(await screen.findByText(/still processing/)).toBeInTheDocument();
        await waitFor(() => expect(rowOf('Alpha')).not.toHaveClass('is-deleting'));

        remove.mockRejectedValueOnce(new Error('boom'));
        await confirmDelete(user, 'Alpha');
        expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
        await waitFor(() => expect(rowOf('Alpha')).not.toHaveClass('is-deleting'));
        expect(within(rowOf('Alpha')).queryByText('Deleting…')).toBeNull();
    });

    it('ignores a second delete of a video that is already being deleted', async () => {
        const { user, remove } = await openLibrary(view, items());
        const answer = deferred<VideosDeleteResult>();

        remove.mockReturnValue(answer.promise);
        await confirmDelete(user, 'Alpha');
        expect(remove).toHaveBeenCalledTimes(1);

        // The menu of the pending row is disabled, so Delete cannot be asked again.
        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
        expect(remove).toHaveBeenCalledTimes(1);

        await act(async () => {
            answer.resolve({ ok: true, status: 'skipped', message: 'skipped' });
        });
    });

    it('marks every selected row, keeps them until the reload answers, then clears them', async () => {
        const { user, bulk, server, list } = await openLibrary(view, [
            ...items(),
            makeVideo({ id: 3, title: 'Gamma' }),
        ]);
        const answer = deferred<VideosBulkDeleteResult>();
        const reload = deferred<VideosListResult>();

        bulk.mockReturnValue(answer.promise);
        await enterSelectMode(user, 'Alpha');
        await user.click(screen.getByRole('checkbox', { name: 'Select Beta' }));
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(bulk).toHaveBeenCalledWith([1, 2]);
        expect(rowOf('Alpha')).toHaveClass('is-deleting');
        expect(rowOf('Beta')).toHaveClass('is-deleting');
        expect(rowOf('Gamma')).not.toHaveClass('is-deleting');
        expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Exit select mode' })).toBeDisabled();

        // The request answers: Alpha was deleted, Beta failed. Markers stay until the reload.
        list.mockImplementation(() => reload.promise);
        await act(async () => {
            answer.resolve({
                ok: true,
                deleted: 1,
                failed: 1,
                skipped: 0,
                message: 'Deleted 1 video, 1 failed.',
            });
        });
        expect(await screen.findByText(/Deleted 1 video, 1 failed\./)).toBeInTheDocument();
        expect(rowOf('Alpha')).toHaveClass('is-deleting');
        expect(rowOf('Beta')).toHaveClass('is-deleting');

        server.items = [items()[1]!, makeVideo({ id: 3, title: 'Gamma' })];
        await act(async () => {
            reload.resolve(ok(server.items));
        });

        await waitFor(() =>
            expect(screen.queryByText('Alpha', { selector: '.video-title' })).toBeNull(),
        );
        expect(rowOf('Beta')).not.toHaveClass('is-deleting');
        expect(rowOf('Gamma')).not.toHaveClass('is-deleting');
    });

    it('clears every marker when the bulk request fails', async () => {
        const { user, bulk } = await openLibrary(view, items());

        bulk.mockRejectedValue(new Error('boom'));
        await enterSelectMode(user, 'Alpha');
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
        await waitFor(() => expect(rowOf('Alpha')).not.toHaveClass('is-deleting'));
        expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeEnabled();
    });

    it('does not fail when the screen unmounts during the request', async () => {
        const { user, remove, unmount } = await openLibrary(view, items());
        const answer = deferred<VideosDeleteResult>();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        remove.mockReturnValue(answer.promise);
        await confirmDelete(user, 'Alpha');
        unmount();
        await act(async () => {
            answer.resolve({ ok: true, status: 'deleted', message: 'Video deleted.' });
        });
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(errors).not.toHaveBeenCalled();
    });
});
