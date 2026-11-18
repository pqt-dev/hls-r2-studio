import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogItem, LogsGetResult, LogsParams } from '../../../shared/ipc';
import { makeLogCounts, makeLogItem, makeVideoDetail, type FakeApi } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

const COUNTS = makeLogCounts({ total: 6, success: 3, error: 2, processing: 1 });

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

function summary(
    partial: Partial<Extract<LogsGetResult, { view: 'summary' }>> = {},
): LogsGetResult {
    return {
        ok: true,
        view: 'summary',
        counts: COUNTS,
        success: [SUCCESS],
        error: [ERROR],
        processing: [PROCESSING],
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

describe('Logs screen summary', () => {
    it('shows the three sections with their rows', async () => {
        const { get } = await openLogs(() => Promise.resolve(summary()));

        expect(await screen.findByRole('heading', { name: 'Recent successes' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Recent errors' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'In progress' })).toBeVisible();
        // "All" asks for the summary shape: no arguments.
        expect(get).toHaveBeenCalledWith(undefined);

        const successes = screen.getByRole('list', { name: 'Recent successes' });
        const errors = screen.getByRole('list', { name: 'Recent errors' });
        const progress = screen.getByRole('list', { name: 'In progress' });

        expect(within(successes).getByRole('button', { name: 'Holiday clip' })).toBeVisible();
        expect(within(successes).getByText('Ready')).toBeVisible();
        expect(within(errors).getByText('Failed')).toBeVisible();
        expect(within(errors).getByText('3 hours ago')).toBeVisible();
        expect(within(progress).getByText('Processing')).toBeVisible();
        expect(within(progress).getByText('transcoding')).toBeVisible();
        expect(within(progress).getByText('40%')).toBeVisible();

        const bar = within(progress).getByRole('progressbar', { name: 'Progress of Busy clip' });

        expect(bar).toHaveAttribute('value', '40');
    });

    it('shows the counts on the filter buttons', async () => {
        await openLogs(() => Promise.resolve(summary()));
        await screen.findByRole('heading', { name: 'Recent errors' });

        const filter = screen.getByRole('group', { name: 'Filter logs' });

        expect(within(filter).getByRole('button', { name: 'All (6)' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(within(filter).getByRole('button', { name: 'Success (3)' })).toBeVisible();
        expect(within(filter).getByRole('button', { name: 'Error (2)' })).toBeVisible();
        expect(within(filter).getByRole('button', { name: 'Processing (1)' })).toBeVisible();
    });

    it('marks a section without rows instead of hiding it', async () => {
        await openLogs(() => Promise.resolve(summary({ success: [], processing: [] })));

        await screen.findByRole('heading', { name: 'Recent errors' });
        expect(screen.getByRole('heading', { name: 'Recent successes' })).toBeVisible();
        expect(screen.getAllByText('Nothing here.')).toHaveLength(2);
    });

    it('opens the video detail from a row title', async () => {
        const { user, fake } = await openLogs(() => Promise.resolve(summary()));
        const get = vi.fn((id: number) =>
            Promise.resolve({ ok: true as const, video: makeVideoDetail({ id }) }),
        );

        fake.api.videos.get = get;
        await user.click(await screen.findByRole('button', { name: 'Busy clip' }));

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await waitFor(() => expect(get).toHaveBeenCalledWith(3));
    });
});

describe('Logs screen filters and pagination', () => {
    it.each([
        ['Success', 'success', SUCCESS],
        ['Error', 'error', ERROR],
        ['Processing', 'processing', PROCESSING],
    ] as const)('the %s filter asks for the paginated %s shape', async (label, type, item) => {
        const { user, get } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([item])),
        );

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));

        expect(await screen.findByRole('list', { name: `${label} logs` })).toBeVisible();
        expect(get).toHaveBeenLastCalledWith({ type, page: 1, perPage: 24 });
        expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.getByRole('button', { name: item.title })).toBeVisible();
        // The sections of the summary are gone.
        expect(screen.queryByRole('heading', { name: 'Recent successes' })).toBeNull();
        // One page: only the count of the pager (no nav buttons or page field).
        expect(screen.queryByRole('textbox', { name: 'Current page' })).toBeNull();
        expect(screen.getByText(/1 log$/)).toBeVisible();
    });

    it('goes back to the summary with All', async () => {
        const { user, get } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([SUCCESS])),
        );

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: /^Success/ }));
        await screen.findByRole('list', { name: 'Success logs' });
        await user.click(screen.getByRole('button', { name: /^All/ }));

        expect(await screen.findByRole('heading', { name: 'Recent errors' })).toBeVisible();
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

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: /^Success/ }));
        expect(await screen.findByRole('button', { name: 'Row page 1' })).toBeVisible();
        expect(screen.getByRole('textbox', { name: 'Current page' })).toHaveValue('1');
        expect(screen.getByText('of 3')).toBeVisible();
        expect(screen.getByText(/50 logs/)).toBeVisible();

        const panel = document.querySelector<HTMLElement>('.panel');

        expect(panel).not.toBeNull();
        panel!.scrollTop = 120;

        await user.click(screen.getByRole('button', { name: 'Next page' }));

        expect(await screen.findByRole('button', { name: 'Row page 2' })).toBeVisible();
        expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 2, perPage: 24 });
        expect(panel!.scrollTop).toBe(0);
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

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: /^Success/ }));
        await screen.findByRole('button', { name: 'Some row' });
        await user.click(screen.getByRole('button', { name: 'Last page' }));
        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'success', page: 3, perPage: 24 }),
        );
        await user.click(screen.getByRole('button', { name: /^Error/ }));

        await waitFor(() =>
            expect(get).toHaveBeenLastCalledWith({ type: 'error', page: 1, perPage: 24 }),
        );
    });
});

