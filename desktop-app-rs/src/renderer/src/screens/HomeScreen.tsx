import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { LogCounts, LogItem, Overview, RendererApi, VideoListItem } from '../../../shared/ipc';
import { useNow } from '../components/JobRow';
import { Thumbnail } from '../components/Thumbnail';
import { useAddFiles } from '../components/useAddFiles';
import { QuickActionButtons, useQuickActions } from '../components/VideoQuickActions';
import {
    formatDateTime,
    formatDuration,
    formatRelativeTime,
    plural,
    siteHost,
} from '../lib/format';
import { queueGroup } from '../lib/queueOrder';
import { useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { useJobFinished } from '../state/useJobFinished';
import { StatusBadge } from './videoStatus';

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const RECENT_COUNT = 5;
const ATTENTION_COUNT = 5;

/** Local-time greeting: before 12:00 morning, before 18:00 afternoon, otherwise evening. */
export function greetingFor(hour: number): string {
    if (hour < 12) return 'Good morning';

    return hour < 18 ? 'Good afternoon' : 'Good evening';
}

type Card<T> =
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T };

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

interface LogsSlice {
    counts: LogCounts;
    errors: LogItem[];
}

async function fetchOverview(api: RendererApi): Promise<Outcome<Overview>> {
    const result = await api.overview.get();

    return result.ok ? { ok: true, value: result.overview } : { ok: false, error: result.error };
}

async function fetchRecent(api: RendererApi): Promise<Outcome<VideoListItem[]>> {
    const result = await api.videos.list({ page: 1, perPage: RECENT_COUNT });

    return result.ok ? { ok: true, value: result.data } : { ok: false, error: result.error };
}

async function fetchLogs(api: RendererApi): Promise<Outcome<LogsSlice>> {
    const result = await api.logs.get();

    if (!result.ok) return { ok: false, error: result.error };

    // Without a type the summary comes back; anything else is not usable here.
    if (result.view !== 'summary') return { ok: false, error: GENERIC_ERROR };

    return { ok: true, value: { counts: result.counts, errors: result.error } };
}

const LOADING = { kind: 'loading' } as const;

function CardShell({
    title,
    action,
    wide = false,
    children,
}: {
    title: string;
    action?: ReactNode;
    wide?: boolean;
    children: ReactNode;
}) {
    const id = useId();

    return (
        <section
            className={wide ? 'card home-card home-card-wide' : 'card home-card'}
            aria-labelledby={id}
        >
            <div className="home-card-head">
                <h3 id={id}>{title}</h3>
                {action}
            </div>
            {children}
        </section>
    );
}

/** Per-card loading and error state; `children` renders the loaded value. */
function CardBody<T>({
    state,
    onRetry,
    children,
}: {
    state: Card<T>;
    onRetry: () => void;
    children: (value: T) => ReactNode;
}) {
    if (state.kind === 'loading') {
        return (
            <p className="muted" role="status" aria-busy="true">
                {'Loading…'}
            </p>
        );
    }

    if (state.kind === 'error') {
        return (
            <div className="home-error">
                <p role="alert">{state.message}</p>
                <button type="button" className="btn btn-sm" onClick={onRetry}>
                    Retry
                </button>
            </div>
        );
    }

    return <>{children(state.value)}</>;
}

const TILES = [
    { key: 'total', label: 'Total' },
    { key: 'ready', label: 'Ready' },
    { key: 'processing', label: 'Processing on server' },
    { key: 'failed', label: 'Failed' },
] as const;

function eventTime(item: LogItem): string | null {
    return item.failedAt ?? item.updatedAt ?? item.createdAt;
}

