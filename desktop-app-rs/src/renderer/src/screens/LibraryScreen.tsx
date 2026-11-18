import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import type { VideoDetail, VideoListItem, VideoListMeta } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { Pagination } from '../components/Pagination';
import { GridViewIcon, ListViewIcon, SearchIcon } from '../components/icons';
import { Thumbnail } from '../components/Thumbnail';
import {
    QuickActionButtons,
    useQuickActions,
    type QuickAction,
} from '../components/VideoQuickActions';
import { formatDate, formatDuration, plural } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { useJobFinished } from '../state/useJobFinished';
import { StatusBadge } from './videoStatus';
import { VideoDetailPage } from './VideoDetailPage';

const SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 24;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type ViewMode = 'grid' | 'list';

const VIEW_STORAGE_KEY = 'hls-r2-studio:library-view';

/** The saved view; anything missing, invalid or unreadable means the grid. */
function readView(): ViewMode {
    try {
        return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid';
    } catch {
        return 'grid';
    }
}

function saveView(view: ViewMode): void {
    try {
        window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
        // Storage can be blocked: the choice then only lasts until the app closes.
    }
}

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; items: VideoListItem[]; meta: VideoListMeta };

function VideoRow({
    video,
    onOpen,
    selecting,
    picked,
    disabled,
    onToggle,
    view,
    quickBusy,
    onQuick,
}: {
    view: ViewMode;
    /** A quick action of this row is in flight: its buttons are disabled. */
    quickBusy: boolean;
    onQuick: (video: VideoListItem, action: QuickAction) => void;
    video: VideoListItem;
    onOpen: (video: VideoListItem, opener: HTMLButtonElement) => void;
    /** Select mode: the whole card is a checkbox label instead of a button that opens details. */
    selecting: boolean;
    picked: boolean;
    disabled: boolean;
    onToggle: (id: number) => void;
}) {
    const duration = formatDuration(video.duration);
    const created = formatDate(video.createdAt);
    const content =
        view === 'list' ? (
            <>
                <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />
                <span className="video-title" title={video.title}>
                    {video.title}
                </span>
                <StatusBadge status={video.status} />
                <span className="video-cell video-duration num">{duration}</span>
                <span className="video-cell video-created">{created}</span>
            </>
        ) : (
            <>
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
            </>
        );

    if (selecting) {
        return (
            <li className={picked ? 'video-row is-picked' : 'video-row'}>
                <label className="video-open">
                    <input
                        type="checkbox"
                        className="video-check"
                        aria-label={`Select ${video.title}`}
                        checked={picked}
                        disabled={disabled}
                        onChange={() => onToggle(video.id)}
                    />
                    {content}
                </label>
            </li>
        );
    }

    return (
        <li className="video-row">
            <button
                type="button"
                className="video-open"
                onClick={(event) => onOpen(video, event.currentTarget)}
            >
                {content}
            </button>
            {video.status === 'ready' && (
                <QuickActionButtons
                    title={video.title}
                    busy={quickBusy}
                    onQuick={(action) => onQuick(video, action)}
                />
            )}
        </li>
    );
}