describe('Logs screen error details', () => {
    it('shows the message and toggles the details as plain text', async () => {
        const { user } = await openLogs(() => Promise.resolve(summary()));

        await screen.findByRole('heading', { name: 'Recent errors' });

        const errors = screen.getByRole('list', { name: 'Recent errors' });
        const toggle = within(errors).getByRole('button', { name: 'Details' });

        // Server text is text: the markup is shown literally, never parsed.
        expect(within(errors).getByText('Transcode failed: <i>bad</i>')).toBeVisible();
        expect(within(errors).getByRole('button', { name: 'Broken <b>clip</b>' })).toBeVisible();
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(errors.querySelector('pre')).toBeNull();

        await user.click(toggle);

        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(toggle).toHaveAttribute('aria-controls', errors.querySelector('pre')?.id);

        const detail = errors.querySelector('pre');

        expect(detail?.textContent).toBe(HTML_DETAIL);
        expect(detail?.children).toHaveLength(0);
        expect(document.querySelector('img, script, b, i')).toBeNull();

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

        await screen.findByRole('heading', { name: 'Recent errors' });
        expect(screen.getByText('Oops.')).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    });

    it('also renders details in the paginated view', async () => {
        const { user } = await openLogs((params) =>
            Promise.resolve(params === undefined ? summary() : pageOf([ERROR])),
        );

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: /^Error/ }));
        await user.click(await screen.findByRole('button', { name: 'Details' }));

        expect(document.querySelector('pre')?.textContent).toBe(HTML_DETAIL);
        expect(document.querySelector('img')).toBeNull();
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

        expect(await screen.findByRole('heading', { name: 'Recent errors' })).toBeVisible();
        expect(screen.queryByText(/Loading/)).toBeNull();
    });

    it('shows "No logs yet" for an empty summary and an empty page', async () => {
        const { user } = await openLogs((params) =>
            Promise.resolve(
                params === undefined
                    ? summary({ success: [], error: [], processing: [], counts: makeLogCounts() })
                    : pageOf([]),
            ),
        );

        expect(await screen.findByText('No logs yet')).toBeVisible();
        expect(screen.queryByRole('heading', { name: 'Recent errors' })).toBeNull();

        await user.click(screen.getByRole('button', { name: /^Error/ }));
        await waitFor(() => expect(screen.getByText('No logs yet')).toBeVisible());
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

        expect(await screen.findByRole('heading', { name: 'Recent errors' })).toBeVisible();
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

    it('Refresh loads the current view again', async () => {
        const { user, get } = await openLogs(() => Promise.resolve(summary()));

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('heading', { name: 'Recent errors' })).toBeVisible();
    });

    it('ignores a stale answer that arrives after the filter changed', async () => {
        const slowSuccess = deferred<LogsGetResult>();
        const { user } = await openLogs((params) => {
            if (params === undefined) return Promise.resolve(summary());

            return params.type === 'success'
                ? slowSuccess.promise
                : Promise.resolve(pageOf([ERROR]));
        });

        await screen.findByRole('heading', { name: 'Recent errors' });
        await user.click(screen.getByRole('button', { name: /^Success/ }));
        await user.click(screen.getByRole('button', { name: /^Error/ }));
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
        expect(screen.queryByRole('heading', { name: 'Recent errors' })).toBeNull();
    });
});
