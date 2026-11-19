import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogItem, LogsGetResult, LogsParams } from '../../../shared/ipc';
import {
    makeJob,
    makeLogCounts,
    makeLogItem,
    makeVideoDetail,
    type FakeApi,
} from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';

const COUNTS = makeLogCounts({ total: 7, success: 3, error: 2, processing: 2 });

const HTML_DETAIL = '<img src=x onerror=alert(1)>\nline two\n<script>alert(2)</script>';

const SUCCESS = makeLogItem({ id: 1, title: 'Holiday clip', status: 'ready' });
const ERROR = makeLogItem({
    id: 2,
    title: 'Broken <b>clip</b>',
    status: 'failed',
    errorMessage: 'Transcode failed: <i>bad</i>',
    errorDetail: HTML_DETAIL,
    failedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
});
const PROCESSING = makeLogItem({
    id: 3,
    title: 'Busy clip',
    status: 'processing',
    stage: 'transcoding',
    progress: 40,
});
const QUEUED = makeLogItem({
    id: 4,
    title: 'Waiting clip',
    status: 'pending',
    stage: 'queued',
    progress: 35,
});

function summary(
    partial: Partial<Extract<LogsGetResult, { view: 'summary' }>> = {},
): LogsGetResult {
    return {
        ok: true,
        view: 'summary',
        counts: COUNTS,
        success: [SUCCESS],
        error: [ERROR],
        processing: [PROCESSING, QUEUED],
        ...partial,
    };
}

function pageOf(
    items: LogItem[],
    meta: Partial<{ page: number; lastPage: number; total: number }> = {},
): LogsGetResult {
    return {
        ok: true,
        view: 'page',
        counts: COUNTS,
        data: items,
        meta: { page: 1, perPage: 24, total: items.length, lastPage: 1, ...meta },
    };
}

type Get = ReturnType<typeof vi.fn<(params?: LogsParams) => Promise<LogsGetResult>>>;

async function openLogs(handler: (params?: LogsParams) => Promise<LogsGetResult>) {
    let get!: Get;
    // The app opens on Home, which asks for the logs summary once: answer it with a fixed
    // summary so `handler` (and the call counts) only see the Logs screen.
    let homeCall = true;
    const rendered = await renderApp({}, (fake: FakeApi) => {
        get = vi.fn((params?: LogsParams) => {
            if (!homeCall) return handler(params);

            homeCall = false;

            return Promise.resolve(summary());
        });
        fake.api.logs.get = get;
    });

    get.mockClear();
    await rendered.user.click(screen.getByRole('tab', { name: 'Logs' }));

    return { ...rendered, get };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });

    return { promise, resolve };
}

afterEach(() => {
    vi.restoreAllMocks();
});

function tile(name: RegExp | string) {
    return within(screen.getByRole('list', { name: 'Filter logs' })).getByRole('button', {
        name,
    });
}

