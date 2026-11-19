import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ChangeEvent,
    type FormEvent,
    type ReactElement,
} from 'react';
import {
    VIDEO_SORTS,
    type VideoDetail,
    type VideoListItem,
    type VideoListMeta,
    type VideoSort,
} from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { OrientationChip, orientationLabel } from '../components/OrientationChip';
import { EmptyState } from '../components/EmptyState';
import { Pagination } from '../components/Pagination';
import { PerPageSelect } from '../components/PerPageSelect';
import { TierChip } from '../components/TierChip';
import {
    BitrateIcon,
    ClockIcon,
    DimensionsIcon,
    QualityIcon,
    GridViewIcon,
    ListViewIcon,
    SearchIcon,
    VideoFileIcon,
    CloseIcon,
    StorageIcon,
} from '../components/icons';
import { SelectBox } from '../components/SelectBox';
import { Thumbnail } from '../components/Thumbnail';
import { UploadVideosButton } from '../components/UploadVideosButton';
import { VideoMenu } from '../components/VideoMenu';
import {
    VideoQuickActions,
    useQuickActions,
    type QuickAction,
} from '../components/VideoQuickActions';
import {
    formatBitrate,
    formatBytes,
    formatDateCompact,
    formatDateTime,
    formatDuration,
    formatFps,
    bitrateTier,
    formatQuality,
    formatResolution,
    plural,
    qualityTier,
    videoOrientation,
    type Tier,
    type VideoOrientation,
} from '../lib/format';
import { PREF_KEYS, readPreference, writePreference } from '../lib/preferences';
import { useApp } from '../state/AppProvider';
import { RefreshButton } from '../components/RefreshButton';
import { useToast } from '../state/Toasts';
import { useJobFinished } from '../state/useJobFinished';
import { StatusBadge } from './videoStatus';
import { VideoDetailPage } from './VideoDetailPage';

const PAGE_SIZES = [12, 24, 36, 48] as const;
const DEFAULT_PAGE_SIZE = 24;

const SORT_LABELS: Record<VideoSort, string> = {
    newest: 'Newest',
    oldest: 'Oldest',
    title_asc: 'Title A-Z',
    title_desc: 'Title Z-A',
    duration_desc: 'Longest duration',
    size_desc: 'Largest size',
};
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type ViewMode = 'grid' | 'list';

const VIEW_MODES: readonly ViewMode[] = ['grid', 'list'];

/** The saved view; anything missing, invalid or unreadable means the grid. */
function readView(): ViewMode {
    return readPreference(PREF_KEYS.libraryViewMode, VIEW_MODES, 'grid');
}

/** True while the user types in a field (shortcuts must not hijack those keys). */
function isTypingTarget(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT')
    );
}

function isDialogOpen(): boolean {
    return document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
}

/** Query of one list request; `q` and `sort` are sent only when they are not the default. */
function listParams(page: number, perPage: number, q: string, sort: VideoSort) {
    return {
        page,
        perPage,
        ...(q === '' ? {} : { q }),
        ...(sort === 'newest' ? {} : { sort }),
    };
}

function SkeletonTools() {
    return (
        <div className="video-tools">
            <span className="skeleton-bar skeleton-date" />
            <span className="skeleton-bar skeleton-btn" />
            <span className="skeleton-bar skeleton-btn" />
            <span className="skeleton-bar skeleton-btn" />
        </div>
    );
}

/** Five pill placeholders; their widths vary through nth-child rules in CSS (no inline styles). */
function SkeletonChips() {
    return (
        <span className="skeleton-chips">
            {Array.from({ length: 5 }, (_, index) => (
                <span key={index} className="skeleton-bar skeleton-chip" />
            ))}
        </span>
    );
}

