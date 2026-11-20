import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    LogItem,
    LogsGetResult,
    Overview,
    OverviewGetResult,
    VideoListItem,
    VideosListResult,
} from '../../../shared/ipc';
import {
    createFakeApi,
    makeJob,
    makeLogCounts,
    makeLogItem,
    makeOverview,
    makeVideo,
    makeVideoDetail,
    type FakeApi,
} from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';
import { greetingFor } from './HomeScreen';

const OVERVIEW: Overview = makeOverview({
    videos: { total: 100, ready: 85, processing: 10, failed: 5 },
});

const VIDEOS: VideoListItem[] = [
    makeVideo({ id: 1, title: 'Alpha', status: 'ready', duration: 75 }),
    makeVideo({ id: 2, title: 'Beta', status: 'processing', embedUrl: null, duration: null }),
    makeVideo({ id: 3, title: 'Gamma', status: 'failed', embedUrl: null, duration: null }),
];

function listOf(data: VideoListItem[]): VideosListResult {
    return {
        ok: true,
        data,
        meta: { page: 1, perPage: 5, total: data.length, lastPage: 1 },
    };
}

function summaryOf(error: LogItem[]): LogsGetResult {
    return {
        ok: true,
        view: 'summary',
        counts: makeLogCounts({ total: error.length, error: error.length }),
        success: [],
        error,
        processing: [],
    };
}

const FAILED: LogItem[] = [
    makeLogItem({
        id: 11,
        title: 'Broken one',
        status: 'failed',
        errorMessage: 'Transcode failed.',
        failedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }),
    makeLogItem({ id: 12, title: 'Broken two', status: 'failed', errorMessage: 'Upload failed.' }),
];

interface Mocks {
    overview: ReturnType<typeof vi.fn<() => Promise<OverviewGetResult>>>;
    list: ReturnType<typeof vi.fn<(params?: unknown) => Promise<VideosListResult>>>;
    logs: ReturnType<typeof vi.fn<(params?: unknown) => Promise<LogsGetResult>>>;
}

function stub(
    fake: FakeApi,
    data: { overview?: Overview; videos?: VideoListItem[]; failed?: LogItem[] } = {},
): Mocks {
    const mocks: Mocks = {
        overview: vi.fn(() =>
            Promise.resolve<OverviewGetResult>({ ok: true, overview: data.overview ?? OVERVIEW }),
        ),
        list: vi.fn(() => Promise.resolve(listOf(data.videos ?? VIDEOS))),
        logs: vi.fn(() => Promise.resolve(summaryOf(data.failed ?? FAILED))),
    };

    fake.api.overview.get = mocks.overview;
    fake.api.videos.list = mocks.list;
    fake.api.logs.get = mocks.logs;

    return mocks;
}

async function openHome(
    data: Parameters<typeof stub>[1] = {},
    state: Parameters<typeof renderApp>[0] = {},
) {
    let mocks!: Mocks;
    const rendered = await renderApp(state, (fake) => {
        mocks = stub(fake, data);
    });

    await screen
        .findByRole('button', { name: 'Total videos: 100, open Library' })
        .catch(() => undefined);

    return { ...rendered, mocks };
}

const card = (name: string) => screen.getByRole('region', { name });
/** The single overview card (greeting, activity, actions and the four stat tiles). */
const overviewCard = () => document.querySelector('.home-overview') as HTMLElement;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });

    return { promise, resolve };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('greetingFor', () => {
    it('switches at 12:00 and 18:00 local time', () => {
        expect([0, 5, 11, 12, 15, 17, 18, 21, 23].map((hour) => [hour, greetingFor(hour)])).toEqual(
            [
                [0, 'Good morning'],
                [5, 'Good morning'],
                [11, 'Good morning'],
                [12, 'Good afternoon'],
                [15, 'Good afternoon'],
                [17, 'Good afternoon'],
                [18, 'Good evening'],
                [21, 'Good evening'],
                [23, 'Good evening'],
            ],
        );
    });
});

describe('Home screen header', () => {
    it.each([
        [9, 'Good morning'],
        [14, 'Good afternoon'],
        [20, 'Good evening'],
    ])('greets by the local hour (%i:00) with the username and the site', async (hour, text) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 5, 1, hour, 30));

        await openHome();

        expect(
            screen.getByRole('heading', { level: 2, name: `${text}, alice` }),
        ).toBeInTheDocument();
        expect(within(overviewCard()).queryByText(/Signed in/)).toBeNull();
    });

    it('is the default tab after sign-in', async () => {
        await openHome();

        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Home');
    });

    it('Open Library switches to the Library tab', async () => {
        const { user } = await openHome();

        await user.click(screen.getByRole('button', { name: 'Open Library' }));

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveFocus();
    });
});