describe('Logs screen default view', () => {
    it('shows four tiles with the counts, Total selected', async () => {
        const { get } = await openLogs(() => Promise.resolve(summary()));

        await screen.findByRole('region', { name: 'Error' });
        // "All" asks for the summary shape: no arguments.
        expect(get).toHaveBeenCalledWith(undefined);

        const tiles = within(screen.getByRole('list', { name: 'Filter logs' })).getAllByRole(
            'button',
        );

        expect(tiles.map((button) => button.textContent)).toEqual([
            '7Total',
            '3Success',
            '2Processing',
            '2Error',
        ]);
        expect(tile(/^Total:/)).toHaveAttribute('aria-pressed', 'true');
        expect(tile(/^Error:/)).toHaveAttribute('aria-pressed', 'false');
    });

    it('shows the tiles as dashes before the first answer', async () => {
        const slow = deferred<LogsGetResult>();

        await openLogs(() => slow.promise);

        expect(screen.getAllByText('—')).toHaveLength(4);
    });

    it('always shows both Error and Success with their rows and counts', async () => {
        await openLogs(() => Promise.resolve(summary()));

        const errors = await screen.findByRole('region', { name: 'Error' });
        const successes = screen.getByRole('region', { name: 'Success' });

        expect(within(errors).getByText('Broken <b>clip</b>')).toBeVisible();
        expect(within(errors).getByText('Failed 3 hours ago')).toBeVisible();
        expect(within(errors).getByText('2')).toBeVisible();
        expect(within(successes).getByText('Holiday clip')).toBeVisible();
        expect(within(successes).getByText('3')).toBeVisible();
        expect(within(successes).getByText(/ago$/)).toHaveAttribute(
            'title',
            expect.stringContaining('2026'),
        );
        expect(screen.queryByRole('button', { name: 'View all successes' })).toBeNull();
    });

    it('shows the empty texts and the "Showing latest" note', async () => {
        await openLogs(() =>
            Promise.resolve(summary({ error: [], processing: [], counts: COUNTS })),
        );

        expect(await screen.findByText('No error logs.')).toBeVisible();
        expect(screen.getByText('Holiday clip')).toBeVisible();
        expect(screen.getByText('Showing latest 1 of 3')).toBeVisible();
        expect(screen.queryByRole('region', { name: /^Processing/ })).toBeNull();
    });

    it('shows both empty texts and no processing block for an empty site', async () => {
        await openLogs(() =>
            Promise.resolve(
                summary({ success: [], error: [], processing: [], counts: makeLogCounts() }),
            ),
        );

        expect(await screen.findByText('No error logs.')).toBeVisible();
        expect(screen.getByText('No success logs.')).toBeVisible();
        expect(screen.queryByRole('region', { name: /^Processing/ })).toBeNull();
    });

    it('opens the video in the Library from View in Library', async () => {
        const { user, fake } = await openLogs(() => Promise.resolve(summary()));
        const get = vi.fn((id: number) =>
            Promise.resolve({ ok: true as const, video: makeVideoDetail({ id }) }),
        );

        fake.api.videos.get = get;
        await user.click(
            await screen.findByRole('button', { name: 'View in Library for Holiday clip' }),
        );

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await waitFor(() => expect(get).toHaveBeenCalledWith(1));
    });
});

describe('Logs screen processing block', () => {
    it('shows the title, overall progress, stage summary and each video', async () => {
        await openLogs(() => Promise.resolve(summary()));

        const block = await screen.findByRole('region', { name: 'Processing 2 videos' });

        expect(within(block).getByText('1 transcoding · 1 queued')).toBeVisible();
        // (40 + 0) / 2: the queued video counts as 0 whatever its progress says.
        expect(
            within(block).getByRole('progressbar', { name: 'Progress of all processing videos' }),
        ).toHaveAttribute('value', '20');

        const list = within(block).getByRole('list', { name: 'Processing logs' });
        const busy = within(list).getByText('Busy clip').closest('li')!;
        const waiting = within(list).getByText('Waiting clip').closest('li')!;

        expect(within(busy).getByText('Processing')).toBeVisible();
        expect(within(busy).getByText('Transcoding…')).toBeVisible();
        expect(within(busy).getByRole('progressbar')).toHaveAttribute('value', '40');
        expect(within(waiting).getByText('Queued')).toBeVisible();
        expect(within(waiting).getByRole('progressbar')).toHaveAttribute('value', '0');
        expect(within(waiting).getByText('0%')).toBeVisible();
    });

    it('uses the singular title and the stage label for one video', async () => {
        await openLogs(() =>
            Promise.resolve(
                summary({
                    processing: [{ ...PROCESSING, stage: 'uploading_r2' }],
                    counts: makeLogCounts({ total: 1, processing: 1 }),
                }),
            ),
        );

        const block = await screen.findByRole('region', { name: 'Processing 1 video' });

        expect(within(block).getAllByText('Uploading to R2').length).toBeGreaterThan(0);
        expect(within(block).getByText('Uploading to R2…')).toBeVisible();
    });

    it('treats a pending video that is merging as Processing', async () => {
        await openLogs(() =>
            Promise.resolve(
                summary({ processing: [{ ...QUEUED, stage: 'merging', progress: 10 }] }),
            ),
        );

        const row = (await screen.findByText('Waiting clip')).closest('li')!;

        expect(within(row).getByText('Processing')).toBeVisible();
        expect(within(row).getByText('Merging chunks…')).toBeVisible();
        expect(within(row).getByText('10%')).toBeVisible();
    });
});

