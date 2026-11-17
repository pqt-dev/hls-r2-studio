import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { VideoListItem, VideoListMeta } from '../../../shared/ipc';
import { SearchIcon } from '../components/icons';
import { formatDate, formatDuration, plural } from '../lib/format';
import { useApp } from '../state/AppProvider';

const SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 24;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; items: VideoListItem[]; meta: VideoListMeta };

const STATUS_LABELS: Record<string, { label: string; chip: string }> = {
    ready: { label: 'Ready', chip: 'chip-done' },
    processing: { label: 'Processing', chip: 'chip-running' },
    pending: { label: 'Pending', chip: '' },
    failed: { label: 'Failed', chip: 'chip-failed' },
};

function StatusBadge({ status }: { status: string }) {
    const known = Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined;
    const { label, chip } = known ?? { label: 'Unknown', chip: '' };

    return <span className={`chip ${chip}`.trim()}>{label}</span>;
}

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

function VideoRow({ video }: { video: VideoListItem }) {
    const duration = formatDuration(video.duration);
    const created = formatDate(video.createdAt);

    return (
        <li className="video-row">
            <Thumbnail key={video.thumbnailUrl ?? ''} url={video.thumbnailUrl} />
            <div className="video-main">
                <p className="video-title" title={video.title}>
                    {video.title}
                </p>
                <p className="video-meta">
                    {duration !== '' && <span className="num">{duration}</span>}
                    {created !== '' && <span>{created}</span>}
                </p>
            </div>
            <StatusBadge status={video.status} />
        </li>
    );
}

export function LibraryScreen() {
    const { api } = useApp();
    const [input, setInput] = useState('');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [reloads, setReloads] = useState(0);
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    const latest = useRef(0);

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

    function onSearch(event: ChangeEvent<HTMLInputElement>): void {
        setInput(event.target.value);
    }

    const meta = load.kind === 'ready' ? load.meta : null;

    return (
        <section className="library" aria-labelledby="library-heading">
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
                        <VideoRow key={video.id} video={video} />
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
        </section>
    );
}