describe('Home screen Upload videos', () => {
    it('opens the Queue and toasts when something was added', async () => {
        const { user, fake } = await openHome();

        fake.api.jobs.addFiles = vi.fn(() =>
            Promise.resolve({ added: 2, rejected: [], canceled: false }),
        );
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        expect(await screen.findByText('Added 2 videos to the queue.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('stays on Home without a toast when the dialog was canceled', async () => {
        const { user, fake } = await openHome();
        const addFiles = vi.fn(() => Promise.resolve({ added: 0, rejected: [], canceled: true }));

        fake.api.jobs.addFiles = addFiles;
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        await waitFor(() => expect(addFiles).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.queryByText(/Added/)).toBeNull();
    });

    it('reports rejected files like the Queue and stays on Home when nothing was added', async () => {
        const { user, fake } = await openHome();

        fake.api.jobs.addFiles = vi.fn(() =>
            Promise.resolve({
                added: 0,
                rejected: [{ name: 'notes.txt', reason: 'Unsupported type' }],
                canceled: false,
            }),
        );
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        expect(
            await screen.findByText(/Skipped 1 file: notes\.txt \(Unsupported type\)/),
        ).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    });

    it('shows both toasts and opens the Queue when some files were added and some rejected', async () => {
        const { user, fake } = await openHome();

        fake.api.jobs.addFiles = vi.fn(() =>
            Promise.resolve({
                added: 1,
                rejected: [{ name: 'a.txt', reason: 'Unsupported type' }],
                canceled: false,
            }),
        );
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        expect(await screen.findByText('Added 1 video to the queue.')).toBeInTheDocument();
        expect(screen.getByText(/Skipped 1 file: a\.txt/)).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('shows an error toast when adding fails', async () => {
        const { user, fake } = await openHome();

        fake.api.jobs.addFiles = vi.fn(() => Promise.reject(new Error('boom')));
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));

        expect(await screen.findByText(/Could not add the files\./)).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    });
});

describe('Home screen cards', () => {
    it('shows the video counts as tiles with accessible names', async () => {
        await openHome();

        const videos = overviewCard();

        for (const name of [
            'Total videos: 100, open Library',
            'Ready: 85, open Library',
            'Processing: 10, open Library',
            'Failed: 5, open Library',
        ]) {
            expect(within(videos).getByRole('button', { name })).toBeInTheDocument();
        }

        expect(within(videos).getByRole('button', { name: 'Ready: 85, open Library' })).toHaveClass(
            'stat-ready',
        );
        expect(within(videos).getByRole('button', { name: 'Failed: 5, open Library' })).toHaveClass(
            'stat-failed',
        );
    });

    it('draws a distinct solid SVG icon (no glyph) in each stat tile', async () => {
        await openHome();

        const paths = [
            'Total videos: 100, open Library',
            'Ready: 85, open Library',
            'Processing: 10, open Library',
            'Failed: 5, open Library',
        ].map((name) => {
            const circle = within(overviewCard())
                .getByRole('button', { name })
                .querySelector('.stat-icon') as HTMLElement;
            const svg = circle.querySelector('svg.icon');

            expect(svg).not.toBeNull();
            expect(svg).not.toHaveClass('icon-filled');
            expect(circle).toHaveTextContent('');

            return svg?.innerHTML;
        });

        expect(new Set(paths).size).toBe(4);
    });

    it.each([
        ['Total videos: 100, open Library', 'Library'],
        ['Ready: 85, open Library', 'Library'],
        ['Processing: 10, open Library', 'Library'],
        ['Failed: 5, open Library', 'Library'],
    ])('the %s tile opens the %s tab', async (name, tab) => {
        const { user } = await openHome();

        await user.click(screen.getByRole('button', { name }));

        expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    });

    it('never dims a zero card and highlights Failed only above zero', async () => {
        const { unmount } = await openHome();

        expect(screen.getByRole('button', { name: /^Failed: 5/ })).toHaveClass('is-danger');
        unmount();

        await openHome({
            overview: makeOverview({ videos: { total: 0, ready: 0, processing: 0, failed: 0 } }),
        });
        await screen.findByRole('button', { name: /^Failed: 0/ });

        expect(screen.getByRole('button', { name: /^Failed: 0/ })).not.toHaveClass('is-danger');

        for (const name of [/^Failed: 0/, /^Processing: 0/, /^Total videos: 0/, /^Ready: 0/]) {
            expect(screen.getByRole('button', { name })).not.toHaveClass('is-zero');
        }

        expect(document.querySelector('.is-zero')).toBeNull();
    });

    it('counts the local jobs by queue group', async () => {
        const jobs = [
            makeJob({ id: 'a', state: 'transcoding' }),
            makeJob({ id: 'b', state: 'uploading' }),
            makeJob({ id: 'c', state: 'waiting' }),
            makeJob({ id: 'd', state: 'register_failed' }),
            makeJob({ id: 'e', state: 'failed' }),
            makeJob({ id: 'f', state: 'done' }),
            makeJob({ id: 'g', state: 'cancelled' }),
        ];
        const { user } = await openHome({}, { jobs });
        const computer = card('Queue status');

        expect(within(computer).getByText('2 running')).toBeInTheDocument();
        expect(within(computer).getByText('1 waiting')).toBeInTheDocument();
        expect(within(computer).getByText('1 need attention')).toBeInTheDocument();
        expect(within(computer).getByText('1 failed')).toBeInTheDocument();
        expect(within(computer).getByText('1 done')).toBeInTheDocument();
        // Two different sources: this device (Queue status) and the server (stat cards).
        expect(within(computer).getByText('This device')).toHaveClass('home-caption');
        expect(within(overviewCard()).getByText('On server')).toHaveClass('home-caption');

        await user.click(within(computer).getByRole('button', { name: 'Go to Queue' }));
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('updates the local counts from jobs:updated events', async () => {
        const { fake } = await openHome();
        const computer = card('Queue status');

        expect(within(computer).getByText('0 running')).toBeInTheDocument();
        push(() => fake.emitJobs([makeJob({ id: 'a', state: 'transcoding' })]));
        expect(within(computer).getByText('1 running')).toBeInTheDocument();
    });

    it('shows up to 2 running jobs under the chips with name, progress and stage', async () => {
        const jobs = [
            makeJob({ id: 'a', fileName: 'one.mp4', state: 'uploading', progress: 40 }),
            makeJob({ id: 'b', fileName: 'two.mp4', state: 'transcoding', progress: 10 }),
            makeJob({ id: 'c', fileName: 'three.mp4', state: 'uploading', progress: 90 }),
            makeJob({ id: 'd', fileName: 'queued.mp4', state: 'waiting' }),
        ];

        await openHome({}, { jobs });

        const list = within(card('Queue status')).getByRole('list', { name: 'Running uploads' });

        expect(within(list).getAllByRole('listitem')).toHaveLength(2);
        expect(within(list).queryByText('queued.mp4')).toBeNull();

        const names = within(list)
            .getAllByRole('listitem')
            .map((item) => item.querySelector('.home-running-name')?.textContent);

        for (const name of names) expect(['one.mp4', 'two.mp4', 'three.mp4']).toContain(name);

        const item = within(list).getAllByRole('listitem')[0]!;

        expect(item.querySelector('progress')).not.toBeNull();
        expect(item.querySelector('.job-percent')?.textContent).toMatch(/^\d+%$/);
        expect(item.querySelector('.home-running-name')).toHaveAttribute('title');
    });

    it('shows no running list when nothing runs', async () => {
        await openHome();

        expect(within(card('Queue status')).queryByRole('list')).toBeNull();
    });

    it('lists the 8 newest videos with a status, a duration and quick actions for ready ones', async () => {
        const { mocks } = await openHome();
        const recent = within(card('Recent videos')).getByRole('list', { name: 'Recent videos' });

        expect(mocks.list).toHaveBeenCalledWith({ page: 1, perPage: 8 });
        expect(within(recent).getAllByRole('listitem')).toHaveLength(3);
        expect(within(recent).getByText('1:15')).toBeInTheDocument();
        // A ready video shows its quality chip (same tier chip as the Library), not a status.
        expect(within(recent).getByText('1080p')).toHaveClass('chip-tier-3');
        expect(within(recent).queryByText('Ready')).toBeNull();
        // The status shows only when the video is not ready, in the quality chip's place.
        expect(within(recent).getByText('Processing')).toBeInTheDocument();
        expect(within(recent).getByText('Failed')).toBeInTheDocument();

        for (const name of ['Copy shortcode for Alpha']) {
            // Quiet ghost icon buttons in this dense list (not the teal accent used on cards).
            expect(within(recent).getByRole('button', { name })).toHaveClass('video-quick-ghost');
            expect(within(recent).getByRole('button', { name })).not.toHaveClass(
                'btn-accent-share',
            );
        }

        // Library cluster: shortcode (ready only), thumbnail copy (only with a thumbnail), menu.
        expect(
            within(recent).queryByRole('button', { name: 'Copy thumbnail URL for Alpha' }),
        ).toBeNull();
        expect(within(recent).queryByRole('button', { name: /^Copy direct URL for/ })).toBeNull();
        expect(
            within(recent).queryByRole('button', { name: /Copy shortcode for Beta/ }),
        ).toBeNull();
        expect(within(recent).getByRole('button', { name: 'More actions for Beta' })).toBeVisible();
    });

    it('offers the thumbnail copy for a video that has a thumbnail, in the Library order', async () => {
        await openHome({
            videos: [makeVideo({ id: 1, title: 'Alpha', thumbnailUrl: 'https://t.example/a.jpg' })],
        });

        const group = screen.getByRole('group', { name: 'Quick actions for Alpha' });

        expect(
            within(group)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual([
            'Copy shortcode for Alpha',
            'Copy thumbnail URL for Alpha',
            'More actions for Alpha',
        ]);
    });

    it('the row menu offers Copy direct URL, Open in browser and Details, no Select or Delete', async () => {
        const { user } = await openHome();

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));

        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
            'Copy direct URL',
            'Open in browser',
            'Details',
        ]);
    });

    it('the menu items run the quick actions and Details opens the video', async () => {
        const { user, fake } = await openHome();
        const copyLink = vi.fn(() => Promise.resolve({ ok: true as const }));
        const openEmbed = vi.fn(() => Promise.resolve({ ok: true as const }));
        const get = vi.fn((id: number) =>
            Promise.resolve({ ok: true as const, video: makeVideoDetail({ id, title: 'Alpha' }) }),
        );

        fake.api.videos.copyLink = copyLink;
        fake.api.videos.openEmbed = openEmbed;
        fake.api.videos.get = get;

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Copy direct URL for Alpha' }));
        expect(copyLink).toHaveBeenCalledWith(1, 'embed-url');

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Open in browser for Alpha' }));
        expect(openEmbed).toHaveBeenCalledWith(1);

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Details' }));
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await waitFor(() => expect(get).toHaveBeenCalledWith(1));
    });

    it('a not ready video has only Details in its menu', async () => {
        const { user } = await openHome();

        await user.click(screen.getByRole('button', { name: 'More actions for Beta' }));

        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
            'Details',
        ]);
    });

    it('runs the quick actions through the same API calls and toasts as the Library', async () => {
        const { user, fake } = await openHome();
        const copyLink = vi.fn(() => Promise.resolve({ ok: true as const }));
        const openEmbed = vi.fn(() => Promise.resolve({ ok: false as const, error: 'Nope.' }));

        fake.api.videos.copyLink = copyLink;
        fake.api.videos.openEmbed = openEmbed;

        await user.click(screen.getByRole('button', { name: 'Copy shortcode for Alpha' }));
        expect(copyLink).toHaveBeenLastCalledWith(1, 'shortcode');
        expect(await screen.findByText('Shortcode copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Copy direct URL for Alpha' }));
        expect(copyLink).toHaveBeenLastCalledWith(1, 'embed-url');
        expect(await screen.findByText('Direct URL copied.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Open in browser for Alpha' }));
        expect(openEmbed).toHaveBeenCalledWith(1);
        expect(await screen.findByText(/Nope\./)).toBeInTheDocument();
    });

    it('opens the video detail from a recent row title and View all opens the Library', async () => {
        const { user, fake } = await openHome();
        const get = vi.fn((id: number) =>
            Promise.resolve({ ok: true as const, video: makeVideoDetail({ id, title: 'Alpha' }) }),
        );

        fake.api.videos.get = get;
        await user.click(within(card('Recent videos')).getByRole('button', { name: 'Alpha' }));

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await waitFor(() => expect(get).toHaveBeenCalledWith(1));
    });

    it('View all opens the Library tab', async () => {
        const { user } = await openHome();

        await user.click(within(card('Recent videos')).getByRole('button', { name: 'View all' }));

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('shows an empty state when there are no videos', async () => {
        await openHome({ videos: [] });

        expect(within(card('Recent videos')).getByText('No videos yet')).toBeInTheDocument();
    });
});

