import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import type { VideoListItem, VideoListMeta } from '../../../shared/ipc';
import type { JobState } from '../../../shared/types';
import { SearchIcon } from '../components/icons';
import { formatDate, formatDuration, plural } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { StatusBadge } from './videoStatus';
import { VideoDetailPage } from './VideoDetailPage';

const SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 24;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; items: VideoListItem[]; meta: VideoListMeta };

/** The image falls back to a placeholder when there is no URL or it fails to load. */
function Thumbnail({ url }: { url: string | null }) {
    const [failed, setFailed] = useState(false);

    if (url === null || failed) {
        return (
            <div className="thumb thumb-placeholder" aria-hidden="true">
                No preview
            </div>
        );
    }

    return (
        <img className="thumb" src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
    );
}

function VideoRow({
    video,
    onOpen,
}: {
    video: VideoListItem;
    onOpen: (video: VideoListItem, opener: HTMLButtonElement) => void;
}) {
    const duration = formatDuration(video.duration);
    const created = formatDate(video.createdAt);

    return (
        <li className="video-row">
            <button
                type="button"
                className="video-open"
                onClick={(event) => onOpen(video, event.currentTarget)}
            >
                <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />
                <span className="video-main">
                    <span className="video-title" title={video.title}>
                        {video.title}
                    </span>
                    <span className="video-meta">
                        {duration !== '' && <span className="num">{duration}</span>}
                        {created !== '' && <span>{created}</span>}
                    </span>
                </span>
                <StatusBadge status={video.status} />
            </button>
        </li>
    );
}

