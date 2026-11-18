import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem, VideoListMeta, VideosListResult } from '../../../shared/ipc';
import { makeJob, makeVideo } from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';

function ok(data: VideoListItem[], m: Partial<VideoListMeta> = {}): VideosListResult {
    return {
        ok: true,
        data,
        meta: { page: 1, perPage: 24, total: data.length, lastPage: 1, ...m },
    };
}

const RUNNING = makeJob({ id: 'j1', state: 'uploading', progress: 50 });
const DONE = makeJob({ id: 'j1', state: 'done', progress: 100, videoId: 7 });

async function openLibrary(list: (params?: unknown) => Promise<VideosListResult>) {
    const rendered = await renderApp();
    const spy = vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation(list);

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return { ...rendered, spy };
}

const NOTICE = 'New videos are available.';

afterEach(() => {
    vi.useRealTimers();
});

describe('Library auto-refresh on a finished job', () => {
    it('ignores the first snapshot and only reacts to a transition into done', async () => {
        const { fake, spy } = await openLibrary(() => Promise.resolve(ok([makeVideo()])));

        // First snapshot, even with a done job in it, is only the baseline.
        push(() => fake.emitJobs([DONE]));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(NOTICE)).toBeNull();

        // Staying done does not count either.
        push(() => fake.emitJobs([{ ...DONE, updatedAt: '2026-01-02T00:00:00.000Z' }]));
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reloads page 1 once, quietly, when a job becomes done', async () => {
        const resolvers: Array<(result: VideosListResult) => void> = [];
        let first = true;
        const { fake, spy } = await openLibrary(() => {
            if (first) {
                first = false;

                return Promise.resolve(ok([makeVideo({ id: 1, title: 'Old one' })]));
            }

            return new Promise<VideosListResult>((resolve) => resolvers.push(resolve));
        });

        push(() => fake.emitJobs([RUNNING]));
        expect(spy).toHaveBeenCalledTimes(1);

        push(() => fake.emitJobs([DONE]));
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24 });
        // No flicker: the old rows stay and there is no loading state while it reloads.
        expect(screen.getByText('Old one')).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).toBeNull();

        await act(async () => {
            resolvers[0]!(
                ok([
                    makeVideo({ id: 2, title: 'Brand new' }),
                    makeVideo({ id: 1, title: 'Old one' }),
                ]),
            );
        });

        expect(screen.getByText('Brand new')).toBeInTheDocument();
        expect(screen.queryByText(NOTICE)).toBeNull();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('shows a notice instead of reloading when there is search text', async () => {
        const { fake, spy } = await openLibrary(() => Promise.resolve(ok([makeVideo()])));

        // Fake timers keep the 400 ms search debounce from firing on a slow machine, which
        // would turn the typed text into a real search (and a second list call) mid-test.
        vi.useFakeTimers();
        fireEvent.change(screen.getByLabelText('Search videos'), { target: { value: 'abc' } });
        push(() => fake.emitJobs([RUNNING]));
        push(() => fake.emitJobs([DONE]));

        expect(screen.getByText(NOTICE)).toBeInTheDocument();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('shows a notice on page 2 and the notice Refresh goes back to page 1', async () => {
        const { fake, spy, user } = await openLibrary((params) => {
            const page = (params as { page: number }).page;

            return Promise.resolve(
                ok([makeVideo({ id: page, title: `Page ${page}` })], { page, lastPage: 3 }),
            );
        });

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('Page 2');
        expect(spy).toHaveBeenCalledTimes(2);

        push(() => fake.emitJobs([RUNNING]));
        push(() => fake.emitJobs([DONE]));

        const notice = screen.getByText(NOTICE).closest('p')!;

        expect(spy).toHaveBeenCalledTimes(2);

        await user.click(within(notice).getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('Page 1')).toBeInTheDocument();
        expect(spy).toHaveBeenCalledTimes(3);
        expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24 });
        expect(screen.queryByText(NOTICE)).toBeNull();
    });

    it('does not disturb an open detail page and shows the notice after going back', async () => {
        const { fake, spy, user } = await openLibrary(() =>
            Promise.resolve(ok([makeVideo({ id: 1, title: 'Holiday' })])),
        );

        await user.click(screen.getByRole('button', { name: /^Holiday/ }));
        push(() => fake.emitJobs([RUNNING]));
        push(() => fake.emitJobs([DONE]));

        expect(spy).toHaveBeenCalledTimes(1);
        // The list is hidden behind the detail page, so the notice is not exposed yet.
        expect(screen.getByText(NOTICE).closest('[hidden]')).not.toBeNull();

        await user.keyboard('{Escape}');

        await waitFor(() => expect(screen.getByText(NOTICE).closest('[hidden]')).toBeNull());
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reloads when the Library tab is opened again and removes its subscription', async () => {
        const { fake, spy, user } = await openLibrary(() => Promise.resolve(ok([makeVideo()])));
        const subscribed = fake.listenerCount();

        await user.click(screen.getByRole('tab', { name: 'Queue' }));
        expect(fake.listenerCount()).toBe(subscribed - 1);

        push(() => fake.emitJobs([RUNNING]));
        push(() => fake.emitJobs([DONE]));
        expect(spy).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole('tab', { name: 'Library' }));
        await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
        expect(spy).toHaveBeenLastCalledWith({ page: 1, perPage: 24 });
    });
});