/** Placeholder cards for Grid mode: same columns and card anatomy as the real list. */
function SkeletonGrid({ count }: { count: number }) {
    return (
        <ul className="videos videos-skeleton videos-skeleton-grid" aria-hidden="true">
            {Array.from({ length: count }, (_, index) => (
                <li
                    key={index}
                    className="video-row row-surface video-skeleton video-skeleton-card"
                >
                    <div className="video-open">
                        <div className="video-media">
                            <div className="thumb-frame skeleton-block" />
                        </div>
                        <div className="video-main">
                            <span className="skeleton-bar skeleton-bar-title" />
                            <span className="skeleton-bar skeleton-bar-title skeleton-bar-second" />
                            <SkeletonChips />
                        </div>
                    </div>
                    <SkeletonTools />
                </li>
            ))}
        </ul>
    );
}

/** Placeholder rows for List mode: same header, columns and row look as the real list. */
function SkeletonList({ count }: { count: number }) {
    return (
        <div className="videos-wrap is-list" aria-hidden="true">
            <div className="videos-head">
                <span>Preview</span>
                <span>Title</span>
                <span className="video-status">Status</span>
                <span className="video-created">Created</span>
            </div>
            <ul className="videos videos-list videos-skeleton videos-skeleton-list">
                {Array.from({ length: count }, (_, index) => (
                    <li
                        key={index}
                        className="video-row row-surface video-skeleton video-skeleton-row"
                    >
                        <div className="video-open">
                            <div className="thumb-frame skeleton-block" />
                            <div className="video-main">
                                <span className="skeleton-bar skeleton-bar-title" />
                                <SkeletonChips />
                            </div>
                            <span className="skeleton-bar skeleton-status video-status" />
                            <span className="skeleton-bar skeleton-date video-created" />
                        </div>
                        <div className="video-tools">
                            <span className="skeleton-bar skeleton-btn" />
                            <span className="skeleton-bar skeleton-btn" />
                            <span className="skeleton-bar skeleton-btn" />
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; items: VideoListItem[]; meta: VideoListMeta };

interface TierChipSpec {
    label: string;
    tier: Tier;
    title: string;
    icon: ReactElement;
}

/** The media chips (quality, dimensions and bitrate, tier-coloured; the orientation chip is neutral); shared by the grid card and the list row. */
function TierChips({
    chips,
    orientation = null,
}: {
    chips: ReadonlyArray<TierChipSpec>;
    /** The neutral orientation chip goes right after the dimensions chip. */
    orientation?: VideoOrientation | null;
}) {
    return (
        <>
            {chips.map((chip) => (
                <Fragment key={chip.title}>
                    <TierChip
                        label={chip.label}
                        tier={chip.tier}
                        title={chip.title}
                        icon={chip.icon}
                        decorative
                    />
                    {chip.title === 'Dimensions' && orientation !== null && (
                        <OrientationChip orientation={orientation} decorative />
                    )}
                </Fragment>
            ))}
        </>
    );
}

/** The neutral duration and size chips; shared by the grid card and the list row. */
function MetaChips({ duration, size }: { duration: string; size: string }) {
    return (
        <>
            {duration !== '' && (
                <span className="spec spec-duration num" title="Duration" aria-hidden="true">
                    <ClockIcon />
                    {duration}
                </span>
            )}
            {size !== '' && (
                <span className="spec spec-size num" title="File size" aria-hidden="true">
                    <StorageIcon />
                    {size}
                </span>
            )}
        </>
    );
}

/** "Deleting…" status pill of a row waiting for the server (decorative: the live region announces it). */
function DeletingPill() {
    return (
        <span className="deleting-pill" aria-hidden="true">
            <span className="deleting-spinner" />
            Deleting…
        </span>
    );
}

/** Fade-out of a deleted row (ms); kept in sync with `.is-leaving` in styles.css. */
const LEAVE_MS = 180;

function prefersReducedMotion(): boolean {
    return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

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
    onDelete,
    onSelect,
    deleting,
    leaving,
}: {
    /** The server is deleting this video: the row is inert and shows the "Deleting…" state. */
    deleting: boolean;
    /** The server confirmed the deletion: the row fades out right before it is removed. */
    leaving: boolean;
    onDelete: (video: VideoListItem) => void;
    /** Enters select mode with this video already picked (offered in the item menu). */
    onSelect: (video: VideoListItem) => void;
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
    const fullDate = video.createdAt === null ? '' : formatDateTime(video.createdAt);
    const added = formatDateCompact(video.createdAt);
    const quality = formatQuality(video.width, video.height);
    const size = video.sizeBytes === null ? '' : formatBytes(video.sizeBytes);
    const resolution = formatResolution(video.width, video.height);
    const bitrate = formatBitrate(video.bitrateKbps);
    const fps = formatFps(video.fps);
    // Grid cards and list rows show the same chips in one wrapping area: quality, dimensions
    // (same tier colour as the quality), orientation (neutral), bitrate, duration, size. A missing
    // value has no chip. The upload time is the grid footer caption.
    const allChips: ReadonlyArray<TierChipSpec> = [
        {
            label: quality,
            tier: qualityTier(video.width, video.height),
            title: 'Quality',
            icon: <QualityIcon />,
        },
        {
            label: resolution,
            tier: qualityTier(video.width, video.height) ?? 5,
            title: 'Dimensions',
            icon: <DimensionsIcon orientation={videoOrientation(video.width, video.height)} />,
        },
        {
            label: bitrate,
            tier: bitrateTier(video.bitrateKbps),
            title: 'Bitrate',
            icon: <BitrateIcon />,
        },
    ].filter((chip): chip is TierChipSpec => chip.label !== '');
    // A neutral Horizontal/Vertical chip after the dimensions chip.
    const orientation = resolution !== '' ? videoOrientation(video.width, video.height) : null;
    const hasSummary = allChips.length > 0 || duration !== '' || size !== '';
    const summary = hasSummary ? (
        <span className="visually-hidden">
            {[
                quality,
                duration !== '' ? `Duration ${duration}` : '',
                bitrate,
                fps,
                resolution,
                orientation === null ? '' : orientationLabel(orientation),
                size,
            ]
                .filter((part) => part !== '')
                .join(', ')}
        </span>
    ) : null;
    const thumb = <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />;
    // A ready video needs no chip; its state stays available to assistive technology.
    const status =
        video.status === 'ready' ? (
            <span className="visually-hidden">Ready</span>
        ) : (
            <StatusBadge status={video.status} />
        );
    // Select mode: a native checkbox, visually hidden but focusable; the picked state is drawn on the card.
    const check = selecting ? (
        <input
            type="checkbox"
            className="video-check"
            aria-label={`Select ${video.title}`}
            checked={picked}
            disabled={disabled || deleting}
            onChange={() => onToggle(video.id)}
        />
    ) : null;
    const content =
        view === 'list' ? (
            <>
                {check}
                {thumb}
                <span className="video-main">
                    <span className="video-title" title={video.title}>
                        {video.title}
                    </span>
                    {hasSummary && (
                        <span className="video-chips">
                            <TierChips chips={allChips} orientation={orientation} />
                            <MetaChips duration={duration} size={size} />
                        </span>
                    )}
                </span>
                {/* After the title in the DOM; the chips above are aria-hidden duplicates. */}
                {summary}
                <span className="video-cell video-status">
                    {deleting ? <DeletingPill /> : <StatusBadge status={video.status} />}
                </span>
                <span className="video-cell video-created" title={fullDate || undefined}>
                    {added}
                </span>
            </>
        ) : (
            <>
                <span className="video-media">{thumb}</span>
                <span className="video-main">
                    <span className="video-title" title={video.title}>
                        {video.title}
                    </span>
                    {hasSummary && (
                        <span className="video-chips">
                            <TierChips chips={allChips} orientation={orientation} />
                            <MetaChips duration={duration} size={size} />
                        </span>
                    )}
                </span>
                {/* After the title in the DOM (the accessible name starts with it); the chips above are aria-hidden duplicates. */}
                {summary}
                {status}
                {deleting && <DeletingPill />}
                {check}
            </>
        );

    // Grid footer caption: the compact upload time, plain muted text on the left of the tools row.
    const addedCaption =
        view === 'grid' && added !== '' ? (
            <span className="video-added" title={fullDate}>
                {added}
            </span>
        ) : null;

    const rowClass = [
        'video-row row-surface',
        picked ? 'is-picked' : '',
        deleting ? 'is-deleting' : '',
        leaving ? 'is-leaving' : '',
    ]
        .filter((part) => part !== '')
        .join(' ');

    if (selecting) {
        return (
            <li className={rowClass} aria-busy={deleting ? true : undefined}>
                <label className="video-open">{content}</label>
                {addedCaption !== null && <div className="video-tools">{addedCaption}</div>}
            </li>
        );
    }

    return (
        <li className={rowClass} aria-busy={deleting ? true : undefined}>
            <button
                type="button"
                className="video-open"
                disabled={deleting}
                aria-disabled={deleting ? true : undefined}
                tabIndex={deleting ? -1 : undefined}
                onClick={(event) => onOpen(video, event.currentTarget)}
            >
                {content}
            </button>
            <div className="video-tools">
                {addedCaption}
                <VideoQuickActions
                    title={video.title}
                    busy={quickBusy}
                    disabled={deleting}
                    actions={[
                        ...(video.status === 'ready' ? (['shortcode'] as const) : []),
                        ...(video.thumbnailUrl !== null ? (['thumbnail-url'] as const) : []),
                    ]}
                    onQuick={(action) => onQuick(video, action)}
                    menu={
                        <VideoMenu
                            title={video.title}
                            busy={quickBusy}
                            disabled={deleting}
                            ready={video.status === 'ready'}
                            onQuick={(action) => onQuick(video, action)}
                            onOpen={(opener) => onOpen(video, opener)}
                            onDelete={() => onDelete(video)}
                            onSelect={() => onSelect(video)}
                        />
                    }
                />
            </div>
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
    const [pageSize, setPageSize] = useState<number>(() =>
        readPreference(PREF_KEYS.libraryPerPage, PAGE_SIZES, DEFAULT_PAGE_SIZE),
    );
    const [sort, setSort] = useState<VideoSort>('newest');
    const [confirmDelete, setConfirmDelete] = useState<VideoListItem | null>(null);
    const [reloads, setReloads] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    // A quiet reload of the query on screen: the items stay, only the Refresh icon turns.
    const [refreshing, setRefreshing] = useState(false);
    const latest = useRef(0);
    // The query whose items are on screen (null until a first answer): a reload of the same query
    // keeps them, any other query shows the skeleton.
    const shownKey = useRef<string | null>(null);
    const loadKind = useRef<Load['kind']>('loading');
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
    // Videos the server is deleting (WordPress-style: a row stays, marked, until the server confirms).
    const [deletingIds, setDeletingIds] = useState<ReadonlySet<number>>(new Set());
    // Rows that fade out right before they are removed locally (single delete, after confirmation).
    const [leavingIds, setLeavingIds] = useState<ReadonlySet<number>>(new Set());
    const [announcement, setAnnouncement] = useState('');
    // Synchronous mirror of `deletingIds` (blocks re-entry before the re-render).
    const deletingRef = useRef(new Set<number>());
    // Bulk ids whose markers wait for the quiet reload answer (the bulk API has no per-id result).
    const awaitingReload = useRef(new Set<number>());
    const mounted = useRef(true);
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
    const pendingFocus = useRef<'leave' | 'enter' | 'bulk' | 'heading' | null>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const bulkRef = useRef<HTMLButtonElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
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
                pendingFocus.current = 'leave';
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
        if (pendingFocus.current === 'leave' && !selectMode) {
            // The Select entry lives in each item menu (gone after leaving): focus the region heading.
            pendingFocus.current = null;
            headingRef.current?.focus();
        } else if (pendingFocus.current === 'enter' && selectMode) {
            pendingFocus.current = null;
            cancelRef.current?.focus();
        } else if (pendingFocus.current === 'bulk' && !bulkBusy && !confirmBulk) {
            pendingFocus.current = null;
            bulkRef.current?.focus();
        }
    });

    useEffect(() => {
        mounted.current = true;

        const pendingTimers = timers.current;

        return () => {
            mounted.current = false;
            pendingTimers.forEach((timer) => clearTimeout(timer));
            pendingTimers.clear();
        };
    }, []);

    /** Marks videos as deleting (or clears them); no state update after unmount. */
    function setDeleting(ids: readonly number[], on: boolean): void {
        ids.forEach((id) => {
            if (on) deletingRef.current.add(id);
            else deletingRef.current.delete(id);
        });

        if (mounted.current) setDeletingIds(new Set(deletingRef.current));
    }

    /**
     * Called by a list answer that is the latest: the bulk markers it covers are cleared (the
     * rows that were deleted are gone from the list, the others return to normal). The ids stay
     * in `awaitingReload` until a latest answer clears them, so a superseded request never
     * leaves a stale marker.
     */
    function releaseAwaiting(covered: readonly number[]): void {
        if (covered.length === 0) return;

        covered.forEach((id) => awaitingReload.current.delete(id));
        setDeleting(covered, false);
    }

    useEffect(() => {
        // A newer request wins: answers of older ones are ignored.
        const request = ++latest.current;
        const params = listParams(page, pageSize, search, sort);

        const key = JSON.stringify(params);
        const quiet = loadKind.current === 'ready' && shownKey.current === key;
        const covered = [...awaitingReload.current];

        if (quiet) setRefreshing(true);
        else {
            setRefreshing(false);
            setLoad({ kind: 'loading' });
        }

        if (page === 1 && search === '') setStale(false);

        function fail(message: string): void {
            if (request !== latest.current) return;

            setRefreshing(false);
            releaseAwaiting(covered);

            if (quiet) toast.show('error', message);
            else setLoad({ kind: 'error', message });
        }

        api.videos
            .list(params)
            .then((result) => {
                if (request !== latest.current) return;

                if (!result.ok) {
                    fail(result.error);

                    return;
                }

                shownKey.current = key;
                setRefreshing(false);
                setLoad({ kind: 'ready', items: result.data, meta: result.meta });
                releaseAwaiting(covered);
            })
            .catch(() => fail(GENERIC_ERROR));
        // `toast` is a stable context value; the query inputs and `reloads` drive the fetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, search, page, pageSize, sort, reloads]);

    // Ignore an answer that arrives after the screen is gone.
    useEffect(
        () => () => {
            latest.current += 1;
        },
        [],
    );

    const refresh = useCallback(() => setReloads((count) => count + 1), []);

    // The latest view state, read by the job listener below (which is subscribed only once).
    const view = useRef({
        page,
        search,
        selected,
        kind: load.kind,
        pageSize,
        sort,
    });

    loadKind.current = load.kind;
    view.current = {
        page,
        search,
        selected,
        kind: load.kind,
        pageSize,
        sort,
    };

    // A job that newly becomes `done` adds a video at the top of the list. This screen is
    // unmounted while another tab is active, so it loads fresh data when the tab is opened again.
    useJobFinished(() => {
        const now = view.current;
        // A new video shows at the top only for the default order.
        const atTop = now.page === 1 && now.search === '' && now.sort === 'newest';

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
        const covered = [...awaitingReload.current];

        api.videos
            .list(listParams(1, now.pageSize, '', 'newest'))
            .then((result) => {
                if (request === latest.current && result.ok) {
                    shownKey.current = JSON.stringify(listParams(1, now.pageSize, '', 'newest'));
                    setLoad({ kind: 'ready', items: result.data, meta: result.meta });
                    releaseAwaiting(covered);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                if (request === latest.current) setRefreshing(false);
            });
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
     * The custom image changed. The list thumbnail is always the generated one, so only the
     * custom-image flag of the row needs updating (no reload).
     */
    function onImageChanged(video: VideoDetail): void {
        setLoad((current) =>
            current.kind === 'ready'
                ? {
                      ...current,
                      items: current.items.map((item) =>
                          item.id === video.id
                              ? { ...item, hasCustomImage: video.hasCustomImage }
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

    function chooseSort(next: VideoSort): void {
        setSort(next);
        setPage(1);
    }

    function choosePageSize(next: number): void {
        setPageSize(next);
        setPage(1);
        writePreference(PREF_KEYS.libraryPerPage, next);
    }

    function askDelete(video: VideoListItem): void {
        setConfirmDelete(video);
    }

    /**
     * Deletes one video from its card menu (same server call and messages as the detail page).
     * The row stays, marked "Deleting…", until the server answers; only a confirmed deletion
     * removes it (after a short fade). Any other outcome returns the row to normal.
     */
    function deleteOne(): void {
        const video = confirmDelete;

        if (video === null) return;

        setConfirmDelete(null);

        // Re-entry: a video already being deleted is not deleted twice.
        if (deletingRef.current.has(video.id)) return;

        setDeleting([video.id], true);
        setAnnouncement(`Deleting ${video.title}…`);

        let removed = false;

        api.videos
            .delete(video.id)
            .then((result) => {
                if (!result.ok) toast.show('error', result.error);
                else if (result.status === 'deleted') {
                    removed = true;
                    toast.show('success', result.message);
                    if (mounted.current) setAnnouncement(`Deleted ${video.title}`);
                    removeRow(video.id);
                } else if (result.status === 'skipped') {
                    toast.show('info', 'The video is still processing; try again later.');
                } else toast.show('error', result.message);
            })
            .catch(() => toast.show('error', GENERIC_ERROR))
            .finally(() => {
                // A confirmed deletion clears its marker when the row is removed.
                if (!removed) {
                    setDeleting([video.id], false);
                    if (mounted.current) setAnnouncement('');
                }
            });
    }

    /** The server confirmed: fade the row out, drop it from the list, then reload quietly. */
    function removeRow(id: number): void {
        const finish = (): void => {
            if (!mounted.current) return;

            setLoad((current) =>
                current.kind === 'ready'
                    ? { ...current, items: current.items.filter((item) => item.id !== id) }
                    : current,
            );
            setLeavingIds((current) => {
                const next = new Set(current);

                next.delete(id);

                return next;
            });
            setPicked((current) => {
                const next = new Set(current);

                next.delete(id);

                return next;
            });
            setDeleting([id], false);
            reloadAfterRemoval(1);
        };

        if (!mounted.current) return;

        if (prefersReducedMotion()) {
            finish();

            return;
        }

        setLeavingIds((current) => new Set(current).add(id));

        // The timer (not transitionend) guarantees the row always unmounts.
        const timer = setTimeout(() => {
            timers.current.delete(timer);
            finish();
        }, LEAVE_MS + 40);

        timers.current.add(timer);
    }

    function chooseView(next: ViewMode): void {
        setViewMode(next);
        writePreference(PREF_KEYS.libraryViewMode, next);
    }

    /** Item menu "Select": enters select mode with that video already picked. */
    function startSelecting(video: VideoListItem): void {
        pendingFocus.current = 'enter';
        setSelectMode(true);
        setPicked(new Set([video.id]));
    }

    function leaveSelectMode(): void {
        pendingFocus.current = 'leave';
        setSelectMode(false);
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
    const allPicked = items.length > 0 && pickedIds.length === items.length;

    // Shortcuts: "/" focuses the search field; Ctrl/Cmd+A in select mode picks the whole page.
    // Neither works while typing in a field, with a dialog open, or on the video detail page.
    const canPickAll = selectMode && !bulkBusy && items.length > 0;
    const pageIdsKey = items.map((item) => item.id).join(',');

    useEffect(() => {
        if (isOpen) return;

        function onKeyDown(event: KeyboardEvent): void {
            if (event.defaultPrevented || isTypingTarget(event.target) || isDialogOpen()) return;

            if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                searchRef.current?.focus();
            } else if (
                canPickAll &&
                event.key.toLowerCase() === 'a' &&
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey
            ) {
                event.preventDefault();
                setPicked(new Set(pageIdsKey.split(',').map(Number)));
            }
        }

        document.addEventListener('keydown', onKeyDown);

        return () => document.removeEventListener('keydown', onKeyDown);
    }, [isOpen, canPickAll, pageIdsKey]);

    function deleteSelected(): void {
        const ids = pickedIds.filter((id) => !deletingRef.current.has(id));

        setConfirmBulk(false);

        if (ids.length === 0) return;

        setBulkBusy(true);
        setDeleting(ids, true);
        setAnnouncement(`Deleting ${plural(ids.length, 'video')}…`);

        // True once the request answered: the markers then wait for the reload answer.
        let handedOver = false;

        api.videos
            .bulkDelete(ids)
            .then((result) => {
                if (!result.ok) {
                    toast.show('error', result.error);
                    pendingFocus.current = 'bulk';

                    return;
                }

                handedOver = true;
                ids.forEach((id) => awaitingReload.current.add(id));
                toast.show(
                    result.failed > 0 ? 'error' : result.deleted > 0 ? 'success' : 'info',
                    result.message,
                );
                pendingFocus.current = 'leave';

                if (!mounted.current) return;

                setSelectMode(false);
                setPicked(new Set());
                reloadAfterRemoval(result.deleted);
            })
            .catch(() => {
                toast.show('error', GENERIC_ERROR);
                pendingFocus.current = 'bulk';
            })
            .finally(() => {
                if (!handedOver) setDeleting(ids, false);
                if (mounted.current) {
                    setBulkBusy(false);
                    if (!handedOver) setAnnouncement('');
                }
            });
    }

    function showNewVideos(): void {
        setPage(1);
        refresh();
    }

    /** The search term only changes on submit (button or Enter); it always goes back to page 1. */
    function applySearch(term: string): void {
        setSearch(term);
        setPage(1);
    }

    function submitSearch(event: FormEvent): void {
        event.preventDefault();
        applySearch(input.trim());
    }

    function clearSearch(): void {
        setInput('');
        applySearch('');
        searchRef.current?.focus();
    }

    function onSearch(event: ChangeEvent<HTMLInputElement>): void {
        setInput(event.target.value);
    }

    const meta = load.kind === 'ready' ? load.meta : null;
    // Two identical pagers (above and below the list) share the same state and handlers.
    const pager = (label: string, value: VideoListMeta) => (
        <Pagination
            label={label}
            page={value.page}
            lastPage={value.lastPage}
            total={value.total}
            onPageChange={changePage}
        />
    );
    const pagerTop = meta === null ? null : pager('Pagination, top', meta);
    const pagerBottom = meta === null ? null : pager('Pagination, bottom', meta);

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
                <div className="library-toolbar">
                    <div className="library-title">
                        {/* The visible page title is the top bar's; this heading names the region. */}
                        <h2
                            id="library-heading"
                            ref={headingRef}
                            tabIndex={-1}
                            className="visually-hidden"
                        >
                            Library
                        </h2>
                    </div>
                    <form className="library-search" role="search" onSubmit={submitSearch}>
                        <label htmlFor="library-search" className="visually-hidden">
                            Search videos
                        </label>
                        <div className="search-field">
                            <input
                                ref={searchRef}
                                id="library-search"
                                type="text"
                                maxLength={100}
                                value={input}
                                placeholder="Search by title"
                                title="Press / to search"
                                aria-keyshortcuts="/"
                                onChange={onSearch}
                            />
                            {input !== '' && (
                                <button
                                    type="button"
                                    className="btn btn-text search-clear"
                                    aria-label="Clear search"
                                    title="Clear search"
                                    onClick={clearSearch}
                                >
                                    <CloseIcon />
                                </button>
                            )}
                        </div>
                        <button type="submit" className="btn btn-primary search-submit">
                            <SearchIcon />
                            Search
                        </button>
                    </form>
                    <div className="library-sort">
                        <label htmlFor="library-sort" className="visually-hidden">
                            Sort by
                        </label>
                        <span className="select-prefix" aria-hidden="true">
                            Sort:
                        </span>
                        <SelectBox
                            id="library-sort"
                            className="select-inline"
                            value={sort}
                            onChange={(event) => chooseSort(event.target.value as VideoSort)}
                        >
                            {VIDEO_SORTS.map((value) => (
                                <option key={value} value={value}>
                                    {SORT_LABELS[value]}
                                </option>
                            ))}
                        </SelectBox>
                    </div>
                    <PerPageSelect
                        value={pageSize}
                        options={PAGE_SIZES}
                        onChange={choosePageSize}
                    />
                    <div className="library-actions">
                        <div className="segmented" role="group" aria-label="View">
                            <button
                                type="button"
                                className="btn btn-sm"
                                aria-label="Grid"
                                title="Grid"
                                aria-pressed={viewMode === 'grid'}
                                onClick={() => chooseView('grid')}
                            >
                                <GridViewIcon />
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm"
                                aria-label="List"
                                title="List"
                                aria-pressed={viewMode === 'list'}
                                onClick={() => chooseView('list')}
                            >
                                <ListViewIcon />
                            </button>
                        </div>
                        <RefreshButton
                            busy={load.kind === 'loading' || refreshing}
                            onClick={refresh}
                            className="library-refresh"
                        />
                    </div>
                </div>

                {/* One polite live region for the delete flow (decorative pills stay aria-hidden). */}
                <p className="visually-hidden" aria-live="polite" aria-atomic="true">
                    {announcement}
                </p>

                {stale && (
                    <p className="library-notice" role="status">
                        <span>New videos are available.</span>
                        <button type="button" className="btn btn-sm" onClick={showNewVideos}>
                            Refresh
                        </button>
                    </p>
                )}

                {/* Upload sits at the start of the top pager row, so it stays available while
                    the list is loading, empty or failed (no pager then). */}
                <div className="pager-row">
                    <UploadVideosButton />
                    {pagerTop}
                </div>

                {selectMode && (
                    <div className="library-tools" role="toolbar" aria-label="Selection">
                        <span className="library-count" role="status">
                            {pickedIds.length} selected
                        </span>
                        <button
                            type="button"
                            className={
                                allPicked
                                    ? 'btn btn-sm btn-select-toggle is-all'
                                    : pickedIds.length > 0
                                      ? 'btn btn-sm btn-select-toggle is-some'
                                      : 'btn btn-sm btn-select-toggle'
                            }
                            aria-label={
                                allPicked ? 'Unselect all on this page' : 'Select all on this page'
                            }
                            disabled={bulkBusy || items.length === 0}
                            onClick={() =>
                                setPicked(
                                    allPicked ? new Set() : new Set(items.map((item) => item.id)),
                                )
                            }
                        >
                            {allPicked ? 'Unselect all' : 'Select all'}
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
                        <button
                            ref={cancelRef}
                            type="button"
                            className="btn btn-sm"
                            aria-label="Exit select mode"
                            disabled={bulkBusy}
                            onClick={leaveSelectMode}
                        >
                            Cancel
                        </button>
                    </div>
                )}

                {load.kind === 'loading' && (
                    <>
                        <p className="visually-hidden" role="status" aria-busy="true">
                            {'Loading…'}
                        </p>
                        {viewMode === 'list' ? (
                            <SkeletonList count={Math.min(pageSize, 6)} />
                        ) : (
                            <SkeletonGrid count={Math.min(pageSize, 8)} />
                        )}
                    </>
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
                    <EmptyState
                        icon={search !== '' ? <SearchIcon /> : <VideoFileIcon />}
                        title={search !== '' ? 'No videos match your search' : 'No videos yet'}
                    />
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
                                <span className="video-status">Status</span>
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
                                    onDelete={askDelete}
                                    onSelect={startSelecting}
                                    deleting={deletingIds.has(video.id)}
                                    leaving={leavingIds.has(video.id)}
                                />
                            ))}
                        </ul>
                    </div>
                )}

                {pagerBottom}
            </div>

            {confirmDelete !== null && (
                <ConfirmDialog
                    title="Delete video"
                    message={
                        <>
                            Delete this video? This removes it from the site and may remove its
                            files from storage. This cannot be undone.
                            <br />
                            <strong>{confirmDelete.title}</strong>
                        </>
                    }
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    danger
                    onConfirm={deleteOne}
                    onCancel={() => setConfirmDelete(null)}
                />
            )}

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
