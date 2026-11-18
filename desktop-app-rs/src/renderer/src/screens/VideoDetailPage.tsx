import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoDetail, VideoLinkKind } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import {
    LinkIcon,
    OpenExternalIcon,
    PencilIcon,
    PlaylistIcon,
    TrashIcon,
} from '../components/icons';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { StatusBadge } from './videoStatus';

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const MAX_TITLE_CHARS = 255;
const STILL_PROCESSING = 'The video is still processing; try again later.';
const REFRESH_FAILED =
    'The change was saved, but the page could not be refreshed. Use Refresh to reload it.';
const DELETE_BLOCKED = 'A video that is pending or processing cannot be deleted yet.';

/** Same rule as the main process and the site: 1..255 characters (not bytes), no control chars. */
export function titleProblem(raw: string): string | null {
    const title = raw.trim();

    if (title === '') return 'Title is required.';
    if ([...title].length > MAX_TITLE_CHARS) {
        return `Title is too long (${MAX_TITLE_CHARS} characters at most).`;
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) return 'Title is invalid.';

    return null;
}

interface Editing {
    draft: string;
    error: string | null;
    saving: boolean;
}

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
    renaming: boolean;
    rename: () => void;
    askDelete: () => void;
    renameRef: React.RefObject<HTMLButtonElement | null>;
    deleteRef: React.RefObject<HTMLButtonElement | null>;
    uploading: boolean;
    chooseImage: () => void;
    askRemoveImage: () => void;
    chooseRef: React.RefObject<HTMLButtonElement | null>;
    removeImageRef: React.RefObject<HTMLButtonElement | null>;
}

/** Current thumbnail (the custom one wins) with a "Custom" chip, and the change/remove buttons. */
function ThumbnailCard({ video, actions }: { video: VideoDetail; actions: Actions }) {
    const poster = video.customImageUrl ?? video.thumbnailUrl;

    return (
        <section className="card detail-card" aria-label="Thumbnail">
            <div className="row detail-card-head">
                <h3>Thumbnail</h3>
                {video.hasCustomImage && <span className="chip">Custom</span>}
            </div>
            <Poster key={poster ?? ''} url={poster} />
            <div className="row row-wrap detail-actions detail-note">
                <button
                    ref={actions.chooseRef}
                    type="button"
                    className="btn btn-sm btn-accent-create"
                    disabled={actions.busy}
                    onClick={actions.chooseImage}
                >
                    {actions.uploading ? 'Uploading…' : 'Choose image…'}
                </button>
                {video.hasCustomImage && (
                    <button
                        ref={actions.removeImageRef}
                        type="button"
                        className="btn btn-sm btn-accent-danger"
                        disabled={actions.busy}
                        onClick={actions.askRemoveImage}
                    >
                        Remove custom image
                    </button>
                )}
            </div>
            <p className="muted detail-note">JPG, PNG or WebP, up to 5 MB.</p>
        </section>
    );
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
                            className="btn btn-sm btn-accent-share"
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
                <button type="button" className="btn preview-load" onClick={() => setLoaded(true)}>
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

function TitleEditor({
    editing,
    onChange,
    onSave,
    onCancel,
}: {
    editing: Editing;
    onChange: (draft: string) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const errorId = 'video-title-error';

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);

    return (
        <form
            className="title-edit"
            onSubmit={(event) => {
                event.preventDefault();
                onSave();
            }}
        >
            <input
                ref={input}
                type="text"
                aria-label="Title"
                aria-invalid={editing.error !== null}
                aria-describedby={editing.error === null ? undefined : errorId}
                value={editing.draft}
                disabled={editing.saving}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        // Cancels the edit only; the page itself stays open.
                        event.preventDefault();
                        if (!editing.saving) onCancel();
                    }
                }}
            />
            <div className="row title-edit-actions">
                <button type="submit" className="btn btn-sm btn-primary" disabled={editing.saving}>
                    Save
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    disabled={editing.saving}
                    onClick={onCancel}
                >
                    Cancel
                </button>
            </div>
            {editing.error !== null && (
                <p id={errorId} role="alert" className="form-error">
                    {editing.error}
                </p>
            )}
        </form>
    );
}