describe('Home screen layout', () => {
    it('shows the overview and the three cards and no server health card', async () => {
        await openHome();

        for (const name of ['Queue status', 'Recent videos', 'Needs your attention']) {
            expect(card(name)).toBeInTheDocument();
        }

        expect(screen.queryByRole('region', { name: 'Server health' })).toBeNull();
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('ignores a system object in the overview answer', async () => {
        await openHome({
            overview: { ...OVERVIEW, system: { cpuPercent: 99 } } as Overview,
        });

        expect(within(overviewCard()).getByText('100')).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Server health' })).toBeNull();
    });
});

describe('Home screen needs attention', () => {
    it('lists up to 5 newest failed videos and opens the detail from a row', async () => {
        const many = Array.from({ length: 7 }, (_, index) =>
            makeLogItem({
                id: 20 + index,
                title: `Failed ${index}`,
                status: 'failed',
                errorMessage: `Reason ${index}`,
            }),
        );
        const { user, fake } = await openHome({ failed: many });
        const get = vi.fn((id: number) =>
            Promise.resolve({ ok: true as const, video: makeVideoDetail({ id }) }),
        );
        const attention = card('Needs your attention');

        fake.api.videos.get = get;

        expect(within(attention).getAllByRole('listitem')).toHaveLength(5);
        expect(within(attention).getByText('Reason 0')).toBeInTheDocument();
        expect(within(attention).queryByText('Failed 5')).toBeNull();

        await user.click(within(attention).getByRole('button', { name: 'Failed 2' }));

        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await waitFor(() => expect(get).toHaveBeenCalledWith(22));
    });

    it('shows the message and a relative time for each failure', async () => {
        await openHome({ failed: FAILED });

        const attention = card('Needs your attention');

        expect(within(attention).getByText('Transcode failed.')).toBeInTheDocument();
        expect(within(attention).getByText('5 minutes ago')).toBeInTheDocument();
    });

    it('renders server text as text, never as HTML', async () => {
        await openHome({
            failed: [
                makeLogItem({
                    id: 30,
                    title: '<b>bold</b>',
                    status: 'failed',
                    errorMessage: '<img src=x onerror=alert(1)>',
                }),
            ],
        });

        const attention = card('Needs your attention');

        expect(within(attention).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
        expect(attention.querySelector('img, b')).toBeNull();
    });

    it('shows the empty state when nothing failed and no local job needs attention', async () => {
        await openHome({ failed: [] });

        expect(
            within(card('Needs your attention')).getByText('Nothing needs attention.'),
        ).toBeVisible();
    });

    it('links the local jobs that need attention to the Queue', async () => {
        const { user } = await openHome(
            { failed: [] },
            { jobs: [makeJob({ id: 'x', state: 'needs_sign_in' })] },
        );
        const attention = card('Needs your attention');

        expect(within(attention).queryByText('Nothing needs attention.')).toBeNull();
        expect(
            within(attention).getByText('1 local video on this computer needs attention.'),
        ).toBeInTheDocument();

        await user.click(within(attention).getByRole('button', { name: 'View in Queue' }));
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });
});

describe('Home screen loading and failures', () => {
    it('gives every card its own loading state', async () => {
        const slow = deferred<OverviewGetResult>();
        let mocks!: Mocks;

        await renderApp({}, (fake) => {
            mocks = stub(fake);
            mocks.overview.mockReturnValue(slow.promise);
        });

        // The overview is pending: its card loads, the others are already filled.
        expect(within(overviewCard()).getByRole('status')).toHaveAttribute('aria-busy', 'true');
        expect(await within(card('Recent videos')).findByText('Alpha')).toBeInTheDocument();
        expect(within(card('Needs your attention')).getByText('Broken one')).toBeInTheDocument();

        await act(async () => {
            slow.resolve({ ok: true, overview: OVERVIEW });
            await slow.promise;
        });

        expect(
            await screen.findByRole('button', { name: 'Ready: 85, open Library' }),
        ).toBeInTheDocument();
    });

    it('isolates a failing source: only its cards show the error with a Retry', async () => {
        let mocks!: Mocks;
        const { user } = await renderApp({}, (fake) => {
            mocks = stub(fake);
            mocks.overview.mockResolvedValueOnce({
                ok: false,
                error: 'Could not load the overview (HTTP 500).',
            });
        });

        await screen.findByText('Alpha');

        const videos = overviewCard();

        expect(await within(videos).findByRole('alert')).toHaveTextContent(
            'Could not load the overview (HTTP 500).',
        );
        // The other cards are untouched.
        expect(within(card('Recent videos')).getByText('Alpha')).toBeInTheDocument();
        expect(within(card('Needs your attention')).getByText('Broken one')).toBeInTheDocument();
        expect(within(card('Queue status')).getByText('0 running')).toBeInTheDocument();

        // Retry loads only the overview again.
        mocks.list.mockClear();
        mocks.logs.mockClear();
        await user.click(within(videos).getByRole('button', { name: 'Retry' }));

        expect(
            await screen.findByRole('button', { name: 'Ready: 85, open Library' }),
        ).toBeInTheDocument();
        expect(mocks.overview).toHaveBeenCalledTimes(2);
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.logs).not.toHaveBeenCalled();
    });

    it('shows a generic error when a call rejects and keeps the other cards', async () => {
        let mocks!: Mocks;

        await renderApp({}, (fake) => {
            mocks = stub(fake);
            mocks.list.mockRejectedValue(new Error('secret internal text'));
        });

        const recent = card('Recent videos');

        expect(await within(recent).findByRole('alert')).toHaveTextContent(
            'Something went wrong. Please try again.',
        );
        expect(screen.queryByText(/secret internal text/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Ready: 85, open Library' })).toBeInTheDocument();
        expect(within(card('Needs your attention')).getByText('Broken one')).toBeInTheDocument();
    });

    it('a failing logs source only affects the Needs attention card', async () => {
        const { user } = await renderApp({}, (fake) => {
            const mocks = stub(fake);

            mocks.logs.mockResolvedValueOnce({ ok: false, error: 'Could not load the logs.' });
        });
        const attention = card('Needs your attention');

        expect(await within(attention).findByRole('alert')).toHaveTextContent(
            'Could not load the logs.',
        );
        expect(screen.getByRole('button', { name: 'Ready: 85, open Library' })).toBeInTheDocument();

        await user.click(within(attention).getByRole('button', { name: 'Retry' }));
        expect(await within(attention).findByText('Broken one')).toBeInTheDocument();
    });

    it('Refresh loads all three sources again', async () => {
        const { user, mocks } = await openHome();

        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2));
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(mocks.logs).toHaveBeenCalledTimes(2);
        expect(
            await screen.findByRole('button', { name: 'Ready: 85, open Library' }),
        ).toBeInTheDocument();
    });

    it('refreshes quietly: data stays, the button spins, no placeholders, one request at a time', async () => {
        const slow = deferred<OverviewGetResult>();
        const { user, mocks } = await openHome();

        mocks.overview.mockReturnValueOnce(slow.promise);
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        const refresh = screen.getByRole('button', { name: 'Refresh' });

        expect(refresh).toHaveAttribute('aria-busy', 'true');
        expect(refresh).toHaveClass('is-spinning');
        // Old data stays on screen; no loading dash or status appears.
        expect(
            screen.getByRole('button', { name: 'Total videos: 100, open Library' }),
        ).toBeVisible();
        expect(within(card('Recent videos')).getByText('Alpha')).toBeInTheDocument();
        expect(overviewCard().querySelector('[aria-busy="true"]:not(.refresh-btn)')).toBeNull();
        expect(screen.queryByText('—')).toBeNull();

        // Clicks while busy are ignored.
        await user.click(refresh);
        expect(mocks.overview).toHaveBeenCalledTimes(2);
        expect(mocks.list).toHaveBeenCalledTimes(2);

        await act(async () => {
            slow.resolve({
                ok: true,
                overview: makeOverview({
                    videos: { total: 7, ready: 7, processing: 0, failed: 0 },
                }),
            });
            await slow.promise;
        });

        expect(
            await screen.findByRole('button', { name: 'Total videos: 7, open Library' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
            'aria-busy',
            'false',
        );
        expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveClass('is-spinning');
    });

    it('keeps the data and shows one error toast when a quiet refresh fails', async () => {
        const { user, mocks } = await openHome();

        mocks.overview.mockResolvedValueOnce({ ok: false, error: 'Overview is down.' });
        mocks.list.mockResolvedValueOnce({ ok: false, error: 'List is down.' });
        await user.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
                'aria-busy',
                'false',
            ),
        );

        expect(
            screen.getByRole('button', { name: 'Total videos: 100, open Library' }),
        ).toBeVisible();
        expect(within(card('Recent videos')).getByText('Alpha')).toBeInTheDocument();
        expect(within(card('Recent videos')).queryByRole('alert')).toBeNull();
        expect(overviewCard().querySelector('[role="alert"]')).toBeNull();
        expect(screen.getAllByText(/is down\./)).toHaveLength(1);
    });

    it('ignores answers that arrive after leaving the Home tab', async () => {
        const slow = deferred<VideosListResult>();
        const { user } = await renderApp({}, (fake) => {
            const mocks = stub(fake);

            mocks.list.mockReturnValue(slow.promise);
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await user.click(screen.getByRole('tab', { name: /^Queue/ }));
        await act(async () => {
            slow.resolve(listOf(VIDEOS));
            await slow.promise;
        });

        expect(errors).not.toHaveBeenCalled();
        expect(screen.queryByText('Alpha')).toBeNull();
    });
});

describe('Home screen auto refresh', () => {
    it('refreshes quietly when a job becomes done', async () => {
        const { fake, mocks } = await openHome();
        const job = makeJob({ id: 'j1', state: 'uploading' });

        // The first snapshot is only the baseline.
        push(() => fake.emitJobs([job]));
        expect(mocks.overview).toHaveBeenCalledTimes(1);

        mocks.overview.mockResolvedValue({
            ok: true,
            overview: makeOverview({
                videos: { total: 101, ready: 86, processing: 10, failed: 5 },
            }),
        });
        push(() => fake.emitJobs([{ ...job, state: 'done' }]));

        // No loading state: the old numbers stay until the new ones arrive.
        expect(screen.queryByText(/Loading/)).toBeNull();
        expect(
            await screen.findByRole('button', { name: 'Total videos: 101, open Library' }),
        ).toBeInTheDocument();
        expect(mocks.overview).toHaveBeenCalledTimes(2);
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(mocks.logs).toHaveBeenCalledTimes(2);
    });

    it('does not refresh for jobs that were already done or changed to another state', async () => {
        const { fake, mocks } = await openHome();
        const done = makeJob({ id: 'd', state: 'done' });

        push(() => fake.emitJobs([done]));
        push(() => fake.emitJobs([done, makeJob({ id: 'w', state: 'waiting' })]));
        push(() => fake.emitJobs([done, makeJob({ id: 'w', state: 'transcoding' })]));

        expect(mocks.overview).toHaveBeenCalledTimes(1);
    });

    it('keeps what is on screen when a quiet refresh fails', async () => {
        const { fake, mocks } = await openHome();
        const job = makeJob({ id: 'j1', state: 'uploading' });

        push(() => fake.emitJobs([job]));
        mocks.overview.mockResolvedValue({ ok: false, error: 'Could not load the overview.' });
        push(() => fake.emitJobs([{ ...job, state: 'done' }]));

        await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('button', { name: 'Ready: 85, open Library' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('Home bento dashboard', () => {
    it('shows one overview card with the greeting, the host and no illustration', async () => {
        await openHome();

        const hero = overviewCard();

        expect(hero).toHaveClass('card');
        expect(document.querySelector('.home-hero')).toBeNull();
        expect(document.querySelector('svg.home-hero-art')).toBeNull();

        expect(within(hero).getByRole('heading', { level: 2 })).toHaveTextContent(/alice/);
        expect(within(hero).queryByText(/Signed in/)).toBeNull();
        expect(within(hero).queryByText(/site\.example\.com/)).toBeNull();
    });

    it('has no quick-action tile row, only a Refresh control in the overview', async () => {
        await openHome();

        expect(screen.queryByRole('list', { name: 'Quick actions' })).toBeNull();
        expect(document.querySelector('.quick-tile')).toBeNull();

        const hero = overviewCard();
        const refresh = within(hero).getByRole('button', { name: 'Refresh' });

        expect(refresh.querySelector('svg.icon path')).not.toBeNull();
        expect(refresh).toHaveTextContent('');
        expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1);
    });

    it('opens the Queue from a status row', async () => {
        const { user } = await openHome({}, { jobs: [makeJob({ id: 'a', state: 'waiting' })] });

        await user.click(within(card('Queue status')).getByRole('button', { name: '1 waiting' }));
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('lists the local jobs that need attention and links to the Queue', async () => {
        await openHome(
            { failed: [] },
            { jobs: [makeJob({ id: 'a', fileName: 'stuck.mp4', state: 'needs_sign_in' })] },
        );

        const list = within(card('Needs your attention')).getByRole('list', {
            name: 'Local videos needing attention',
        });

        expect(within(list).getByText('stuck.mp4')).toBeInTheDocument();
        expect(within(list).getByText('Sign-in needed').closest('.chip')).not.toBeNull();
    });

    it('lists at most 3 local jobs that need attention, with one View in Queue button', async () => {
        const jobs = ['a', 'b', 'c', 'd'].map((id) =>
            makeJob({ id, fileName: `${id}.mp4`, state: 'needs_sign_in' }),
        );

        await openHome({ failed: [] }, { jobs });

        const attention = card('Needs your attention');
        const list = within(attention).getByRole('list', {
            name: 'Local videos needing attention',
        });

        expect(within(list).getAllByRole('listitem')).toHaveLength(3);
        expect(
            within(attention).getByText('4 local videos on this computer need attention.'),
        ).toBeInTheDocument();
        expect(within(attention).getAllByRole('button', { name: 'View in Queue' })).toHaveLength(1);
        expect(within(attention).queryByRole('button', { name: 'View logs' })).toBeNull();
    });

    it('says "All caught up" when nothing needs attention', async () => {
        await openHome({ failed: [] });

        const attention = card('Needs your attention');

        expect(within(attention).getByText('All caught up')).toBeVisible();
        expect(attention.querySelector('.empty-state')).not.toBeNull();
    });

    it('shows duration and size as colored chips and the date under the title, omitting missing values', async () => {
        await openHome({
            videos: [
                makeVideo({ id: 1, title: 'Alpha', duration: 75, sizeBytes: 5 * 1024 * 1024 }),
                makeVideo({
                    id: 2,
                    title: 'Beta',
                    status: 'processing',
                    duration: null,
                    sizeBytes: null,
                }),
            ],
        });

        const [first, second] = within(card('Recent videos')).getAllByRole('listitem');

        expect(within(first!).getByText('5.0 MB').closest('.spec')).toHaveClass('spec-size');
        expect(within(first!).getByText('1:15').closest('.spec')).toHaveClass('spec-duration');
        expect(first!.querySelector('time.recent-date')).toHaveAttribute(
            'datetime',
            '2026-01-01T10:00:00.000Z',
        );
        // Missing values: no chip and no dash.
        expect(second!.querySelector('.spec')).toBeNull();
        expect(within(second!).queryByText('\u2014')).toBeNull();
    });
});

describe('Home recent videos list', () => {
    it('uses one shared grid for the header and every row so the columns line up', async () => {
        await openHome();

        const table = card('Recent videos').querySelector('.recent-table') as HTMLElement;
        const head = table.querySelector('.recent-head') as HTMLElement;
        const rows = Array.from(table.querySelectorAll('li.recent-row'));

        expect(head).toHaveClass('recent-grid');
        expect(head).toHaveAttribute('aria-hidden', 'true');
        expect(rows.length).toBeGreaterThan(0);

        // Same number of cells in the header and in every row (one grid template for all).
        for (const row of rows) {
            expect(row).toHaveClass('recent-grid');
            expect(row.children).toHaveLength(head.children.length);
        }

        // No separate "Created" column any more: the date lives under the title.
        expect(within(head).queryByText('Created')).toBeNull();
        expect(head).toHaveTextContent('Title');
        expect(head).toHaveTextContent('Quality');
    });

    it('opens the video from the whole row, but not when a quick action is used', async () => {
        const { user } = await openHome();
        const recent = card('Recent videos');
        const row = within(recent).getAllByRole('listitem')[0]!;

        await user.click(within(row).getByRole('button', { name: /^Copy shortcode for/ }));
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');

        await user.click(row.querySelector('.recent-date') as HTMLElement);
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('shows a plain title button and a View all button with a chevron icon', async () => {
        await openHome();

        const recent = card('Recent videos');
        const title = within(recent).getByRole('button', { name: 'Alpha' });

        expect(title).toHaveClass('recent-title');
        expect(title.closest('.recent-text')?.querySelector('.recent-date')).not.toBeNull();
        expect(
            within(recent).getByRole('button', { name: 'View all' }).querySelector('svg.icon'),
        ).not.toBeNull();
    });
});

describe('Home statistics row', () => {
    it('sits inside the overview card, before the cards', async () => {
        await openHome();

        const hero = overviewCard();
        const stats = overviewCard();
        const recent = card('Recent videos');
        const before = (a: Node, b: Node) =>
            Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

        expect(stats).toBe(hero);
        expect(hero.querySelectorAll('.stat-tile')).toHaveLength(4);
        expect(before(stats, recent)).toBe(true);
        // No second "Videos" card at the bottom: the numbers appear once.
        expect(
            screen.getAllByRole('button', { name: 'Total videos: 100, open Library' }),
        ).toHaveLength(1);
    });

    it('shows four stat tiles with a tonal icon circle each and big numbers', async () => {
        await openHome();

        const tiles = within(overviewCard()).getAllByRole('listitem');

        expect(tiles).toHaveLength(4);
        expect(
            tiles.map((item) => item.querySelector('.stat-tile')?.className.split(' ')[1]),
        ).toEqual([
            'stat-tile-primary',
            'stat-tile-success',
            'stat-tile-warning',
            'stat-tile-danger',
        ]);

        for (const item of tiles)
            expect(item.querySelector('.stat-icon svg.icon path')).not.toBeNull();

        expect(within(tiles[0]!).getByText('100')).toHaveClass('stat-value');
        expect(within(tiles[0]!).getByText('Total videos')).toBeInTheDocument();
        // The "On server" caption above the strip tells it from the local queue counts.
        expect(within(tiles[2]!).getByText('Processing')).toHaveClass('stat-label');
        expect(within(tiles[2]!).getByRole('button')).toHaveAccessibleName(
            'Processing: 10, open Library',
        );
    });

    it('puts the actions in the overview header and wraps them with a shared hook', async () => {
        await openHome();

        const actions = overviewCard().querySelector('.home-actions') as HTMLElement;

        expect(within(actions).getByRole('button', { name: 'Upload videos' })).toBeInTheDocument();
        expect(within(actions).getByRole('button', { name: 'Open Library' })).toBeInTheDocument();
        expect(within(actions).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
        expect(overviewCard().querySelector('.stat-tiles')).not.toBeNull();
        expect(overviewCard().querySelector('.home-stats')).not.toBeNull();
    });

    it('shows dashes (not buttons) while loading', async () => {
        const gate = deferred<OverviewGetResult>();
        const rendered = await renderApp({}, (fake) => {
            stub(fake);
            fake.api.overview.get = vi.fn(() => gate.promise);
        });

        void rendered;

        const stats = overviewCard();

        expect(within(stats).getByRole('status')).toHaveAttribute('aria-busy', 'true');
        expect(within(stats).getAllByText('\u2014')).toHaveLength(4);
        expect(stats.querySelectorAll('button.stat-tile')).toHaveLength(0);

        await act(async () => gate.resolve({ ok: true, overview: OVERVIEW }));
        expect(
            await screen.findByRole('button', { name: 'Total videos: 100, open Library' }),
        ).toBeInTheDocument();
    });
});

describe('Home overview activity line', () => {
    it('shows the running count and the average percent while jobs run', async () => {
        await openHome(
            {},
            {
                jobs: [
                    makeJob({ id: 'a', state: 'uploading', progress: 20 }),
                    makeJob({ id: 'b', state: 'transcoding', progress: 60 }),
                    makeJob({ id: 'c', state: 'waiting', progress: 0 }),
                ],
            },
        );

        expect(screen.getByTestId('home-activity')).toHaveTextContent('2 uploading \u00b7 40%');
    });

    it('shows when the newest video was uploaded when nothing runs', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
        await openHome({
            videos: [
                makeVideo({ id: 1, title: 'Old', createdAt: '2025-12-30T12:00:00.000Z' }),
                makeVideo({ id: 2, title: 'New', createdAt: '2026-01-01T10:00:00.000Z' }),
            ],
        });

        const line = await screen.findByTestId('home-activity');

        expect(line).toHaveTextContent('Last upload 2 hours ago');
        expect(line.querySelector('time')).toHaveAttribute('datetime', '2026-01-01T10:00:00.000Z');
        expect(line.querySelector('time')).toHaveAttribute('title');
    });

    it('shows nothing when nothing runs and there are no videos', async () => {
        await openHome({ videos: [] });

        expect(screen.queryByTestId('home-activity')).toBeNull();
    });

    it('keeps the primary Upload videos, Open Library and Refresh controls', async () => {
        await openHome();

        const hero = overviewCard();

        expect(within(hero).getByRole('button', { name: 'Upload videos' })).toHaveClass(
            'btn-primary',
        );
        expect(within(hero).getByRole('button', { name: 'Open Library' })).toBeInTheDocument();
        // Same shared size class on both hero buttons so their heights always match.
        expect(within(hero).getByRole('button', { name: 'Upload videos' })).toHaveClass(
            'btn-control',
        );
        expect(within(hero).getByRole('button', { name: 'Open Library' })).toHaveClass(
            'btn-control',
        );
        expect(within(hero).getByRole('button', { name: 'Refresh' })).toHaveAttribute(
            'title',
            'Refresh',
        );
    });
});

describe('Home recent rows relative time', () => {
    it('shows the upload time as relative text with the full date-time as tooltip', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-02T10:00:00.000Z'));
        await openHome({
            videos: [makeVideo({ id: 1, title: 'Alpha', createdAt: '2026-01-01T10:00:00.000Z' })],
        });

        const row = within(card('Recent videos')).getAllByRole('listitem')[0]!;
        const time = row.querySelector('time.recent-date') as HTMLElement;

        expect(time).toHaveTextContent('yesterday');
        expect(time).toHaveAttribute('datetime', '2026-01-01T10:00:00.000Z');
        expect(time.getAttribute('title')).toMatch(/2026/);
    });

    it('omits the time when the upload time is unknown', async () => {
        await openHome({ videos: [makeVideo({ id: 1, title: 'Alpha', createdAt: null })] });

        expect(document.querySelector('.recent-row time')).toBeNull();
    });
});

describe('Home layout hooks', () => {
    it('keeps the overview card above one grid with the main and side columns', async () => {
        await openHome();

        const home = document.querySelector('.home') as HTMLElement;
        const grid = home.querySelector('.home-grid') as HTMLElement;

        expect(Array.from(home.children).map((child) => child.className.split(' ')[0])).toEqual([
            'card',
            'home-grid',
        ]);
        expect(grid.children[0]).toHaveClass('home-main');
        expect(grid.children[1]).toHaveClass('home-side');
        expect(within(grid.children[0] as HTMLElement).getByText('Recent videos')).toBeVisible();
        expect(within(grid.children[1] as HTMLElement).getByText('Queue status')).toBeVisible();
        expect(
            within(grid.children[1] as HTMLElement).getByText('Needs your attention'),
        ).toBeVisible();
    });
});

describe('createFakeApi defaults', () => {
    it('answers the overview and logs calls with empty data', async () => {
        const fake = createFakeApi();

        expect(await fake.api.overview.get()).toEqual({
            ok: true,
            overview: { videos: { total: 0, ready: 0, processing: 0, failed: 0 } },
        });
        expect(await fake.api.logs.get()).toMatchObject({ ok: true, view: 'summary' });
    });
});