describe('Logs screen filters and pagination', () => {
    it.each([
        ['Success', 'success', 'Success logs', SUCCESS],
        ['Error', 'error', 'Error logs', ERROR],
        ['Processing', 'processing', 'Processing logs', PROCESSING],
    ] as const)(
        'the %s tile asks for the paginated %s shape',
        async (label, type, listName, item) => {
            const { user, get } = await openLogs((params) =>
                Promise.resolve(params === undefined ? summary() : pageOf([item])),
            );

            await screen.findByRole('region', { name: 'Success' });
            await user.click(tile(new RegExp(`^${label}:`)));

            expect(await screen.findByRole('list', { name: listName })).toBeVisible();
            expect(get).toHaveBeenLastCalledWith({ type, page: 1, perPage: 24 });
            expect(tile(new RegExp(`^${label}:`))).toHaveAttribute('aria-pressed', 'true');
            expect(tile(/^Total:/)).toHaveAttribute('aria-pressed', 'false');
            expect(screen.getByText(item.title)).toBeVisible();
            // The two columns of the default view are gone.
            expect(document.querySelector('.log-columns')).toBeNull();
            // One page: only the count of the pager (no nav buttons or page field).
            expect(screen.queryByRole('textbox', { name: 'Current page' })).toBeNull();
            expect(screen.getByText(/1 log$/)).toBeVisible();
        },
    );

    it('goes back to both columns with Total', async () => {
        const { user, get } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([SUCCESS])),
        );

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        await screen.findByRole('list', { name: 'Success logs' });
        await user.click(tile(/^Total:/));

        expect(await screen.findByRole('region', { name: 'Error' })).toBeVisible();
        expect(screen.getByRole('region', { name: 'Success' })).toBeVisible();
        expect(get).toHaveBeenLastCalledWith(undefined);
    });

    it('pages with the pager and scrolls to the top', async () => {
        const { user, get } = await openLogs((params) => {
            if (params === undefined) return Promise.resolve(summary());

            return Promise.resolve(
                pageOf(
                    [
                        makeLogItem({
                            id: 40 + (params.page ?? 1),
                            title: `Row page ${params.page}`,
                        }),
                    ],
                    {
                        page: params.page ?? 1,
                        lastPage: 3,
                        total: 50,
                    },
                ),
            );
        });

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        expect(await screen.findByText('Row page 1')).toBeVisible();
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]).toHaveValue('1');
        expect(screen.getAllByText('of 3')[0]).toBeVisible();
        expect(screen.getAllByText(/50 logs/)[0]).toBeVisible();

        const panel = document.querySelector<HTMLElement>('.panel');

        expect(panel).not.toBeNull();
        panel!.scrollTop = 120;

        await user.click(
            within(screen.getByRole('navigation', { name: 'Logs pagination, top' })).getByRole(
                'button',
                { name: 'Next page' },
            ),
        );

        expect(await screen.findByText('Row page 2')).toBeVisible();
        expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 2, perPage: 24 });
        expect(panel!.scrollTop).toBe(0);
    });

    it('changes the page size, remembers it and starts again on page 1', async () => {
        window.localStorage.removeItem('hls.logs.perPage');

        const { user, get } = await openLogs((params) => {
            if (params === undefined) return Promise.resolve(summary());

            return Promise.resolve(
                pageOf([makeLogItem({ id: 50, title: 'Some row' })], {
                    page: params.page ?? 1,
                    lastPage: 3,
                    total: 50,
                }),
            );
        });

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        await screen.findByText('Some row');
        await user.click(
            within(screen.getByRole('navigation', { name: 'Logs pagination, top' })).getByRole(
                'button',
                { name: 'Last page' },
            ),
        );
        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 3, perPage: 24 }),
        );

        await user.selectOptions(screen.getByRole('combobox', { name: 'Items per page' }), '12');

        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 1, perPage: 12 }),
        );
        expect(window.localStorage.getItem('hls.logs.perPage')).toBe('12');

        window.localStorage.removeItem('hls.logs.perPage');
    });

    it('starts again on page 1 when the filter changes', async () => {
        const { user, get } = await openLogs((params) => {
            if (params === undefined) return Promise.resolve(summary());

            return Promise.resolve(
                pageOf([makeLogItem({ id: 50, title: 'Some row' })], {
                    page: params.page ?? 1,
                    lastPage: 3,
                    total: 50,
                }),
            );
        });

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        await screen.findByText('Some row');
        await user.click(
            within(screen.getByRole('navigation', { name: 'Logs pagination, top' })).getByRole(
                'button',
                { name: 'Last page' },
            ),
        );
        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 3, perPage: 24 }),
        );
        await user.click(tile(/^Error:/));

        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'error', page: 1, perPage: 24 }),
        );
    });

    it('shows a processing row without actions in the filtered list', async () => {
        const { user } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([QUEUED])),
        );

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Processing:/));

        const row = (await screen.findByText('Waiting clip')).closest('li')!;

        expect(within(row).getByText('Queued')).toBeVisible();
        expect(within(row).getByText('0%')).toBeVisible();
    });
});

