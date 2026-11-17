import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoDetail, VideoLinkKind } from '../../../shared/ipc';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { StatusBadge } from './videoStatus';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

type Load =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; video: VideoDetail };

/**
 * True only for an https URL without credentials whose host (and port) is the signed-in site.
 * The CSP `frame-src` allows exactly this origin, so this check and the CSP agree.
 */
export function isSiteEmbedUrl(embedUrl: string | null, siteUrl: string | undefined): boolean {
    if (embedUrl === null || siteUrl === undefined || siteUrl === '') return false;

    try {
        const embed = new URL(embedUrl);
        const site = new URL(siteUrl);

        return (
            embed.protocol === 'https:' &&
            site.protocol === 'https:' &&
            embed.username === '' &&
            embed.password === '' &&
            embed.host !== '' &&
            embed.host === site.host
        );
    } catch {
        return false;
    }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="kv-row">
            <dt>{label}</dt>
            <dd>{children}</dd>
        </div>
    );
}

function statusExplanation(video: VideoDetail): string {
    switch (video.status) {
        case 'pending':
            return 'This video is waiting to be processed. The preview is available once it is ready.';
        case 'processing':
            return 'This video is still being processed. The preview is available once it is ready.';
        case 'failed':
            return 'Processing failed, so there is nothing to preview. See the error details.';
        default:
            return 'This video is not ready yet, so the preview is not available.';
    }
}