function InfoCard({ video, titleEditor }: { video: VideoDetail; titleEditor: React.ReactNode }) {
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
                <Row label="Title">{titleEditor ?? video.title}</Row>
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

/** True when the site would skip the video if it were deleted (pending or processing). */
function deleteBlocked(video: VideoDetail): boolean {
    return video.status === 'pending' || video.status === 'processing';
}

/**
 * Sticky action bar under the title row, grouped by meaning: share/open (teal), edit (amber),
 * then a spacer and the destructive Delete (red) at the right end. Below the narrow breakpoint the
 * labels collapse to icons (the accessible names stay).
 */
function ActionBar({ video, actions }: { video: VideoDetail; actions: Actions }) {
    const blocked = deleteBlocked(video);

    return (
        <div className="detail-actionbar" role="toolbar" aria-label="Video actions">
            {video.embedUrl !== null && (
                <button
                    type="button"
                    className="btn btn-sm btn-accent-share"
                    title="Copy embed URL"
                    disabled={actions.busy}
                    onClick={() => actions.copy('embed-url')}
                >
                    <LinkIcon />
                    <span className="btn-label">Copy embed URL</span>
                </button>
            )}
            {video.playlistUrl !== null && (
                <button
                    type="button"
                    className="btn btn-sm btn-accent-share"
                    title="Copy playlist URL"
                    disabled={actions.busy}
                    onClick={() => actions.copy('playlist-url')}
                >
                    <PlaylistIcon />
                    <span className="btn-label">Copy playlist URL</span>
                </button>
            )}
            {video.embedUrl !== null && (
                <button
                    type="button"
                    className="btn btn-sm btn-accent-share"
                    title="Open in browser"
                    disabled={actions.busy}
                    onClick={actions.open}
                >
                    <OpenExternalIcon />
                    <span className="btn-label">Open in browser</span>
                </button>
            )}
            <button
                ref={actions.renameRef}
                type="button"
                className="btn btn-sm btn-accent-edit"
                title="Rename"
                disabled={actions.busy || actions.renaming}
                onClick={actions.rename}
            >
                <PencilIcon />
                <span className="btn-label">Rename</span>
            </button>
            <span className="action-spacer" aria-hidden="true" />
            <button
                ref={actions.deleteRef}
                type="button"
                className="btn btn-sm btn-accent-danger"
                title={blocked ? DELETE_BLOCKED : 'Delete'}
                aria-describedby={blocked ? 'video-delete-blocked' : undefined}
                disabled={actions.busy || blocked}
                onClick={actions.askDelete}
            >
                <TrashIcon />
                <span className="btn-label">Delete</span>
            </button>
        </div>
    );
}

export function VideoDetailPage({
    id,
    fallbackTitle,
    onBack,
    onRenamed,
    onDeleted,
    onImageChanged,
}: {
    id: number;
    fallbackTitle: string;
    onBack: () => void;
    /** The new title, so the list behind this page can show it without reloading. */
    onRenamed?: (id: number, title: string) => void;
    /** The video was deleted: the page closes and the list reloads. */
    onDeleted?: (id: number) => void;
    /** The thumbnail changed: the fresh detail, so the list row can show it without reloading. */
    onImageChanged?: (video: VideoDetail) => void;
}) {
    const { api, auth, settings } = useApp();
    const toast = useToast();
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    const [reloads, setReloads] = useState(0);
    const [busy, setBusy] = useState(false);
    const latest = useRef(0);
    const backRef = useRef<HTMLButtonElement>(null);
    const renameRef = useRef<HTMLButtonElement>(null);
    const deleteRef = useRef<HTMLButtonElement>(null);
    const [editing, setEditing] = useState<Editing | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmRemoveImage, setConfirmRemoveImage] = useState(false);
    const [uploading, setUploading] = useState(false);
    const chooseRef = useRef<HTMLButtonElement>(null);
    const removeImageRef = useRef<HTMLButtonElement>(null);
    // Which action button gets the focus back once it is enabled again.
    const pendingFocus = useRef<'rename' | 'delete' | 'choose' | 'remove-image' | null>(null);
    const alive = useRef(true);
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

    useEffect(() => {
        alive.current = true;

        return () => {
            alive.current = false;
        };
    }, []);

    // After a rename or a refused delete the focus returns to the button that started it.
    useEffect(() => {
        if (pendingFocus.current === 'rename' && editing === null) {
            pendingFocus.current = null;
            renameRef.current?.focus();
        } else if (pendingFocus.current === 'delete' && !busy && !confirmDelete) {
            pendingFocus.current = null;
            deleteRef.current?.focus();
        } else if (pendingFocus.current === 'choose' && !busy) {
            pendingFocus.current = null;
            chooseRef.current?.focus();
        } else if (pendingFocus.current === 'remove-image' && !busy && !confirmRemoveImage) {
            pendingFocus.current = null;
            // The remove button is gone once the custom image was removed.
            (removeImageRef.current ?? chooseRef.current)?.focus();
        }
    });

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

    function saveTitle(): void {
        if (editing === null || editing.saving || load.kind !== 'ready') return;

        const next = editing.draft.trim();

        if (next === load.video.title) {
            // Nothing changed: no request.
            pendingFocus.current = 'rename';
            setEditing(null);

            return;
        }

        const problem = titleProblem(next);

        if (problem !== null) {
            setEditing({ ...editing, error: problem });

            return;
        }

        setEditing({ ...editing, error: null, saving: true });
        api.videos
            .updateTitle(id, next)
            .then((result) => {
                if (!alive.current) return;

                if (result.ok) {
                    setLoad({ kind: 'ready', video: result.video });
                    onRenamed?.(id, result.video.title);
                    toast.show('success', 'Title updated.');
                    pendingFocus.current = 'rename';
                    setEditing(null);
                } else {
                    setEditing({ draft: editing.draft, error: result.error, saving: false });
                }
            })
            .catch(() => {
                if (alive.current) {
                    setEditing({ draft: editing.draft, error: GENERIC_ERROR, saving: false });
                }
            });
    }

    /** Quiet re-read of the detail (no loading state) for fresh, cache-busted image URLs. */
    function reloadDetail(): Promise<void> {
        const request = ++latest.current;

        return api.videos
            .get(id)
            .then((result) => {
                if (request !== latest.current || !alive.current) return;

                if (result.ok) {
                    setLoad({ kind: 'ready', video: result.video });
                    onImageChanged?.(result.video);
                } else {
                    toast.show('info', REFRESH_FAILED);
                }
            })
            .catch(() => {
                if (alive.current) toast.show('info', REFRESH_FAILED);
            });
    }

    function chooseImage(): void {
        setBusy(true);
        setUploading(true);
        // Rust opens the picker and uploads: the renderer never handles a path or bytes.
        api.videos
            .setImage(id)
            .then(async (result) => {
                if (!result.ok) {
                    toast.show('error', result.error);
                } else if (!result.canceled) {
                    toast.show('success', 'Thumbnail updated.');
                    await reloadDetail();
                }
            })
            .catch(() => toast.show('error', GENERIC_ERROR))
            .finally(() => {
                pendingFocus.current = 'choose';

                if (alive.current) {
                    setUploading(false);
                    setBusy(false);
                }
            });
    }

    function removeImage(): void {
        setConfirmRemoveImage(false);
        setBusy(true);
        api.videos
            .removeImage(id)
            .then(async (result) => {
                if (result.ok) {
                    toast.show('success', 'Custom thumbnail removed.');
                } else {
                    // The video may have changed elsewhere (e.g. "No custom thumbnail to remove."):
                    // show the message and re-read the state.
                    toast.show('error', result.error);
                }

                await reloadDetail();
            })
            .catch(() => toast.show('error', GENERIC_ERROR))
            .finally(() => {
                pendingFocus.current = 'remove-image';

                if (alive.current) setBusy(false);
            });
    }

    function cancelEdit(): void {
        pendingFocus.current = 'rename';
        setEditing(null);
    }

    function deleteVideo(): void {
        setConfirmDelete(false);
        setBusy(true);
        api.videos
            .delete(id)
            .then((result) => {
                if (!result.ok) {
                    toast.show('error', result.error);
                    pendingFocus.current = 'delete';
                } else if (result.status === 'deleted') {
                    toast.show('success', result.message);

                    if (alive.current) onDeleted?.(id);

                    return;
                } else if (result.status === 'skipped') {
                    toast.show('info', STILL_PROCESSING);
                    pendingFocus.current = 'delete';
                } else {
                    toast.show('error', result.message);
                    pendingFocus.current = 'delete';
                }

                if (alive.current) setBusy(false);
            })
            .catch(() => {
                toast.show('error', GENERIC_ERROR);
                pendingFocus.current = 'delete';

                if (alive.current) setBusy(false);
            });
    }

    const actions: Actions = {
        busy: busy || editing?.saving === true,
        uploading,
        chooseImage,
        askRemoveImage: () => setConfirmRemoveImage(true),
        chooseRef,
        removeImageRef,
        renaming: editing !== null,
        renameRef,
        deleteRef,
        rename: () => {
            if (load.kind === 'ready') {
                setEditing({ draft: load.video.title, error: null, saving: false });
            }
        },
        askDelete: () => setConfirmDelete(true),
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

            {load.kind === 'ready' && <ActionBar video={load.video} actions={actions} />}

            {load.kind === 'ready' && deleteBlocked(load.video) && (
                <p id="video-delete-blocked" className="muted detail-note detail-blocked">
                    {DELETE_BLOCKED}
                </p>
            )}

            {load.kind === 'ready' && (
                <div className="detail-grid">
                    <div className="detail-col">
                        <ThumbnailCard video={load.video} actions={actions} />
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
                        <InfoCard
                            video={load.video}
                            titleEditor={
                                editing === null ? null : (
                                    <TitleEditor
                                        editing={editing}
                                        onChange={(draft) =>
                                            setEditing({ ...editing, draft, error: null })
                                        }
                                        onSave={saveTitle}
                                        onCancel={cancelEdit}
                                    />
                                )
                            }
                        />
                    </div>
                </div>
            )}

            {confirmRemoveImage && load.kind === 'ready' && (
                <ConfirmDialog
                    title="Remove custom thumbnail"
                    message="Remove the custom thumbnail? The generated thumbnail will be used again."
                    confirmLabel="Remove"
                    cancelLabel="Cancel"
                    onConfirm={removeImage}
                    onCancel={() => setConfirmRemoveImage(false)}
                />
            )}

            {confirmDelete && load.kind === 'ready' && (
                <ConfirmDialog
                    title="Delete video"
                    message={
                        <>
                            Delete this video? This removes it from the site and may remove its
                            files from storage. This cannot be undone.
                            <br />
                            <strong>{load.video.title}</strong>
                        </>
                    }
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    danger
                    onConfirm={deleteVideo}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </section>
    );
}