export function HomeScreen() {
    const { api, auth, settings, jobs } = useApp();
    const { openTab, openLibraryVideo } = useNavigation();
    const { busy: adding, add } = useAddFiles();
    const quick = useQuickActions();
    const now = useNow();
    const [overview, setOverview] = useState<Card<Overview>>(LOADING);
    const [recent, setRecent] = useState<Card<VideoListItem[]>>(LOADING);
    const [logs, setLogs] = useState<Card<LogsSlice>>(LOADING);
    // The newest request of each card wins: answers of older ones (and of an unmounted screen)
    // are ignored.
    const latest = useRef({ overview: 0, recent: 0, logs: 0 });

    const load = useCallback(
        (which: { overview?: boolean; recent?: boolean; logs?: boolean }, silent: boolean) => {
            const token = {
                overview: which.overview === true ? ++latest.current.overview : 0,
                recent: which.recent === true ? ++latest.current.recent : 0,
                logs: which.logs === true ? ++latest.current.logs : 0,
            };

            if (!silent) {
                if (which.overview === true) setOverview(LOADING);

                if (which.recent === true) setRecent(LOADING);

                if (which.logs === true) setLogs(LOADING);
            }

            // Each card is filled as soon as its own answer arrives (a slow source never holds
            // the others back); `allSettled` only joins them.
            function settle<T>(
                key: 'overview' | 'recent' | 'logs',
                request: Promise<Outcome<T>>,
                set: (card: Card<T>) => void,
            ): Promise<void> {
                return request
                    .catch((): Outcome<T> => ({ ok: false, error: GENERIC_ERROR }))
                    .then((outcome) => {
                        if (token[key] !== latest.current[key]) return;

                        if (outcome.ok) set({ kind: 'ready', value: outcome.value });
                        // A failed quiet refresh keeps what is on screen.
                        else if (!silent) set({ kind: 'error', message: outcome.error });
                    });
            }

            void Promise.allSettled([
                which.overview === true
                    ? settle('overview', fetchOverview(api), setOverview)
                    : undefined,
                which.recent === true ? settle('recent', fetchRecent(api), setRecent) : undefined,
                which.logs === true ? settle('logs', fetchLogs(api), setLogs) : undefined,
            ]);
        },
        [api],
    );

    const loadAll = useCallback(
        (silent: boolean) => load({ overview: true, recent: true, logs: true }, silent),
        [load],
    );

    useEffect(() => {
        const counters = latest.current;

        loadAll(false);

        return () => {
            counters.overview += 1;
            counters.recent += 1;
            counters.logs += 1;
        };
    }, [loadAll]);

    // A finished upload adds a video: refresh quietly (no loading states).
    useJobFinished(() => loadAll(true));

    const host = siteHost(auth.siteUrl ?? settings?.siteUrl);
    const greeting = greetingFor(new Date().getHours());
    const running = jobs.filter((job) => queueGroup(job.state) === 1).length;
    const waiting = jobs.filter((job) => queueGroup(job.state) === 3).length;
    const attention = jobs.filter((job) => queueGroup(job.state) === 2).length;
    const done = jobs.filter((job) => job.state === 'done').length;

    async function addVideos(): Promise<void> {
        const result = await add(() => api.jobs.addFiles());

        if (result !== null && result.added > 0) openTab('queue');
    }

    const retryOverview = () => load({ overview: true }, false);

    return (
        <section className="home" aria-labelledby="home-heading">
            <div className="home-head">
                <div className="home-greeting">
                    <h2 id="home-heading">
                        {auth.username === undefined ? greeting : `${greeting}, ${auth.username}`}
                    </h2>
                    <p className="muted">{host === '' ? 'Signed in' : `${host} · Signed in`}</p>
                </div>
                <div className="row">
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={adding}
                        onClick={() => void addVideos()}
                    >
                        Upload videos
                    </button>
                    <button type="button" className="btn" onClick={() => openTab('library')}>
                        Open Library
                    </button>
                    <button type="button" className="btn" onClick={() => loadAll(false)}>
                        Refresh
                    </button>
                </div>
            </div>

            <div className="home-grid">
                <CardShell title="Videos" wide>
                    <CardBody state={overview} onRetry={retryOverview}>
                        {(value) => (
                            <ul className="tiles">
                                {TILES.map((tile) => (
                                    <li key={tile.key}>
                                        <button
                                            type="button"
                                            className={`tile tile-${tile.key}`}
                                            aria-label={`${tile.label}: ${value.videos[tile.key]}`}
                                            onClick={() => openTab('library')}
                                        >
                                            <span className="tile-value num">
                                                {value.videos[tile.key]}
                                            </span>
                                            <span className="tile-label">{tile.label}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </CardShell>

                <CardShell
                    title="This computer"
                    wide
                    action={
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => openTab('queue')}
                        >
                            Go to Queue
                        </button>
                    }
                >
                    <dl className="stats">
                        <div>
                            <dt>Running</dt>
                            <dd className="num">{running}</dd>
                        </div>
                        <div>
                            <dt>Waiting</dt>
                            <dd className="num">{waiting}</dd>
                        </div>
                        <div>
                            <dt>Needs attention</dt>
                            <dd className="num">{attention}</dd>
                        </div>
                        <div>
                            <dt>Done</dt>
                            <dd className="num">{done}</dd>
                        </div>
                    </dl>
                </CardShell>

                <CardShell
                    title="Recent videos"
                    action={
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => openTab('library')}
                        >
                            View all
                        </button>
                    }
                >
                    <CardBody state={recent} onRetry={() => load({ recent: true }, false)}>
                        {(items) =>
                            items.length === 0 ? (
                                <p className="muted">No videos yet</p>
                            ) : (
                                <ul className="recent" aria-label="Recent videos">
                                    {items.map((video) => (
                                        <li key={video.id} className="recent-row">
                                            <Thumbnail
                                                key={video.thumbnailUrl ?? ''}
                                                url={video.thumbnailUrl}
                                            />
                                            <button
                                                type="button"
                                                className="recent-title"
                                                title={video.title}
                                                onClick={() => openLibraryVideo(video.id)}
                                            >
                                                {video.title}
                                            </button>
                                            <StatusBadge status={video.status} />
                                            <span className="recent-duration num muted small">
                                                {formatDuration(video.duration)}
                                            </span>
                                            {video.status === 'ready' && (
                                                <QuickActionButtons
                                                    title={video.title}
                                                    busy={quick.busyIds.has(video.id)}
                                                    onQuick={(action) =>
                                                        quick.run(video.id, action)
                                                    }
                                                />
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )
                        }
                    </CardBody>
                </CardShell>

                <CardShell
                    title="Needs attention"
                    action={
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => openTab('logs')}
                        >
                            View logs
                        </button>
                    }
                >
                    <CardBody state={logs} onRetry={() => load({ logs: true }, false)}>
                        {(slice) => {
                            const failed = slice.errors.slice(0, ATTENTION_COUNT);

                            if (failed.length === 0 && attention === 0) {
                                return <p className="muted">Nothing needs attention.</p>;
                            }

                            return (
                                <>
                                    {failed.length > 0 && (
                                        <ul className="attention" aria-label="Failed videos">
                                            {failed.map((item) => {
                                                const time = eventTime(item);

                                                return (
                                                    <li key={item.id} className="attention-row">
                                                        <button
                                                            type="button"
                                                            className="attention-title"
                                                            title={item.title}
                                                            onClick={() =>
                                                                openLibraryVideo(item.id)
                                                            }
                                                        >
                                                            {item.title}
                                                        </button>
                                                        {item.errorMessage !== null && (
                                                            <span className="attention-message small">
                                                                {item.errorMessage}
                                                            </span>
                                                        )}
                                                        {time !== null && (
                                                            <time
                                                                className="muted small"
                                                                dateTime={time}
                                                                title={formatDateTime(time)}
                                                            >
                                                                {formatRelativeTime(time, now)}
                                                            </time>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                    {attention > 0 && (
                                        <p className="attention-local">
                                            <span>
                                                {plural(attention, 'local video')} on this computer{' '}
                                                {attention === 1 ? 'needs' : 'need'} attention.
                                            </span>
                                            <button
                                                type="button"
                                                className="btn btn-sm"
                                                onClick={() => openTab('queue')}
                                            >
                                                View in Queue
                                            </button>
                                        </p>
                                    )}
                                </>
                            );
                        }}
                    </CardBody>
                </CardShell>
            </div>
        </section>
    );
}