describe('Logs screen error details', () => {
    it('shows the message and toggles the details as plain text', async () => {
        const { user } = await openLogs(() => Promise.resolve(summary()));

        const errors = await screen.findByRole('list', { name: 'Error logs' });
        const toggle = within(errors).getByRole('button', { name: /^Details/ });

        // Server text is text: the markup is shown literally, never parsed.
        expect(within(errors).getByText('Transcode failed: <i>bad</i>')).toBeVisible();
        expect(within(errors).getByText('Broken <b>clip</b>')).toBeVisible();
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(errors.querySelector('pre')).toBeNull();

        await user.click(toggle);

        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(toggle).toHaveAttribute('aria-controls', errors.querySelector('pre')?.id);
        expect(within(errors).getByText('Technical details')).toBeVisible();

        const detail = errors.querySelector('pre');

        expect(detail?.textContent).toBe(HTML_DETAIL);
        expect(detail?.children).toHaveLength(0);
        expect(errors.querySelector('img, script, b, i')).toBeNull();

        await user.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(errors.querySelector('pre')).toBeNull();
    });

    it('offers Details only when there is a detail text', async () => {
        await openLogs(() =>
            Promise.resolve(
                summary({
                    error: [makeLogItem({ id: 9, status: 'failed', errorMessage: 'Oops.' })],
                }),
            ),
        );

        expect(await screen.findByText('Oops.')).toBeVisible();
        expect(screen.queryByRole('button', { name: /^Details/ })).toBeNull();
    });

    it('also renders details in the paginated view', async () => {
        const { user } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([ERROR])),
        );

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Error:/));
        await user.click(await screen.findByRole('button', { name: /^Details/ }));

        expect(document.querySelector('pre')?.textContent).toBe(HTML_DETAIL);
        expect(document.querySelector('pre img')).toBeNull();
    });
});

