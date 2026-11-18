import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { LogCounts, LogItem, Overview, RendererApi, VideoListItem } from '../../../shared/ipc';
import { useNow } from '../components/JobRow';
import { Thumbnail } from '../components/Thumbnail';
import { useAddFiles } from '../components/useAddFiles';
import {
    ChevronRightIcon,
    ClockIcon,
    ErrorIcon,
    LibraryIcon,
    RefreshIcon,
    StorageIcon,
    SuccessIcon,
} from '../components/icons';
import {
    QuickActionButtons,
    useQuickActions,
    type QuickAction,
} from '../components/VideoQuickActions';
import {
    formatBytes,
    formatDate,
    formatDateTime,
    formatDuration,
    formatRelativeTime,
    plural,
    siteHost,
    stageLabel,
} from '../lib/format';
import { needsAttention, queueGroup } from '../lib/queueOrder';
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
    children,
}: {
    title: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    const id = useId();

    return (
        <section className="card home-card" aria-labelledby={id}>
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

const STATS = [
    { key: 'total', label: 'Total', caption: 'Total videos', color: 'blue', icon: <LibraryIcon /> },
    { key: 'ready', label: 'Ready', caption: 'Ready', color: 'green', icon: <SuccessIcon /> },
    {
        key: 'processing',
        label: 'Processing on server',
        caption: 'Processing',
        sub: 'on server',
        color: 'amber',
        icon: <ClockIcon />,
    },
    { key: 'failed', label: 'Failed', caption: 'Failed', color: 'red', icon: <ErrorIcon /> },
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
    const attention = jobs.filter((job) => needsAttention(job.state)).length;
    const done = jobs.filter((job) => job.state === 'done').length;

    async function addVideos(): Promise<void> {
        const result = await add(() => api.jobs.addFiles());

        if (result !== null && result.added > 0) openTab('queue');
    }

    const statsId = useId();
    const retryOverview = () => load({ overview: true }, false);

    return (
        <section className="home" aria-labelledby="home-heading">
            <div className="home-hero card">
                <button
                    type="button"
                    className="btn btn-sm btn-text home-refresh"
                    aria-label="Refresh"
                    title="Refresh"
                    onClick={() => loadAll(false)}
                >
                    <RefreshIcon />
                </button>
                <div className="home-hero-text">
                    <h2 id="home-heading">
                        {auth.username === undefined ? greeting : `${greeting}, ${auth.username}`}
                    </h2>
                    <p className="home-hero-sub">
                        {host === '' ? 'Signed in' : `${host} · Signed in`}
                    </p>
                    <div className="row home-hero-actions">
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
                    </div>
                </div>
                <HeroArt />
            </div>

            <section className="home-stats" aria-labelledby={statsId}>
                <h3 id={statsId} className="visually-hidden">
                    Videos
                </h3>
                {overview.kind === 'error' ? (
                    <div className="card home-error">
                        <p role="alert">{overview.message}</p>
                        <button type="button" className="btn btn-sm" onClick={retryOverview}>
                            Retry
                        </button>
                    </div>
                ) : (
                    <>
                        {overview.kind === 'loading' && (
                            <p className="visually-hidden" role="status" aria-busy="true">
                                {'Loading…'}
                            </p>
                        )}
                        <ul className="stat-cards">
                            {STATS.map((stat) => {
                                const body = (
                                    <>
                                        <span className={`icon-tile icon-tile-${stat.color}`}>
                                            {stat.icon}
                                        </span>
                                        <span className="stat-text">
                                            <span className="stat-value num">
                                                {overview.kind === 'ready'
                                                    ? overview.value.videos[stat.key]
                                                    : '\u2014'}
                                            </span>
                                            <span className="stat-label">{stat.caption}</span>
                                            {'sub' in stat && (
                                                <span className="stat-sub">{stat.sub}</span>
                                            )}
                                        </span>
                                    </>
                                );

                                return (
                                    <li key={stat.key}>
                                        {overview.kind === 'ready' ? (
                                            <button
                                                type="button"
                                                className={`stat-card stat-${stat.key}`}
                                                aria-label={`${stat.label}: ${overview.value.videos[stat.key]}`}
                                                onClick={() => openTab('library')}
                                            >
                                                {body}
                                            </button>
                                        ) : (
                                            <div className={`stat-card stat-${stat.key}`}>
                                                {body}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </section>

            <div className="home-grid">
                <div className="home-main">
                    <CardShell
                        title="Recent videos"
                        action={
                            <button
                                type="button"
                                className="btn btn-sm btn-text"
                                onClick={() => openTab('library')}
                            >
                                View all
                                <ChevronRightIcon />
                            </button>
                        }
                    >
                        <CardBody state={recent} onRetry={() => load({ recent: true }, false)}>
                            {(items) =>
                                items.length === 0 ? (
                                    <p className="muted">No videos yet</p>
                                ) : (
                                    <div className="recent-table">
                                        <div className="recent-grid recent-head" aria-hidden="true">
                                            <span />
                                            <span>Title</span>
                                            <span className="recent-center">Status</span>
                                            <span className="recent-center recent-col-duration">
                                                Duration
                                            </span>
                                            <span className="recent-center recent-col-size">
                                                Size
                                            </span>
                                            <span />
                                        </div>
                                        <ul className="recent" aria-label="Recent videos">
                                            {items.map((video) => (
                                                <RecentRow
                                                    key={video.id}
                                                    video={video}
                                                    busy={quick.busyIds.has(video.id)}
                                                    onOpen={() => openLibraryVideo(video.id)}
                                                    onQuick={(action) =>
                                                        quick.run(video.id, action)
                                                    }
                                                />
                                            ))}
                                        </ul>
                                    </div>
                                )
                            }
                        </CardBody>
                    </CardShell>
                </div>

                <div className="home-side">
                    <CardShell
                        title="Queue status"
                        action={
                            <button
                                type="button"
                                className="btn btn-sm btn-text"
                                onClick={() => openTab('queue')}
                            >
                                Go to Queue
                            </button>
                        }
                    >
                        <dl className="stat-rows">
                            {(
                                [
                                    ['Running', running, 'blue'],
                                    ['Waiting', waiting, 'amber'],
                                    ['Needs attention', attention, 'red'],
                                    ['Done', done, 'green'],
                                ] as const
                            ).map(([label, count, color]) => (
                                <div key={label} className={`stat-row tint-${color}`}>
                                    <dt>
                                        <button
                                            type="button"
                                            className="stat-link"
                                            onClick={() => openTab('queue')}
                                        >
                                            {label}
                                        </button>
                                    </dt>
                                    <dd className="num">{count}</dd>
                                </div>
                            ))}
                        </dl>
                    </CardShell>

                    <CardShell
                        title="Needs your attention"
                        action={
                            <button
                                type="button"
                                className="btn btn-sm btn-text"
                                onClick={() => openTab('logs')}
                            >
                                View logs
                            </button>
                        }
                    >
                        <CardBody state={logs} onRetry={() => load({ logs: true }, false)}>
                            {(slice) => {
                                const failed = slice.errors.slice(0, ATTENTION_COUNT);
                                const local = jobs
                                    .filter((job) => needsAttention(job.state))
                                    .slice(0, ATTENTION_COUNT);

                                if (failed.length === 0 && attention === 0) {
                                    return (
                                        <div className="all-clear">
                                            <p className="all-clear-title">All caught up</p>
                                            <p className="muted">Nothing needs attention.</p>
                                        </div>
                                    );
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
                                            <>
                                                <ul
                                                    className="attention"
                                                    aria-label="Local videos needing attention"
                                                >
                                                    {local.map((job) => (
                                                        <li key={job.id} className="attention-row">
                                                            <span
                                                                className="attention-file"
                                                                title={job.fileName}
                                                            >
                                                                {job.fileName}
                                                            </span>
                                                            <span className="muted small">
                                                                {stageLabel(job.state)}
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ul>
                                                <p className="attention-local">
                                                    <span>
                                                        {plural(attention, 'local video')} on this
                                                        computer{' '}
                                                        {attention === 1 ? 'needs' : 'need'}{' '}
                                                        attention.
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="btn btn-sm"
                                                        onClick={() => openTab('queue')}
                                                    >
                                                        View in Queue
                                                    </button>
                                                </p>
                                            </>
                                        )}
                                    </>
                                );
                            }}
                        </CardBody>
                    </CardShell>
                </div>
            </div>
        </section>
    );
}

/** Decorative inline illustration of the hero card (cloud, video and document shapes). */
function HeroArt() {
    return (
        <svg className="home-hero-art" viewBox="0 0 220 140" aria-hidden="true" focusable="false">
            <rect x="52" y="22" width="112" height="84" rx="12" className="art-card" />
            <rect x="64" y="34" width="60" height="8" rx="4" className="art-line" />
            <rect x="64" y="50" width="88" height="6" rx="3" className="art-line-soft" />
            <rect x="64" y="62" width="76" height="6" rx="3" className="art-line-soft" />
            <rect x="64" y="78" width="40" height="18" rx="6" className="art-accent" />
            <path d="M80 82.5v9l8-4.5z" className="art-play" />
            <path
                d="M150 118h-60a22 22 0 0 1-3-43.8A28 28 0 0 1 140 66a20 20 0 0 1 10 52z"
                className="art-cloud"
            />
            <path
                d="M118 108V88m0 0-8 8m8-8 8 8"
                className="art-arrow"
                fill="none"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="184" cy="36" r="8" className="art-dot-a" />
            <circle cx="36" cy="92" r="6" className="art-dot-b" />
        </svg>
    );
}

function RecentRow({
    video,
    busy,
    onOpen,
    onQuick,
}: {
    video: VideoListItem;
    busy: boolean;
    onOpen: () => void;
    onQuick: (action: QuickAction) => void;
}) {
    const duration = formatDuration(video.duration);
    const added = formatDate(video.createdAt);

    return (
        // The whole row opens the video; the title is the keyboard-reachable button and the
        // quick actions keep their own behavior.
        <li
            className="recent-grid recent-row"
            onClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) onOpen();
            }}
        >
            <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />
            <div className="recent-text">
                <button type="button" className="recent-title" title={video.title} onClick={onOpen}>
                    {video.title}
                </button>
                {added !== '' && <span className="recent-date">{added}</span>}
            </div>
            <span className="recent-cell recent-status">
                <StatusBadge status={video.status} />
            </span>
            <span className="recent-cell recent-col-duration">
                {duration !== '' && (
                    <span className="spec spec-duration num" title="Duration">
                        <ClockIcon />
                        {duration}
                    </span>
                )}
            </span>
            <span className="recent-cell recent-col-size">
                {video.sizeBytes !== null && (
                    <span className="spec spec-size num" title="File size">
                        <StorageIcon />
                        {formatBytes(video.sizeBytes)}
                    </span>
                )}
            </span>
            {video.status === 'ready' ? (
                <QuickActionButtons
                    variant="ghost"
                    title={video.title}
                    busy={busy}
                    onQuick={onQuick}
                />
            ) : (
                <span />
            )}
        </li>
    );
}