export function LibraryScreen({ initialVideoId }: { initialVideoId?: number }) {
    const { api } = useApp();
    const [input, setInput] = useState('');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [reloads, setReloads] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    const latest = useRef(0);
    // The open video. The list below stays mounted (only hidden) while the detail page is open,
    // so its page, search text, loaded rows and scroll position are kept as they were.
    // A "View in Library" request from the Queue opens its video right away.
    const [selected, setSelected] = useState<{ id: number; title: string } | null>(() =>
        initialVideoId === undefined ? null : { id: initialVideoId, title: 'Video' },
    );
    // True when a finished job added videos the list on screen does not show yet.
    const [stale, setStale] = useState(false);
    const rootRef = useRef<HTMLElement>(null);
    const openerRef = useRef<HTMLButtonElement | null>(null);
    const savedScroll = useRef(0);

    const scroller = useCallback(() => rootRef.current?.closest<HTMLElement>('.panel') ?? null, []);

    const openVideo = useCallback(
        (video: VideoListItem, opener: HTMLButtonElement) => {
            savedScroll.current = scroller()?.scrollTop ?? 0;
            openerRef.current = opener;
            setSelected({ id: video.id, title: video.title });
        },
        [scroller],
    );

    const closeVideo = useCallback(() => setSelected(null), []);

    // The detail page starts at the top; going back restores the list position and focus.
    const isOpen = selected !== null;
    const wasOpen = useRef(false);

    useLayoutEffect(() => {
        const panel = scroller();

        if (isOpen) {
            if (panel !== null) panel.scrollTop = 0;
        } else if (wasOpen.current) {
            if (panel !== null) panel.scrollTop = savedScroll.current;

            openerRef.current?.focus({ preventScroll: true });
        }

        wasOpen.current = isOpen;
    }, [isOpen, scroller]);

    useEffect(() => {
        if (!isOpen) return;

        function onKeyDown(event: KeyboardEvent): void {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault();
                setSelected(null);
            }
        }

        document.addEventListener('keydown', onKeyDown);

        return () => document.removeEventListener('keydown', onKeyDown);
    }, [isOpen]);

    // Typing is applied after a pause and always goes back to the first page.
    useEffect(() => {
        const timer = setTimeout(() => {
            const next = input.trim();

            if (next !== search) {
                setSearch(next);
                setPage(1);
            }
        }, SEARCH_DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [input, search]);

    useEffect(() => {
        // A newer request wins: answers of older ones are ignored.
        const request = ++latest.current;
        const params =
            search === '' ? { page, perPage: PAGE_SIZE } : { page, perPage: PAGE_SIZE, q: search };

        setLoad({ kind: 'loading' });

        if (page === 1 && search === '') setStale(false);

        api.videos
            .list(params)
            .then((result) => {
                if (request !== latest.current) return;

                setLoad(
                    result.ok
                        ? { kind: 'ready', items: result.data, meta: result.meta }
                        : { kind: 'error', message: result.error },
                );
            })
            .catch(() => {
                if (request === latest.current) setLoad({ kind: 'error', message: GENERIC_ERROR });
            });
    }, [api, search, page, reloads]);

    // Ignore an answer that arrives after the screen is gone.
    useEffect(
        () => () => {
            latest.current += 1;
        },
        [],
    );

    const refresh = useCallback(() => setReloads((count) => count + 1), []);

    // The latest view state, read by the job listener below (which is subscribed only once).
    const view = useRef({ page, search, input, selected, kind: load.kind });

    view.current = { page, search, input, selected, kind: load.kind };

    // A job that newly becomes `done` adds a video at the top of the list. The first snapshot
    // after mount is only the baseline. This screen is unmounted while another tab is active, so
    // it loads fresh data when the tab is opened again.
    useEffect(() => {
        let previous: Map<string, JobState> | null = null;

        const unsubscribe = api.jobs.onUpdated((jobs) => {
            const next = new Map(jobs.map((job) => [job.id, job.state]));
            const finished =
                previous !== null &&
                jobs.some((job) => job.state === 'done' && previous?.get(job.id) !== 'done');

            previous = next;

            if (!finished) return;

            const now = view.current;
            const atTop = now.page === 1 && now.search === '' && now.input.trim() === '';

            if (!atTop || now.selected !== null) {
                setStale(true);

                return;
            }

            // Quiet reload of page 1: no loading state, an older or failed answer changes nothing.
            if (now.kind !== 'ready') {
                refresh();

                return;
            }

            const request = ++latest.current;

            api.videos
                .list({ page: 1, perPage: PAGE_SIZE })
                .then((result) => {
                    if (request === latest.current && result.ok) {
                        setLoad({ kind: 'ready', items: result.data, meta: result.meta });
                    }
                })
                .catch(() => undefined);
        });

        return unsubscribe;
    }, [api, refresh]);

    function showNewVideos(): void {
        setPage(1);
        refresh();
    }

    function onSearch(event: ChangeEvent<HTMLInputElement>): void {
        setInput(event.target.value);
    }

    const meta = load.kind === 'ready' ? load.meta : null;

    return (
        <section ref={rootRef} className="library" aria-labelledby="library-heading">
            {selected !== null && (
                <VideoDetailPage
                    key={selected.id}
                    id={selected.id}
                    fallbackTitle={selected.title}
                    onBack={closeVideo}
                />
            )}

            <div hidden={selected !== null}>
                <div className="section-head">
                    <h2 id="library-heading">Library</h2>
                    <button type="button" className="btn btn-sm" onClick={refresh}>
                        Refresh
                    </button>
                </div>

                <div className="field library-search">
                    <label htmlFor="library-search">Search videos</label>
                    <div className="search">
                        <SearchIcon />
                        <input
                            id="library-search"
                            type="text"
                            maxLength={100}
                            value={input}
                            placeholder="Search by title"
                            onChange={onSearch}
                        />
                    </div>
                </div>

                {stale && (
                    <p className="library-notice" role="status">
                        <span>New videos are available.</span>
                        <button type="button" className="btn btn-sm" onClick={showNewVideos}>
                            Refresh
                        </button>
                    </p>
                )}

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

                {load.kind === 'ready' && load.items.length === 0 && (
                    <p className="empty">
                        {search === '' ? 'No videos yet' : 'No videos match your search'}
                    </p>
                )}

                {load.kind === 'ready' && load.items.length > 0 && (
                    <ul className="videos" aria-label="Videos">
                        {load.items.map((video) => (
                            <VideoRow key={video.id} video={video} onOpen={openVideo} />
                        ))}
                    </ul>
                )}

                {meta !== null && (
                    <nav className="pager" aria-label="Pagination">
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={meta.page <= 1}
                            onClick={() => setPage(Math.max(1, meta.page - 1))}
                        >
                            Previous
                        </button>
                        <span className="num" role="status">
                            Page {meta.page} of {Math.max(1, meta.lastPage)}
                            {' · '}
                            {plural(meta.total, 'video')}
                        </span>
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={meta.page >= meta.lastPage}
                            onClick={() => setPage(meta.page + 1)}
                        >
                            Next
                        </button>
                    </nav>
                )}
            </div>
        </section>
    );
}