function Poster({ url }: { url: string | null }) {
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

interface Actions {
    busy: boolean;
    copy: (kind: VideoLinkKind) => void;
    open: () => void;
}

function PreviewCard({
    video,
    siteUrl,
    actions,
}: {
    video: VideoDetail;
    siteUrl: string | undefined;
    actions: Actions;
}) {
    // The iframe is never created until the user asks for it.
    const [loaded, setLoaded] = useState(false);
    const poster = video.customImageUrl ?? video.thumbnailUrl;
    const embeddable = isSiteEmbedUrl(video.embedUrl, siteUrl);

    let body: React.ReactNode;

    if (video.status !== 'ready') {
        body = (
            <>
                <Poster key={poster ?? ''} url={poster} />
                <p className="muted detail-note">{statusExplanation(video)}</p>
            </>
        );
    } else if (!embeddable || video.embedUrl === null) {
        body = (
            <>
                <Poster key={poster ?? ''} url={poster} />
                <div className="detail-note">
                    <p>Preview unavailable</p>
                    {video.embedUrl !== null && (
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={actions.busy}
                            onClick={actions.open}
                        >
                            Open in browser
                        </button>
                    )}
                </div>
            </>
        );
    } else if (!loaded) {
        body = (
            <div className="preview-poster">
                <Poster key={poster ?? ''} url={poster} />
                <button
                    type="button"
                    className="btn btn-primary preview-load"
                    onClick={() => setLoaded(true)}
                >
                    Load preview
                </button>
            </div>
        );
    } else {
        body = (
            <iframe
                className="preview-frame"
                title={`Preview of ${video.title}`}
                src={video.embedUrl}
                sandbox="allow-scripts allow-same-origin allow-presentation"
                allow="fullscreen"
                referrerPolicy="no-referrer"
                loading="lazy"
            />
        );
    }

    return (
        <section className="card detail-card" aria-label="Preview">
            <h3>Preview</h3>
            {body}
        </section>
    );
}

function StoryboardsCard({ video }: { video: VideoDetail }) {
    const entries = Object.entries(video.storyboards).filter(
        (entry): entry is [string, (typeof entry)[1] & { url: string }] => entry[1].url !== null,
    );

    if (entries.length === 0) return null;

    return (
        <section className="card detail-card" aria-label="Storyboards">
            <h3>Storyboards</h3>
            {entries.map(([key, board]) => {
                const parts = [
                    board.columns !== null ? `${board.columns} columns` : null,
                    board.count !== null ? `${board.count} frames` : null,
                ].filter((part) => part !== null);

                return (
                    <figure key={key} className="storyboard">
                        <img src={board.url} alt={`Storyboard ${key}`} loading="lazy" />
                        <figcaption className="muted">{parts.join(' · ')}</figcaption>
                    </figure>
                );
            })}
        </section>
    );
}

function InfoCard({ video }: { video: VideoDetail }) {
    const duration = formatDuration(video.duration);
    const created = video.createdAt === null ? '' : formatDateTime(video.createdAt);
    const updated = video.updatedAt === null ? '' : formatDateTime(video.updatedAt);
    const resolution =
        video.outputWidth !== null && video.outputHeight !== null
            ? `${video.outputWidth}x${video.outputHeight}`
            : '';

    return (
        <section className="card detail-card" aria-label="Information">
            <h3>Information</h3>
            <dl className="kv">
                <Row label="Title">{video.title}</Row>
                <Row label="Status">
                    <StatusBadge status={video.status} />
                </Row>
                {video.status !== 'ready' && video.stage !== null && (
                    <Row label="Stage">{video.stage}</Row>
                )}
                {video.status !== 'ready' && video.progress !== null && (
                    <Row label="Progress">
                        <progress
                            value={video.progress}
                            max={100}
                            aria-label="Processing progress"
                        />
                        <span className="num">{video.progress}%</span>
                    </Row>
                )}
                {duration !== '' && (
                    <Row label="Duration">
                        <span className="num">{duration}</span>
                    </Row>
                )}
                {resolution !== '' && <Row label="Resolution">{resolution}</Row>}
                {video.outputFps !== null && (
                    <Row label="Frame rate">{`${Math.round(video.outputFps * 100) / 100} fps`}</Row>
                )}
                {video.outputBitrateKbps !== null && (
                    <Row label="Bitrate">{`${video.outputBitrateKbps} kbps`}</Row>
                )}
                {video.outputCodec !== null && <Row label="Codec">{video.outputCodec}</Row>}
                {video.originalFilename !== null && (
                    <Row label="Original file">{video.originalFilename}</Row>
                )}
                {video.originalSizeBytes !== null && (
                    <Row label="Original size">{formatBytes(video.originalSizeBytes)}</Row>
                )}
                <Row label="Public ID">
                    <span className="mono">{video.publicId}</span>
                </Row>
                {created !== '' && <Row label="Created">{created}</Row>}
                {updated !== '' && <Row label="Updated">{updated}</Row>}
            </dl>
        </section>
    );
}

function ErrorCard({ video }: { video: VideoDetail }) {
    if (video.status !== 'failed') return null;

    const failedAt = video.error?.failedAt == null ? '' : formatDateTime(video.error.failedAt);

    return (
        <section className="card detail-card detail-error" aria-label="Processing error">
            <h3>Processing failed</h3>
            <p>{video.error?.message ?? 'The video could not be processed.'}</p>
            {failedAt !== '' && <p className="muted">{failedAt}</p>}
            {video.error?.detail != null && video.error.detail !== '' && (
                <pre className="detail-error-text">{video.error.detail}</pre>
            )}
        </section>
    );
}

function ActionsCard({ video, actions }: { video: VideoDetail; actions: Actions }) {
    return (
        <section className="card detail-card" aria-label="Actions">
            <h3>Actions</h3>
            <div className="row row-wrap detail-actions">
                {video.embedUrl !== null && (
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={actions.busy}
                        onClick={() => actions.copy('embed-url')}
                    >
                        Copy embed URL
                    </button>
                )}
                {video.playlistUrl !== null && (
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={actions.busy}
                        onClick={() => actions.copy('playlist-url')}
                    >
                        Copy playlist URL
                    </button>
                )}
                {video.embedUrl !== null && (
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={actions.busy}
                        onClick={actions.open}
                    >
                        Open in browser
                    </button>
                )}
            </div>
        </section>
    );
}

export function VideoDetailPage({
    id,
    fallbackTitle,
    onBack,
}: {
    id: number;
    fallbackTitle: string;
    onBack: () => void;
}) {
    const { api, auth, settings } = useApp();
    const toast = useToast();
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    const [reloads, setReloads] = useState(0);
    const [busy, setBusy] = useState(false);
    const latest = useRef(0);
    const backRef = useRef<HTMLButtonElement>(null);
    const siteUrl = auth.siteUrl ?? settings?.siteUrl;

    useEffect(() => {
        backRef.current?.focus();
    }, []);

    useEffect(() => {
        // A newer request wins: answers of older ones are ignored.
        const request = ++latest.current;

        setLoad({ kind: 'loading' });

        api.videos
            .get(id)
            .then((result) => {
                if (request !== latest.current) return;

                setLoad(
                    result.ok
                        ? { kind: 'ready', video: result.video }
                        : { kind: 'error', message: result.error },
                );
            })
            .catch(() => {
                if (request === latest.current) setLoad({ kind: 'error', message: GENERIC_ERROR });
            });
    }, [api, id, reloads]);

    // Ignore an answer that arrives after the page is gone.
    useEffect(
        () => () => {
            latest.current += 1;
        },
        [],
    );

    const refresh = useCallback(() => setReloads((count) => count + 1), []);

    const run = useCallback(
        (action: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) => {
            setBusy(true);
            action()
                .then((result) => {
                    if (result.ok) toast.show('success', success);
                    else toast.show('error', result.error);
                })
                .catch(() => toast.show('error', GENERIC_ERROR))
                .finally(() => setBusy(false));
        },
        [toast],
    );

    const actions: Actions = {
        busy,
        copy: (kind) =>
            run(
                () => api.videos.copyLink(id, kind),
                kind === 'embed-url' ? 'Embed URL copied.' : 'Playlist URL copied.',
            ),
        open: () => run(() => api.videos.openEmbed(id), 'Opened in your browser.'),
    };

    const title = load.kind === 'ready' ? load.video.title : fallbackTitle;

    return (
        <section className="detail" aria-label="Video details">
            <div className="detail-head">
                <button ref={backRef} type="button" className="btn btn-sm" onClick={onBack}>
                    {'← Library'}
                </button>
                <nav aria-label="Breadcrumb" className="breadcrumb">
                    <ol>
                        <li>Library</li>
                        <li aria-current="page" title={title}>
                            {title}
                        </li>
                    </ol>
                </nav>
                <button type="button" className="btn btn-sm" onClick={refresh}>
                    Refresh
                </button>
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

            {load.kind === 'ready' && (
                <div className="detail-grid">
                    <div className="detail-col">
                        <PreviewCard
                            key={load.video.embedUrl ?? ''}
                            video={load.video}
                            siteUrl={siteUrl}
                            actions={actions}
                        />
                        <StoryboardsCard video={load.video} />
                    </div>
                    <div className="detail-col">
                        <ErrorCard video={load.video} />
                        <InfoCard video={load.video} />
                        <ActionsCard video={load.video} actions={actions} />
                    </div>
                </div>
            )}
        </section>
    );
}
