import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
    JobDto,
    LogCounts,
    LogItem,
    Overview,
    RendererApi,
    VideoListItem,
} from '../../../shared/ipc';
import { useNow } from '../components/JobRow';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { JobProgress } from '../components/JobProgress';
import { JobStateChip } from '../components/JobStateChip';
import { useToast } from '../state/Toasts';
import { RefreshButton } from '../components/RefreshButton';
import { StatTile, type StatTone } from '../components/StatTile';
import { StatusCountChips } from '../components/StatusCountChips';
import { Thumbnail } from '../components/Thumbnail';
import { TierChip } from '../components/TierChip';
import { UploadVideosButton } from '../components/UploadVideosButton';
import { VideoMenu } from '../components/VideoMenu';
import {
    ChevronRightIcon,
    ClockIcon,
    QualityIcon,
    StatFailedIcon,
    StatProcessingIcon,
    StatReadyIcon,
    StatTotalIcon,
    StorageIcon,
    SuccessIcon,
    VideoFileIcon,
} from '../components/icons';
import {
    VideoQuickActions,
    useQuickActions,
    type QuickAction,
} from '../components/VideoQuickActions';
import {
    formatBytes,
    formatDateTime,
    formatDuration,
    formatQuality,
    formatRelativeTime,
    plural,
    qualityTier,
    stageLabel,
} from '../lib/format';
import { needsAttention, queueGroup, sortJobsForQueue } from '../lib/queueOrder';
import { useApp } from '../state/AppProvider';
import { useNavigation, type Tab } from '../state/Navigation';
import { useJobFinished } from '../state/useJobFinished';
import { StatusBadge } from './videoStatus';

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const RECENT_COUNT = 8;
const ATTENTION_COUNT = 5;
/** Local jobs listed in "Needs your attention" and the running ones under the queue chips. */
const LOCAL_ATTENTION_COUNT = 3;
const RUNNING_SHOWN = 2;

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
    return (
        <SectionCard title={title} level={3} action={action} className="home-card">
            {children}
        </SectionCard>
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

interface StatSpec {
    key: 'total' | 'ready' | 'processing' | 'failed';
    /** Visible caption and the start of the accessible name. */
    label: string;
    tone: StatTone;
    icon: ReactNode;
    /** Where the card leads. */
    to: Tab;
    toLabel: string;
}

const STATS: readonly StatSpec[] = [
    {
        key: 'total',
        label: 'Total videos',
        tone: 'primary',
        icon: <StatTotalIcon />,
        to: 'library',
        toLabel: 'Library',
    },
    {
        key: 'ready',
        label: 'Ready',
        tone: 'success',
        icon: <StatReadyIcon />,
        to: 'library',
        toLabel: 'Library',
    },
    {
        key: 'processing',
        label: 'Processing',
        tone: 'warning',
        icon: <StatProcessingIcon />,
        to: 'library',
        toLabel: 'Library',
    },
    {
        key: 'failed',
        label: 'Failed',
        tone: 'danger',
        icon: <StatFailedIcon />,
        to: 'library',
        toLabel: 'Library',
    },
];

/**
 * Live line under the greeting: the running jobs with their average percent, else when the newest
 * recent video was uploaded, else nothing.
 */
function activityLine(
    running: readonly JobDto[],
    newestUpload: string | null,
    now: number,
): ReactNode {
    if (running.length > 0) {
        const percent = Math.round(
            running.reduce((sum, job) => sum + job.progress, 0) / running.length,
        );

        return `${running.length} uploading \u00b7 ${percent}%`;
    }

    if (newestUpload === null) return null;

    const relative = formatRelativeTime(newestUpload, now);

    if (relative === '') return null;

    return (
        <>
            {'Last upload '}
            <time dateTime={newestUpload} title={formatDateTime(newestUpload)}>
                {relative}
            </time>
        </>
    );
}

function eventTime(item: LogItem): string | null {
    return item.failedAt ?? item.updatedAt ?? item.createdAt;
}

export function HomeScreen() {
    const { api, auth, jobs, summary } = useApp();
    const { openTab, openLibraryVideo } = useNavigation();
    const quick = useQuickActions();
    const now = useNow();
    const toast = useToast();
    const [overview, setOverview] = useState<Card<Overview>>(LOADING);
    const [recent, setRecent] = useState<Card<VideoListItem[]>>(LOADING);
    const [logs, setLogs] = useState<Card<LogsSlice>>(LOADING);
    // The newest request of each card wins: answers of older ones (and of an unmounted screen)
    // are ignored.
    const latest = useRef({ overview: 0, recent: 0, logs: 0 });

    const load = useCallback(
        (
            which: { overview?: boolean; recent?: boolean; logs?: boolean },
            silent: boolean,
        ): Promise<string | null> => {
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
            ): Promise<string | null> {
                return request
                    .catch((): Outcome<T> => ({ ok: false, error: GENERIC_ERROR }))
                    .then((outcome) => {
                        if (token[key] !== latest.current[key]) return null;

                        if (outcome.ok) {
                            set({ kind: 'ready', value: outcome.value });

                            return null;
                        }

                        // A failed quiet refresh keeps what is on screen (the caller reports it).
                        if (!silent) set({ kind: 'error', message: outcome.error });

                        return outcome.error;
                    });
            }

            return Promise.all([
                which.overview === true
                    ? settle('overview', fetchOverview(api), setOverview)
                    : null,
                which.recent === true ? settle('recent', fetchRecent(api), setRecent) : null,
                which.logs === true ? settle('logs', fetchLogs(api), setLogs) : null,
            ]).then((errors) => errors.find((error) => error !== null) ?? null);
        },
        [api],
    );

    const loadAll = useCallback(
        (silent: boolean) => load({ overview: true, recent: true, logs: true }, silent),
        [load],
    );

    // Explicit Refresh: quiet (stale-while-revalidate). The data stays, only the button spins;
    // clicks while busy are ignored and a failure shows one error toast.
    const [refreshing, setRefreshing] = useState(false);
    const refreshBusy = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    const refresh = useCallback(() => {
        if (refreshBusy.current) return;

        refreshBusy.current = true;
        setRefreshing(true);
        void loadAll(true).then((error) => {
            refreshBusy.current = false;

            if (!mounted.current) return;

            setRefreshing(false);

            if (error !== null) toast.show('error', error);
        });
    }, [loadAll, toast]);

    useEffect(() => {
        const counters = latest.current;

        void loadAll(false);

        return () => {
            counters.overview += 1;
            counters.recent += 1;
            counters.logs += 1;
        };
    }, [loadAll]);

    // A finished upload adds a video: refresh quietly (no loading states).
    useJobFinished(() => void loadAll(true));

    const greeting = greetingFor(new Date().getHours());
    const runningJobs = sortJobsForQueue(jobs).filter((job) => queueGroup(job.state) === 1);
    const attention = jobs.filter((job) => needsAttention(job.state)).length;
    const newestUpload =
        recent.kind === 'ready'
            ? (recent.value
                  .map((video) => video.createdAt)
                  .filter((value): value is string => value !== null && value !== '')
                  .sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null)
            : null;
    const activity = activityLine(runningJobs, newestUpload, now);

    const statsId = useId();
    const retryOverview = () => load({ overview: true }, false);

    return (
        <section className="home" aria-labelledby="home-heading">
            <SectionCard
                title={
                    auth.username === undefined ? (
                        greeting
                    ) : (
                        <>
                            {greeting}, <span className="greeting-name">{auth.username}</span>
                        </>
                    )
                }
                size="lg"
                className="home-overview"
                description={
                    <>
                        {activity !== null && (
                            <p className="home-overview-activity" data-testid="home-activity">
                                {activity}
                            </p>
                        )}
                    </>
                }
                action={
                    <div className="home-actions">
                        <UploadVideosButton variant="primary" />
                        <button
                            type="button"
                            className="btn btn-control"
                            onClick={() => openTab('library')}
                        >
                            Open Library
                        </button>
                        <RefreshButton size="control" busy={refreshing} onClick={refresh} />
                    </div>
                }
            >
                <div className="home-stats">
                    <p id={statsId} className="home-caption">
                        On server
                    </p>
                    {overview.kind === 'error' ? (
                        <div className="home-error">
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
                            <ul className="stat-tiles" aria-labelledby={statsId}>
                                {STATS.map((stat) => {
                                    const value =
                                        overview.kind === 'ready'
                                            ? overview.value.videos[stat.key]
                                            : null;

                                    return (
                                        <li key={stat.key}>
                                            <StatTile
                                                className={`stat-${stat.key}`}
                                                icon={stat.icon}
                                                value={value}
                                                label={stat.label}
                                                tone={stat.tone}
                                                alert={
                                                    stat.key === 'failed' &&
                                                    value !== null &&
                                                    value > 0
                                                }
                                                actionLabel={`open ${stat.toLabel}`}
                                                onClick={() => openTab(stat.to)}
                                            />
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                </div>
            </SectionCard>

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
                                    <EmptyState
                                        compact
                                        icon={<VideoFileIcon />}
                                        title="No videos yet"
                                    />
                                ) : (
                                    <div className="recent-table">
                                        <div className="recent-grid recent-head" aria-hidden="true">
                                            <span />
                                            <span>Title</span>
                                            <span className="recent-center">Quality</span>
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
                                                    now={now}
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
                        <p className="home-caption">This device</p>
                        <StatusCountChips counts={summary} onSelect={() => openTab('queue')} />
                        {runningJobs.length > 0 && (
                            <ul className="home-running" aria-label="Running uploads">
                                {runningJobs.slice(0, RUNNING_SHOWN).map((job) => (
                                    <li key={job.id} className="home-running-row">
                                        <span className="home-running-name" title={job.fileName}>
                                            {job.fileName}
                                        </span>
                                        <JobProgress
                                            fileName={job.fileName}
                                            progress={job.progress}
                                        />
                                        <span className="muted small">
                                            {job.waitingForNetwork
                                                ? 'Waiting for network…'
                                                : stageLabel(job.state)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardShell>

                    <CardShell title="Needs your attention">
                        <CardBody state={logs} onRetry={() => load({ logs: true }, false)}>
                            {(slice) => {
                                const failed = slice.errors.slice(0, ATTENTION_COUNT);
                                const local = jobs
                                    .filter((job) => needsAttention(job.state))
                                    .slice(0, LOCAL_ATTENTION_COUNT);

                                if (failed.length === 0 && attention === 0) {
                                    return (
                                        <EmptyState
                                            compact
                                            icon={<SuccessIcon />}
                                            title="All caught up"
                                            description="Nothing needs attention."
                                        />
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
                                                            <JobStateChip job={job} />
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

function RecentRow({
    video,
    now,
    busy,
    onOpen,
    onQuick,
}: {
    video: VideoListItem;
    now: number;
    busy: boolean;
    onOpen: () => void;
    onQuick: (action: QuickAction) => void;
}) {
    const duration = formatDuration(video.duration);
    const ready = video.status === 'ready';
    const quality = formatQuality(video.width, video.height);
    const tier = qualityTier(video.width, video.height);
    const relative = video.createdAt === null ? '' : formatRelativeTime(video.createdAt, now);

    return (
        // The whole row opens the video; the title is the keyboard-reachable button and the
        // quick actions keep their own behavior.
        <li
            className="recent-grid recent-row row-surface"
            onClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) onOpen();
            }}
        >
            <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />
            <div className="recent-text">
                <button type="button" className="recent-title" title={video.title} onClick={onOpen}>
                    {video.title}
                </button>
                {video.createdAt !== null && relative !== '' && (
                    <time
                        className="recent-date"
                        dateTime={video.createdAt}
                        title={formatDateTime(video.createdAt)}
                    >
                        {relative}
                    </time>
                )}
            </div>
            {/* The quality chip; a video that is not ready shows its status in its place. */}
            <span className="recent-cell recent-status">
                {!ready ? (
                    <StatusBadge status={video.status} />
                ) : (
                    quality !== '' &&
                    tier !== null && (
                        <TierChip
                            label={quality}
                            tier={tier}
                            title="Quality"
                            icon={<QualityIcon />}
                        />
                    )
                )}
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
            <VideoQuickActions
                variant="ghost"
                title={video.title}
                busy={busy}
                actions={[
                    ...(ready ? (['shortcode'] as const) : []),
                    ...(video.thumbnailUrl !== null ? (['thumbnail-url'] as const) : []),
                ]}
                onQuick={onQuick}
                menu={
                    <VideoMenu
                        title={video.title}
                        busy={busy}
                        ready={ready}
                        onQuick={onQuick}
                        onOpen={onOpen}
                    />
                }
            />
        </li>
    );
}
