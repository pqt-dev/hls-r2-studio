import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { LogCounts, LogItem, LogType, VideoListMeta } from '../../../shared/ipc';
import { EmptyState } from '../components/EmptyState';
import {
    InfoIcon,
    LibraryIcon,
    LogsIcon,
    StatFailedIcon,
    StatProcessingIcon,
    StatReadyIcon,
    StatTotalIcon,
} from '../components/icons';
import { JobProgress } from '../components/JobProgress';
import { useNow } from '../components/JobRow';
import { Pagination } from '../components/Pagination';
import { PerPageSelect } from '../components/PerPageSelect';
import { RefreshButton } from '../components/RefreshButton';
import { SectionCard } from '../components/SectionCard';
import { StatTile, type StatTone } from '../components/StatTile';
import { QUICK_ACCENT_CLASS, QuickIconButton } from '../components/VideoQuickActions';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { PREF_KEYS, readPreference, writePreference } from '../lib/preferences';
import { useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { useJobFinished } from '../state/useJobFinished';
import { isQueuedVideo, ProcessingBadge, stageLabel } from './videoStatus';

export const LOG_PAGE_SIZES = [12, 24, 36, 48] as const;
const DEFAULT_LOG_PAGE_SIZE = 24;
const GENERIC_ERROR = 'Something went wrong. Please try again.';
/** While videos are processing the screen re-reads the logs this often (quietly). */
const LIVE_REFRESH_MS = 8000;

type Filter = 'all' | LogType;

const TILES: ReadonlyArray<{
    id: Filter;
    label: string;
    tone: StatTone;
    icon: ReactNode;
    actionLabel: string;
}> = [
    {
        id: 'all',
        label: 'Total',
        tone: 'primary',
        icon: <StatTotalIcon />,
        actionLabel: 'show all logs',
    },
    {
        id: 'success',
        label: 'Success',
        tone: 'success',
        icon: <StatReadyIcon />,
        actionLabel: 'show success logs',
    },
    {
        id: 'processing',
        label: 'Processing',
        tone: 'warning',
        icon: <StatProcessingIcon />,
        actionLabel: 'show processing logs',
    },
    {
        id: 'error',
        label: 'Error',
        tone: 'danger',
        icon: <StatFailedIcon />,
        actionLabel: 'show error logs',
    },
];

const CARD_TITLES: Record<LogType, string> = {
    error: 'Error',
    success: 'Success',
    processing: 'Processing',
};

const EMPTY_TITLES: Record<LogType, string> = {
    error: 'No error logs.',
    success: 'No success logs.',
    processing: 'No processing logs.',
};

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | {
          kind: 'summary';
          success: LogItem[];
          error: LogItem[];
          processing: LogItem[];
      }
    | { kind: 'page'; items: LogItem[]; meta: VideoListMeta };

function progressOf(item: LogItem): number {
    if (isQueuedVideo(item.status, item.stage)) return 0;

    return Math.max(0, Math.min(100, Math.round(item.progress ?? 0)));
}

/** "2 transcoding · 1 queued": how many videos sit in each stage (the web Logs summary). */
function stageSummary(items: LogItem[], total: number): string {
    if (items.length === 0) return '';

    const label = (item: LogItem) => stageLabel(item.status, item.stage).replace(/[.…]+$/, '');

    if (total === 1) return label(items[0]!);

    const counts = new Map<string, number>();

    for (const item of items) counts.set(label(item), (counts.get(label(item)) ?? 0) + 1);

    const parts = [...counts].map(
        ([name, count]) => `${count} ${name.charAt(0).toLowerCase()}${name.slice(1)}`,
    );

    if (total > items.length) parts.push(`+${total - items.length} more`);

    return parts.join(' · ');
}

function Time({ iso, now, prefix = '' }: { iso: string; now: number; prefix?: string }) {
    return (
        <time dateTime={iso} title={formatDateTime(iso)}>
            {prefix}
            {formatRelativeTime(iso, now)}
        </time>
    );
}

/** All server text is rendered as plain text (React escapes it); `<pre>` only keeps line breaks. */
function ErrorRow({
    item,
    now,
    onOpen,
}: {
    item: LogItem;
    now: number;
    onOpen: (id: number) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const detailsId = useId();
    const time = item.failedAt ?? item.updatedAt ?? item.createdAt;
    const hasDetail = item.errorDetail !== null && item.errorDetail !== '';
    const hasMessage = item.errorMessage !== null && item.errorMessage !== '';

    return (
        <li className="log-row row-surface row-surface-flat" data-log-id={item.id}>
            <div className="log-row-main">
                <div className="log-row-head">
                    <p className="job-name" title={item.title}>
                        {item.title}
                    </p>
                    {time !== null && (
                        <span className="job-meta">
                            <Time iso={time} now={now} prefix="Failed " />
                        </span>
                    )}
                </div>
                {hasMessage && <p className="log-error-message">{item.errorMessage}</p>}
            </div>
            <div className="log-row-actions">
                {hasDetail && (
                    <QuickIconButton
                        className="btn btn-sm video-quick"
                        ariaLabel={`Details for ${item.title}`}
                        label="Details"
                        icon={<InfoIcon />}
                        ariaExpanded={expanded}
                        ariaControls={detailsId}
                        onClick={() => setExpanded((open) => !open)}
                    />
                )}
                <QuickIconButton
                    className={QUICK_ACCENT_CLASS}
                    ariaLabel={`View in Library for ${item.title}`}
                    label="View in Library"
                    icon={<LibraryIcon />}
                    onClick={() => onOpen(item.id)}
                />
            </div>
            {hasDetail && expanded && (
                <div className="log-row-detail">
                    <p className="job-meta">Technical details</p>
                    <pre id={detailsId} className="log mono">
                        {item.errorDetail}
                    </pre>
                </div>
            )}
        </li>
    );
}

function SuccessRow({
    item,
    now,
    onOpen,
}: {
    item: LogItem;
    now: number;
    onOpen: (id: number) => void;
}) {
    return (
        <li className="log-row row-surface row-surface-flat" data-log-id={item.id}>
            <div className="log-row-main">
                <p className="job-name" title={item.title}>
                    {item.title}
                </p>
                {item.createdAt !== null && (
                    <span className="job-meta">
                        <Time iso={item.createdAt} now={now} />
                    </span>
                )}
            </div>
            <div className="log-row-actions">
                <QuickIconButton
                    className={QUICK_ACCENT_CLASS}
                    ariaLabel={`View in Library for ${item.title}`}
                    label="View in Library"
                    icon={<LibraryIcon />}
                    onClick={() => onOpen(item.id)}
                />
            </div>
        </li>
    );
}

function ProcessingRow({ item, now }: { item: LogItem; now: number }) {
    const queued = isQueuedVideo(item.status, item.stage);
    const label = stageLabel(item.status, item.stage);

    return (
        <li
            className={`log-row row-surface row-surface-flat${queued ? ' is-queued' : ''}`}
            data-log-id={item.id}
        >
            <div className="log-row-main">
                <div className="log-row-head">
                    <p className="job-name" title={item.title}>
                        {item.title}
                    </p>
                    {item.createdAt !== null && (
                        <span className="job-meta">
                            <Time iso={item.createdAt} now={now} />
                        </span>
                    )}
                </div>
                <div className="log-row-status">
                    <ProcessingBadge queued={queued} />
                    {label !== (queued ? 'Queued' : 'Processing') && (
                        <span className="job-meta">{label}</span>
                    )}
                </div>
                <JobProgress fileName={item.title} progress={progressOf(item)} />
            </div>
        </li>
    );
}

function LogRow({
    item,
    now,
    onOpen,
}: {
    item: LogItem;
    now: number;
    onOpen: (id: number) => void;
}) {
    if (item.status === 'failed') return <ErrorRow item={item} now={now} onOpen={onOpen} />;

    if (item.status === 'processing' || item.status === 'pending') {
        return <ProcessingRow item={item} now={now} />;
    }

    return <SuccessRow item={item} now={now} onOpen={onOpen} />;
}

function LogList({
    label,
    items,
    now,
    onOpen,
}: {
    label: string;
    items: LogItem[];
    now: number;
    onOpen: (id: number) => void;
}) {
    return (
        <ul className="log-list" aria-label={label}>
            {items.map((item) => (
                <LogRow key={item.id} item={item} now={now} onOpen={onOpen} />
            ))}
        </ul>
    );
}

/** One card of the Logs screen: title + count, then its rows or the empty text. */
function LogCard({
    type,
    items,
    total,
    now,
    onOpen,
}: {
    type: LogType;
    items: LogItem[];
    total: number;
    now: number;
    onOpen: (id: number) => void;
}) {
    return (
        <SectionCard
            title={CARD_TITLES[type]}
            level={3}
            action={<span className="num group-header-count log-card-count">{total}</span>}
        >
            {items.length === 0 ? (
                <EmptyState compact icon={<LogsIcon />} title={EMPTY_TITLES[type]} />
            ) : (
                <LogList
                    label={`${CARD_TITLES[type]} logs`}
                    items={items}
                    now={now}
                    onOpen={onOpen}
                />
            )}
            {total > items.length && items.length > 0 && (
                <p className="muted small">{`Showing latest ${items.length} of ${total}`}</p>
            )}
        </SectionCard>
    );
}

/** The live block: the videos the site is still working on, with the overall progress. */
function ProcessingBlock({
    items,
    total,
    now,
    onOpen,
}: {
    items: LogItem[];
    total: number;
    now: number;
    onOpen: (id: number) => void;
}) {
    const count = Math.max(total, items.length);
    const overall = Math.round(
        items.reduce((sum, item) => sum + progressOf(item), 0) / Math.max(items.length, 1),
    );

    return (
        <SectionCard
            title={`Processing ${count} ${count === 1 ? 'video' : 'videos'}`}
            level={3}
            description={<p className="muted small">{stageSummary(items, count)}</p>}
        >
            <div className="log-processing-summary">
                <JobProgress fileName="all processing videos" progress={overall} />
            </div>
            <LogList label="Processing logs" items={items} now={now} onOpen={onOpen} />
        </SectionCard>
    );
}

export function LogsScreen() {
    const { api } = useApp();
    const { openLibraryVideo } = useNavigation();
    const now = useNow();
    const [filter, setFilter] = useState<Filter>('all');
    const [page, setPage] = useState(1);
    const [perPage, setPerPage] = useState(() =>
        readPreference(PREF_KEYS.logsPerPage, LOG_PAGE_SIZES, DEFAULT_LOG_PAGE_SIZE),
    );
    const [reloads, setReloads] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    // True while any request is running (also a quiet one): only the Refresh icon shows it.
    const [fetching, setFetching] = useState(false);
    // The last counts the site sent: they stay visible while another view loads.
    const [counts, setCounts] = useState<LogCounts | null>(null);
    const latest = useRef(0);
    // Set by a quiet refresh just before it bumps `reloads`: the data stays on screen meanwhile.
    const quiet = useRef(false);
    const rootRef = useRef<HTMLElement>(null);

    useEffect(() => {
        // A newer request wins: answers of older ones are ignored.
        const request = ++latest.current;
        const silent = quiet.current;

        quiet.current = false;

        if (!silent) setLoad({ kind: 'loading' });

        // A failed quiet refresh keeps what is on screen (unless nothing is yet).
        const fail = (message: string) =>
            setLoad((previous) =>
                !silent || previous.kind === 'loading' ? { kind: 'error', message } : previous,
            );

        setFetching(true);

        api.logs
            .get(filter === 'all' ? undefined : { type: filter, page, perPage })
            .then((result) => {
                if (request !== latest.current) return;

                setFetching(false);

                if (!result.ok) {
                    fail(result.error);

                    return;
                }

                setCounts(result.counts);

                // The shape has to match what was asked for.
                if (filter === 'all' && result.view === 'summary') {
                    setLoad({
                        kind: 'summary',
                        success: result.success,
                        error: result.error,
                        processing: result.processing,
                    });
                } else if (filter !== 'all' && result.view === 'page') {
                    setLoad({ kind: 'page', items: result.data, meta: result.meta });
                } else {
                    fail(GENERIC_ERROR);
                }
            })
            .catch(() => {
                if (request !== latest.current) return;

                setFetching(false);
                fail(GENERIC_ERROR);
            });
    }, [api, filter, page, perPage, reloads]);

    // Ignore an answer that arrives after the screen is gone.
    useEffect(
        () => () => {
            latest.current += 1;
        },
        [],
    );

    /** Re-reads the current view without a loading state, same page, rows stay as they are. */
    const refreshQuietly = useCallback(() => {
        quiet.current = true;
        setReloads((count) => count + 1);
    }, []);
    const retry = useCallback(() => setReloads((count) => count + 1), []);

    // A video the app just finished uploading is new to the site's logs.
    useJobFinished(refreshQuietly);

    // The site keeps working after the upload (merge, transcode, ...) and the app gets no event
    // for it: while something is processing, look again every few seconds, and when the window
    // comes back to the front. Nothing runs while nothing is processing.
    const hasProcessing = (counts?.processing ?? 0) > 0;

    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible') refreshQuietly();
        };

        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);

        const timer = hasProcessing
            ? window.setInterval(() => {
                  if (document.visibilityState === 'visible') refreshQuietly();
              }, LIVE_REFRESH_MS)
            : undefined;

        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);

            if (timer !== undefined) window.clearInterval(timer);
        };
    }, [hasProcessing, refreshQuietly]);

    function chooseFilter(next: Filter): void {
        if (next === filter) return;

        setFilter(next);
        setPage(1);
    }

    /** Page change from the pager: fetches through the effect and returns to the top. */
    function changePage(next: number): void {
        setPage(next);

        const panel = rootRef.current?.closest<HTMLElement>('.panel') ?? null;

        if (panel !== null) panel.scrollTop = 0;
    }

    function choosePageSize(size: number): void {
        setPerPage(size);
        writePreference(PREF_KEYS.logsPerPage, size);
        setPage(1);
    }

    const countOf = (id: Filter): number | null =>
        counts === null ? null : id === 'all' ? counts.total : counts[id];
    const smallestPage = Math.min(...LOG_PAGE_SIZES);

    function pager(label: string, meta: VideoListMeta) {
        return (
            <Pagination
                label={label}
                page={meta.page}
                lastPage={meta.lastPage}
                total={meta.total}
                noun="log"
                onPageChange={changePage}
            />
        );
    }

    return (
        <section ref={rootRef} className="logs" aria-labelledby="logs-heading">
            {/* The visible page title is the top bar's; this heading names the region. */}
            <h2 id="logs-heading" className="visually-hidden">
                Logs
            </h2>

            <div className="logs-head">
                <ul className="logs-stats" aria-label="Filter logs">
                    {TILES.map((tile) => (
                        <li key={tile.id} className="card">
                            <StatTile
                                icon={tile.icon}
                                value={countOf(tile.id)}
                                label={tile.label}
                                tone={tile.tone}
                                selected={filter === tile.id}
                                actionLabel={tile.actionLabel}
                                onClick={() => chooseFilter(tile.id)}
                            />
                        </li>
                    ))}
                </ul>
                <RefreshButton busy={fetching} onClick={refreshQuietly} />
            </div>

            {load.kind === 'loading' && (
                <p className="empty" role="status" aria-busy="true">
                    {'Loading…'}
                </p>
            )}

            {load.kind === 'error' && (
                <div className="empty">
                    <p role="alert">{load.message}</p>
                    <button type="button" className="btn btn-sm" onClick={retry}>
                        Retry
                    </button>
                </div>
            )}

            {load.kind === 'summary' && (
                <>
                    {load.processing.length > 0 && (
                        <ProcessingBlock
                            items={load.processing}
                            total={counts?.processing ?? load.processing.length}
                            now={now}
                            onOpen={openLibraryVideo}
                        />
                    )}
                    <div className="log-columns">
                        <LogCard
                            type="error"
                            items={load.error}
                            total={counts?.error ?? load.error.length}
                            now={now}
                            onOpen={openLibraryVideo}
                        />
                        <LogCard
                            type="success"
                            items={load.success}
                            total={counts?.success ?? load.success.length}
                            now={now}
                            onOpen={openLibraryVideo}
                        />
                    </div>
                </>
            )}

            {load.kind === 'page' && filter !== 'all' && (
                <>
                    {load.meta.total > 0 && (
                        <div className="pager-row">
                            {load.meta.total > smallestPage && (
                                <PerPageSelect
                                    value={perPage}
                                    options={LOG_PAGE_SIZES}
                                    onChange={choosePageSize}
                                />
                            )}
                            {pager('Logs pagination, top', load.meta)}
                        </div>
                    )}

                    <LogCard
                        type={filter}
                        items={load.items}
                        total={load.meta.total}
                        now={now}
                        onOpen={openLibraryVideo}
                    />

                    {load.meta.lastPage > 1 && (
                        <div className="pager-row">
                            {pager('Logs pagination, bottom', load.meta)}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