export function LibraryScreen({ initialVideoId }: { initialVideoId?: number }) {
    const { api } = useApp();
    const toast = useToast();
    const quick = useQuickActions();
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
    // Select mode: the ids ticked on the page on screen (ids that left the page are ignored).
    const [selectMode, setSelectMode] = useState(false);
    const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
    const [viewMode, setViewMode] = useState<ViewMode>(readView);
    const [confirmBulk, setConfirmBulk] = useState(false);
    const [bulkBusy, setBulkBusy] = useState(false);
    const pendingFocus = useRef<'toggle' | 'bulk' | 'heading' | null>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const bulkRef = useRef<HTMLButtonElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
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

            if (pendingFocus.current === 'heading') {
                // The video is gone, so there is no row to return to.
                pendingFocus.current = null;
                headingRef.current?.focus({ preventScroll: true });
            } else {
                openerRef.current?.focus({ preventScroll: true });
            }
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

    // Esc leaves select mode (a dialog or the rename field handles its own Esc first).
    useEffect(() => {
        if (!selectMode || isOpen) return;

        function onKeyDown(event: KeyboardEvent): void {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault();
                setSelectMode(false);
                setPicked(new Set());
                pendingFocus.current = 'toggle';
            }
        }

        document.addEventListener('keydown', onKeyDown);

        return () => document.removeEventListener('keydown', onKeyDown);
    }, [selectMode, isOpen]);

    // A new page or search starts with nothing ticked.
    useEffect(() => {
        setPicked(new Set());
    }, [page, search]);

    // Puts the focus back on a control that was disabled or removed while an action ran.
    useEffect(() => {
        if (pendingFocus.current === 'toggle' && !selectMode) {
            pendingFocus.current = null;
            toggleRef.current?.focus();
        } else if (pendingFocus.current === 'bulk' && !bulkBusy && !confirmBulk) {
            pendingFocus.current = null;
            bulkRef.current?.focus();
        }
    });

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

    // A job that newly becomes `done` adds a video at the top of the list. This screen is
    // unmounted while another tab is active, so it loads fresh data when the tab is opened again.
    useJobFinished(() => {
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

    function onRenamed(id: number, title: string): void {
        setSelected((current) => (current?.id === id ? { ...current, title } : current));
        setLoad((current) =>
            current.kind === 'ready'
                ? {
                      ...current,
                      items: current.items.map((item) =>
                          item.id === id ? { ...item, title } : item,
                      ),
                  }
                : current,
        );
    }

    /**
     * The thumbnail changed. List URLs carry no cache-buster, so the row takes the detail's
     * URLs (cache-busted by the site) instead of reloading the list.
     */
    function onImageChanged(video: VideoDetail): void {
        const thumbnailUrl = video.customImageUrl ?? video.thumbnailUrl;

        setLoad((current) =>
            current.kind === 'ready'
                ? {
                      ...current,
                      items: current.items.map((item) =>
                          item.id === video.id
                              ? { ...item, thumbnailUrl, hasCustomImage: video.hasCustomImage }
                              : item,
                      ),
                  }
                : current,
        );
    }

    /** `removed` rows left the page: reload it, or go back one page when it is now empty. */
    function reloadAfterRemoval(removed: number): void {
        const shown = load.kind === 'ready' ? load.items.length : 0;

        if (page > 1 && removed >= shown) setPage(page - 1);
        else refresh();
    }

    function onDeleted(): void {
        pendingFocus.current = 'heading';
        setSelected(null);
        reloadAfterRemoval(1);
    }

    /** Page change from the pager: fetches through the `page` effect and returns to the list top. */
    function changePage(next: number): void {
        setPage(next);

        const panel = scroller();

        if (panel !== null) panel.scrollTop = 0;
    }

    function chooseView(next: ViewMode): void {
        setViewMode(next);
        saveView(next);
    }

    function toggleSelectMode(): void {
        setSelectMode((on) => !on);
        setPicked(new Set());
    }

    function togglePicked(id: number): void {
        setPicked((current) => {
            const next = new Set(current);

            if (next.has(id)) next.delete(id);
            else next.add(id);

            return next;
        });
    }

    const items = load.kind === 'ready' ? load.items : [];
    const pickedIds = items.filter((item) => picked.has(item.id)).map((item) => item.id);

    function deleteSelected(): void {
        const ids = pickedIds;

        setConfirmBulk(false);
        setBulkBusy(true);
        api.videos
            .bulkDelete(ids)
            .then((result) => {
                if (!result.ok) {
                    toast.show('error', result.error);
                    pendingFocus.current = 'bulk';

                    return;
                }

                toast.show(
                    result.failed > 0 ? 'error' : result.deleted > 0 ? 'success' : 'info',
                    result.message,
                );
                pendingFocus.current = 'toggle';
                setSelectMode(false);
                setPicked(new Set());
                reloadAfterRemoval(result.deleted);
            })
            .catch(() => {
                toast.show('error', GENERIC_ERROR);
                pendingFocus.current = 'bulk';
            })
            .finally(() => setBulkBusy(false));
    }

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
                    onRenamed={onRenamed}
                    onDeleted={onDeleted}
                    onImageChanged={onImageChanged}
                />
            )}

            <div hidden={selected !== null}>
                <div className="section-head">
                    <h2 id="library-heading" ref={headingRef} tabIndex={-1}>
                        Library
                    </h2>
                    <div className="row">
                        <div className="segmented" role="group" aria-label="View">
                            <button
                                type="button"
                                className="btn btn-sm"
                                aria-pressed={viewMode === 'grid'}
                                onClick={() => chooseView('grid')}
                            >
                                <GridViewIcon />
                                Grid
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm"
                                aria-pressed={viewMode === 'list'}
                                onClick={() => chooseView('list')}
                            >
                                <ListViewIcon />
                                List
                            </button>
                        </div>
                        <button
                            ref={toggleRef}
                            type="button"
                            className="btn btn-sm"
                            aria-pressed={selectMode}
                            disabled={bulkBusy}
                            onClick={toggleSelectMode}
                        >
                            Select
                        </button>
                        <button type="button" className="btn btn-sm" onClick={refresh}>
                            Refresh
                        </button>
                    </div>
                </div>

                {selectMode && (
                    <div className="library-tools" role="toolbar" aria-label="Selection">
                        <span className="library-count" role="status">
                            {pickedIds.length} selected
                        </span>
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={bulkBusy || items.length === 0}
                            onClick={() => setPicked(new Set(items.map((item) => item.id)))}
                        >
                            Select all on this page
                        </button>
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={bulkBusy || pickedIds.length === 0}
                            onClick={() => setPicked(new Set())}
                        >
                            Clear
                        </button>
                        <button
                            ref={bulkRef}
                            type="button"
                            className="btn btn-sm btn-accent-danger"
                            disabled={bulkBusy || pickedIds.length === 0}
                            onClick={() => setConfirmBulk(true)}
                        >
                            Delete selected
                        </button>
                    </div>
                )}

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
                    <div
                        className={
                            viewMode === 'list'
                                ? selectMode
                                    ? 'videos-wrap is-list is-selecting'
                                    : 'videos-wrap is-list'
                                : 'videos-wrap'
                        }
                    >
                        {viewMode === 'list' && (
                            <div className="videos-head" aria-hidden="true">
                                <span>Preview</span>
                                <span>Title</span>
                                <span>Status</span>
                                <span className="video-duration">Duration</span>
                                <span className="video-created">Created</span>
                            </div>
                        )}
                        <ul
                            className={viewMode === 'list' ? 'videos videos-list' : 'videos'}
                            aria-label="Videos"
                        >
                            {load.items.map((video) => (
                                <VideoRow
                                    key={video.id}
                                    video={video}
                                    view={viewMode}
                                    onOpen={openVideo}
                                    selecting={selectMode}
                                    picked={picked.has(video.id)}
                                    disabled={bulkBusy}
                                    onToggle={togglePicked}
                                    quickBusy={quick.busyIds.has(video.id)}
                                    onQuick={(item, action) => quick.run(item.id, action)}
                                />
                            ))}
                        </ul>
                    </div>
                )}

                {meta !== null && (
                    <Pagination
                        page={meta.page}
                        lastPage={meta.lastPage}
                        total={meta.total}
                        onPageChange={changePage}
                    />
                )}
            </div>

            {confirmBulk && (
                <ConfirmDialog
                    title={`Delete ${plural(pickedIds.length, 'video')}`}
                    message={`Delete ${plural(pickedIds.length, 'video')}? This removes ${
                        pickedIds.length === 1 ? 'it' : 'them'
                    } from the site and may remove ${
                        pickedIds.length === 1 ? 'its' : 'their'
                    } files from storage. This cannot be undone.`}
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    danger
                    onConfirm={deleteSelected}
                    onCancel={() => setConfirmBulk(false)}
                />
            )}
        </section>
    );
}