describe('Logs screen quiet auto-refresh', () => {
    it('reloads without a loading state and keeps an open Details when a job finishes', async () => {
        const next = deferred<LogsGetResult>();
        let calls = 0;
        const { user, fake, get } = await openLogs(() => {
            calls += 1;

            return calls === 1 ? Promise.resolve(summary()) : next.promise;
        });

        await user.click(await screen.findByRole('button', { name: /^Details/ }));
        expect(document.querySelector('pre')).not.toBeNull();

        push(() => fake.emitJobs([makeJob({ id: 'j1', state: 'uploading', progress: 50 })]));
        push(() => fake.emitJobs([makeJob({ id: 'j1', state: 'done', progress: 100 })]));

        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        // Rows stay, no loading text, Details still open while the answer is pending.
        expect(screen.queryByText('Loading…')).toBeNull();
        expect(screen.getByText('Holiday clip')).toBeVisible();
        expect(document.querySelector('pre')).not.toBeNull();

        await act(async () => {
            next.resolve(
                summary({ success: [makeLogItem({ id: 11, title: 'Fresh clip' }), SUCCESS] }),
            );
            await next.promise;
        });

        expect(await screen.findByText('Fresh clip')).toBeVisible();
        expect(document.querySelector('pre')).not.toBeNull();
    });

    it('reloads the current page quietly when the window comes back', async () => {
        const { user, get } = await openLogs((params) =>
            Promise.resolve(
                params === undefined
                    ? summary()
                    : pageOf([makeLogItem({ id: 50, title: 'Some row' })], {
                          page: params.page ?? 1,
                          lastPage: 3,
                          total: 50,
                      }),
            ),
        );

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        await screen.findByText('Some row');
        get.mockClear();

        fireEvent(window, new Event('focus'));

        await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
        expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 1, perPage: 24 });
        expect(screen.queryByText('Loading…')).toBeNull();
        expect(screen.getByText('Some row')).toBeVisible();
    });

    it('keeps what is on screen when a quiet reload fails', async () => {
        let calls = 0;
        const { get } = await openLogs(() => {
            calls += 1;

            return Promise.resolve(
                calls === 1 ? summary() : { ok: false as const, error: 'Could not load.' },
            );
        });

        await screen.findByText('Holiday clip');
        fireEvent(window, new Event('focus'));

        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText('Holiday clip')).toBeVisible();
    });

    it('polls every few seconds while something is processing and stops otherwise', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            const { get } = await openLogs(() => Promise.resolve(summary()));

            await screen.findByRole('region', { name: 'Processing 2 videos' });
            get.mockClear();

            await act(async () => {
                vi.advanceTimersByTime(8000);
            });

            expect(get).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not poll when nothing is processing', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            const { get } = await openLogs(() =>
                Promise.resolve(
                    summary({
                        processing: [],
                        counts: makeLogCounts({ total: 5, error: 2, success: 3 }),
                    }),
                ),
            );

            await screen.findByRole('region', { name: 'Error' });
            get.mockClear();

            await act(async () => {
                vi.advanceTimersByTime(60_000);
            });

            expect(get).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Logs screen states', () => {
    it('shows a loading state, then the rows', async () => {
        const slow = deferred<LogsGetResult>();

        await openLogs(() => slow.promise);

        expect(screen.getByText('Loading…')).toHaveAttribute('aria-busy', 'true');

        await act(async () => {
            slow.resolve(summary());
            await slow.promise;
        });

        expect(await screen.findByRole('region', { name: 'Error' })).toBeVisible();
        expect(screen.queryByText(/Loading/)).toBeNull();
    });

    it('shows the empty text for an empty filtered page', async () => {
        const { user } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([])),
        );

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Error:/));

        expect(await screen.findByText('No error logs.')).toBeVisible();
        expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    });

    it('shows the error with a Retry that loads again', async () => {
        let calls = 0;
        const { user } = await openLogs(() => {
            calls += 1;

            return Promise.resolve(
                calls === 1
                    ? { ok: false, error: 'Could not load the logs (HTTP 500).' }
                    : summary(),
            );
        });

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Could not load the logs (HTTP 500).',
        );

        await user.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByRole('region', { name: 'Error' })).toBeVisible();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows a generic error when the call rejects, without the raw text', async () => {
        await openLogs(() => Promise.reject(new Error('secret internal text')));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Something went wrong. Please try again.',
        );
        expect(screen.queryByText(/secret internal text/)).toBeNull();
    });

    it('treats an answer of the wrong shape as an error', async () => {
        await openLogs(() => Promise.resolve(pageOf([SUCCESS])));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Something went wrong. Please try again.',
        );
    });

    it('Refresh loads the current view again, quietly', async () => {
        const { user, get } = await openLogs(() => Promise.resolve(summary()));

        await screen.findByRole('region', { name: 'Error' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('region', { name: 'Error' })).toBeVisible();
    });

    it('ignores a stale answer that arrives after the filter changed', async () => {
        const slowSuccess = deferred<LogsGetResult>();
        const { user } = await openLogs((params) => {
            if (params === undefined) return Promise.resolve(summary());

            return params.type === 'success'
                ? slowSuccess.promise
                : Promise.resolve(pageOf([ERROR]));
        });

        await screen.findByRole('region', { name: 'Error' });
        await user.click(tile(/^Success:/));
        await user.click(tile(/^Error:/));
        expect(await screen.findByRole('list', { name: 'Error logs' })).toBeVisible();

        await act(async () => {
            slowSuccess.resolve(pageOf([makeLogItem({ id: 77, title: 'Stale row' })]));
            await slowSuccess.promise;
        });

        expect(screen.queryByText('Stale row')).toBeNull();
        expect(screen.getByRole('list', { name: 'Error logs' })).toBeVisible();
    });

    it('ignores an answer that arrives after leaving the Logs tab', async () => {
        const slow = deferred<LogsGetResult>();
        const { user } = await openLogs(() => slow.promise);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await user.click(screen.getByRole('tab', { name: 'Home' }));
        await act(async () => {
            slow.resolve(summary());
            await slow.promise;
        });

        expect(errors).not.toHaveBeenCalled();
        expect(screen.queryByRole('region', { name: 'Error' })).toBeNull();
    });
});
