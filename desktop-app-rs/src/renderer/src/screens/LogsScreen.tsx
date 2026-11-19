import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { LogCounts, LogItem, LogType, VideoListMeta } from '../../../shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { GroupHeader } from '../components/GroupHeader';
import { LogsIcon } from '../components/icons';
import { useNow } from '../components/JobRow';
import { Pagination } from '../components/Pagination';
import { formatDateTime, formatRelativeTime } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { StatusBadge } from './videoStatus';

const PAGE_SIZE = 24;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type Filter = 'all' | LogType;

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'success', label: 'Success' },
    { id: 'error', label: 'Error' },
    { id: 'processing', label: 'Processing' },
];

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

/** The moment that matters for a row: when it failed, else when it last changed. */
function eventTime(item: LogItem): string | null {
    return item.failedAt ?? item.updatedAt ?? item.createdAt;
}

/** All server text is rendered as plain text (React escapes it); `<pre>` only keeps line breaks. */
function LogRow({
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
    const time = eventTime(item);
    const hasDetail = item.errorDetail !== null && item.errorDetail !== '';

    return (
        <li className="log-row row-surface">
            <div className="log-main">
                <StatusBadge status={item.status} />
                <button
                    type="button"
                    className="log-title"
                    title={item.title}
                    onClick={() => onOpen(item.id)}
                >
                    {item.title}
                </button>
                {time !== null && (
                    <time
                        className="log-time muted small"
                        dateTime={time}
                        title={formatDateTime(time)}
                    >
                        {formatRelativeTime(time, now)}
                    </time>
                )}
            </div>

            {item.status === 'processing' && item.progress !== null && (
                <div className="log-progress">
                    <progress
                        max={100}
                        value={item.progress}
                        aria-label={`Progress of ${item.title}`}
                    />
                    <span className="num small">{item.progress}%</span>
                    {item.stage !== null && item.stage !== '' && (
                        <span className="muted small">{item.stage}</span>
                    )}
                </div>
            )}

            {item.errorMessage !== null && item.errorMessage !== '' && (
                <p className="log-error">{item.errorMessage}</p>
            )}

            {hasDetail && (
                <div className="log-details">
                    <button
                        type="button"
                        className="btn btn-sm"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        onClick={() => setExpanded((open) => !open)}
                    >
                        Details
                    </button>
                    {expanded && (
                        <pre id={detailsId} className="log mono">
                            {item.errorDetail}
                        </pre>
                    )}
                </div>
            )}
        </li>
    );
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

function Section({
    title,
    items,
    now,
    onOpen,
}: {
    title: string;
    items: LogItem[];
    now: number;
    onOpen: (id: number) => void;
}) {
    const id = useId();

    return (
        <section className="log-section" aria-labelledby={id}>
            <GroupHeader title={title} count={items.length} headingLevel={3} titleId={id} />
            {items.length === 0 ? (
                <EmptyState compact title="Nothing here." />
            ) : (
                <LogList label={title} items={items} now={now} onOpen={onOpen} />
            )}
        </section>
    );
}

export function LogsScreen() {
    const { api } = useApp();
    const { openLibraryVideo } = useNavigation();
    const now = useNow();
    const [filter, setFilter] = useState<Filter>('all');
    const [page, setPage] = useState(1);
    const [reloads, setReloads] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    // The last counts the site sent: they stay visible while another view loads.
    const [counts, setCounts] = useState<LogCounts | null>(null);
    const latest = useRef(0);
    const rootRef = useRef<HTMLElement>(null);

    useEffect(() => {
        // A newer request wins: answers of older ones are ignored.
        const request = ++latest.current;

        setLoad({ kind: 'loading' });

        api.logs
            .get(filter === 'all' ? undefined : { type: filter, page, perPage: PAGE_SIZE })
            .then((result) => {
                if (request !== latest.current) return;

                if (!result.ok) {
                    setLoad({ kind: 'error', message: result.error });

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
                    setLoad({ kind: 'error', message: GENERIC_ERROR });
                }
            })
            .catch(() => {
                if (request === latest.current) setLoad({ kind: 'error', message: GENERIC_ERROR });
            });
    }, [api, filter, page, reloads]);

    // Ignore an answer that arrives after the screen is gone.
    useEffect(
        () => () => {
            latest.current += 1;
        },
        [],
    );

    const refresh = useCallback(() => setReloads((count) => count + 1), []);

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

    const countOf = (id: Filter): number | null =>
        counts === null ? null : id === 'all' ? counts.total : counts[id];

    const emptySummary =
        load.kind === 'summary' &&
        load.success.length === 0 &&
        load.error.length === 0 &&
        load.processing.length === 0;

    return (
        <section ref={rootRef} className="logs" aria-labelledby="logs-heading">
            <div className="section-head">
                <h2 id="logs-heading">Logs</h2>
                <button type="button" className="btn btn-sm" onClick={refresh}>
                    Refresh
                </button>
            </div>

            <div className="segmented logs-filter" role="group" aria-label="Filter logs">
                {FILTERS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className="btn btn-sm"
                        aria-pressed={filter === item.id}
                        onClick={() => chooseFilter(item.id)}
                    >
                        {item.label}
                        {countOf(item.id) !== null && (
                            <>
                                {' '}
                                <span className="num">({countOf(item.id)})</span>
                            </>
                        )}
                    </button>
                ))}
            </div>

            {load.kind === 'loading' && (
                <p className="empty" role="status" aria-busy="true">
                    {'Loading…'}
                </p>
            )}

            {load.kind === 'error' && (
                <div className="empty">
                    <p role="alert">{load.message}</p>
                    <button type="button" className="btn btn-sm" onClick={refresh}>
                        Retry
                    </button>
                </div>
            )}

            {emptySummary && <EmptyState icon={<LogsIcon />} title="No logs yet" />}

            {load.kind === 'summary' && !emptySummary && (
                <div className="log-sections">
                    <Section
                        title="Recent successes"
                        items={load.success}
                        now={now}
                        onOpen={openLibraryVideo}
                    />
                    <Section
                        title="Recent errors"
                        items={load.error}
                        now={now}
                        onOpen={openLibraryVideo}
                    />
                    <Section
                        title="In progress"
                        items={load.processing}
                        now={now}
                        onOpen={openLibraryVideo}
                    />
                </div>
            )}

            {load.kind === 'page' && load.items.length === 0 && (
                <EmptyState icon={<LogsIcon />} title="No logs yet" />
            )}

            {load.kind === 'page' && load.items.length > 0 && (
                <LogList
                    label={`${FILTERS.find((item) => item.id === filter)?.label ?? ''} logs`}
                    items={load.items}
                    now={now}
                    onOpen={openLibraryVideo}
                />
            )}

            {load.kind === 'page' && load.meta.total > 0 && (
                <Pagination
                    page={load.meta.page}
                    lastPage={load.meta.lastPage}
                    total={load.meta.total}
                    noun="log"
                    onPageChange={changePage}
                />
            )}
        </section>
    );
}
