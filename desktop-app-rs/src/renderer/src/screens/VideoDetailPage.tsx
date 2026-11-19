import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoDetail, VideoLinkKind } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { ImageZoom } from '../components/ImageZoom';
import { OrientationChip } from '../components/OrientationChip';
import { TierChip } from '../components/TierChip';
import {
    ArrowLeftIcon,
    BitrateIcon,
    CheckIcon,
    CopyIcon,
    DimensionsIcon,
    GridViewIcon,
    ImageIcon,
    OpenExternalIcon,
    PencilIcon,
    QualityIcon,
    RefreshIcon,
    TrashIcon,
    UploadIcon,
} from '../components/icons';
import { Thumbnail } from '../components/Thumbnail';
import {
    bitrateTier,
    formatBitrate,
    formatBytes,
    formatCodec,
    formatDateTime,
    formatDuration,
    formatFps,
    formatQuality,
    formatResolution,
    fpsTier,
    qualityTier,
    resolutionTier,
    videoOrientation,
} from '../lib/format';
import { splitUrlForMiddleEllipsis } from '../lib/middleEllipsis';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { StatusBadge } from './videoStatus';

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const MAX_TITLE_CHARS = 255;
const STILL_PROCESSING = 'The video is still processing; try again later.';
const REFRESH_FAILED =
    'The change was saved, but the page could not be refreshed. Reopen the video to reload it.';
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

/** Output size of the video (the real aspect ratio of its images), when known. */
function sizeOf(video: VideoDetail): { width: number | null; height: number | null } {
    return { width: video.outputWidth, height: video.outputHeight };
}

function Poster({ url, video }: { url: string | null; video: VideoDetail }) {
    const { width, height } = sizeOf(video);

    return <Thumbnail key={url ?? ''} url={url} width={width} height={height} />;
}

const LINK_LABELS: Record<VideoLinkKind, string> = {
    'embed-url': 'Direct URL',
    'playlist-url': 'HLS URL (.m3u8)',
    shortcode: 'Shortcode',
    'iframe-code': 'Iframe code',
    'thumbnail-url': 'Thumbnail URL',
    'custom-image-url': 'Image URL',
    'storyboard-url': 'Storyboard URL',
    'storage-folder': 'Storage folder',
};

interface Actions {
    busy: boolean;
    /** Resolves to whether the copy succeeded (the toast already tells the user either way). */
    copy: (kind: VideoLinkKind, index?: number) => Promise<boolean>;
    open: () => void;
    refresh: () => void;
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

type ImageKind = 'thumbnail' | 'custom' | 'storyboard';

/** The tile title: a small decorative icon plus the label text (the label span holds text only). */
function ImageLabel({ label, kind }: { label: string; kind: ImageKind }) {
    return (
        <span className="image-card-title">
            <span className="image-card-title-icon" aria-hidden="true">
                {kind === 'storyboard' ? <GridViewIcon /> : <ImageIcon />}
            </span>
            <span className="image-card-label">{label}</span>
        </span>
    );
}

/**
 * One image tile: a label bar (optional small icon controls at its right end), the image, and a
 * compact Copy box with the image URL. A wide image (a storyboard sprite sheet) is scaled down
 * with `object-fit: contain` instead of the thumbnail frame.
 */
function ImageCard({
    label,
    kind,
    url,
    wide = false,
    controls,
    copyLabel,
    copyDisabled,
    onCopy,
}: {
    label: string;
    kind: ImageKind;
    url: string | null;
    wide?: boolean;
    controls?: React.ReactNode;
    copyLabel: string;
    copyDisabled: boolean;
    onCopy: () => Promise<boolean>;
}) {
    const [zoomed, setZoomed] = useState(false);
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    // Only a tile whose image loaded can be enlarged (not the "No thumbnail" placeholder).
    const zoomable = url !== null && failedUrl !== url;

    return (
        <figure className={wide ? 'image-card image-card-wide' : 'image-card'}>
            <figcaption className="image-card-bar">
                <ImageLabel label={label} kind={kind} />
                {controls}
            </figcaption>
            <div className="image-card-frame">
                {wide && url !== null ? (
                    <img
                        src={url}
                        alt={label}
                        loading="lazy"
                        decoding="async"
                        onError={() => setFailedUrl(url)}
                    />
                ) : (
                    <Thumbnail
                        key={url ?? ''}
                        url={url}
                        onFailed={() => url !== null && setFailedUrl(url)}
                    />
                )}
                {zoomable && (
                    <button
                        type="button"
                        className="image-zoom-trigger"
                        aria-label={`Enlarge ${label}`}
                        title="Click to enlarge"
                        onClick={() => setZoomed(true)}
                    />
                )}
            </div>
            {zoomed && url !== null && (
                <ImageZoom label={label} kind={kind} url={url} onClose={() => setZoomed(false)} />
            )}
            <div className="image-card-actions">
                <CopyBox
                    ariaLabel={copyLabel}
                    value={url}
                    disabled={copyDisabled || url === null}
                    onCopy={onCopy}
                    middle
                />
            </div>
        </figure>
    );
}

/**
 * Images, as on the web, in one block, as small same-width tiles in two rows: the generated
 * thumbnail and the (single) custom image, then the storyboards. The custom image never replaces
 * the generated thumbnail; the list uses the thumbnail only.
 */
function ImagesCard({ video, actions }: { video: VideoDetail; actions: Actions }) {
    // The same order and filter as the main process uses to resolve a Copy by index.
    const storyboards = Object.values(video.storyboards).flatMap((board) =>
        board.url !== null ? [board.url] : [],
    );
    const replaceLabel = actions.uploading ? 'Uploading…' : 'Replace';

    return (
        <section className="card detail-card" aria-label="Images">
            <h3>Images</h3>
            <div className="image-row" data-row="thumbnails">
                <p className="image-row-label">Thumbnails</p>
                <div className="image-grid">
                    <ImageCard
                        label="Thumbnail"
                        kind="thumbnail"
                        url={video.thumbnailUrl}
                        copyLabel="Copy thumbnail URL"
                        copyDisabled={actions.busy}
                        onCopy={() => actions.copy('thumbnail-url')}
                    />
                    {video.hasCustomImage ? (
                        <ImageCard
                            label="Custom image"
                            kind="custom"
                            url={video.customImageUrl}
                            copyLabel="Copy custom image URL"
                            copyDisabled={actions.busy}
                            onCopy={() => actions.copy('custom-image-url')}
                            controls={
                                <span className="image-card-controls">
                                    <button
                                        ref={actions.chooseRef}
                                        type="button"
                                        className="btn btn-sm image-card-icon-btn"
                                        aria-label={replaceLabel}
                                        title={replaceLabel}
                                        disabled={actions.busy}
                                        onClick={actions.chooseImage}
                                    >
                                        <UploadIcon />
                                    </button>
                                    <button
                                        ref={actions.removeImageRef}
                                        type="button"
                                        className="btn btn-sm btn-accent-danger image-card-icon-btn"
                                        aria-label="Delete"
                                        title="Delete"
                                        disabled={actions.busy}
                                        onClick={actions.askRemoveImage}
                                    >
                                        <TrashIcon />
                                    </button>
                                </span>
                            }
                        />
                    ) : (
                        <figure className="image-card image-upload-tile">
                            <figcaption className="image-card-bar">
                                <ImageLabel label="Custom image" kind="custom" />
                            </figcaption>
                            <div className="image-upload-body">
                                <span className="image-upload-icon" aria-hidden="true">
                                    <ImageIcon />
                                </span>
                                <p className="image-upload-title">No custom image</p>
                                <button
                                    ref={actions.chooseRef}
                                    type="button"
                                    className="btn btn-sm btn-primary image-upload-btn"
                                    disabled={actions.busy}
                                    onClick={actions.chooseImage}
                                >
                                    {actions.uploading ? (
                                        'Uploading…'
                                    ) : (
                                        <>
                                            <UploadIcon /> Upload image
                                        </>
                                    )}
                                </button>
                                <p className="image-upload-hint">JPG, PNG or WebP · up to 5 MB</p>
                            </div>
                        </figure>
                    )}
                </div>
            </div>
            {storyboards.length > 0 && (
                <div className="image-row" data-row="storyboards">
                    <p className="image-row-label">Storyboards</p>
                    <div className="image-grid">
                        {storyboards.map((url, index) => {
                            const name =
                                storyboards.length === 1
                                    ? 'storyboard URL'
                                    : `storyboard ${index + 1} URL`;

                            return (
                                <ImageCard
                                    key={url}
                                    label={
                                        storyboards.length === 1
                                            ? 'Storyboard'
                                            : `Storyboard ${index + 1}`
                                    }
                                    kind="storyboard"
                                    url={url}
                                    wide
                                    copyLabel={`Copy ${name}`}
                                    copyDisabled={actions.busy}
                                    onCopy={() => actions.copy('storyboard-url', index)}
                                />
                            );
                        })}
                    </div>
                </div>
            )}
            {video.hasCustomImage && (
                <p className="muted detail-note">JPG, PNG or WebP, up to 5 MB.</p>
            )}
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
    // The skeleton covers the frame until the embed page has loaded. Nothing autoplays: the
    // embed URL is used as-is and the sandbox/CSP rules below still apply.
    const [frameLoaded, setFrameLoaded] = useState(false);
    // The generated thumbnail only: a custom image never replaces it.
    const poster = video.thumbnailUrl;
    const embeddable = isSiteEmbedUrl(video.embedUrl, siteUrl);

    let body: React.ReactNode;

    if (video.status !== 'ready') {
        body = (
            <>
                <Poster url={poster} video={video} />
                <p className="muted detail-note">{statusExplanation(video)}</p>
            </>
        );
    } else if (!embeddable || video.embedUrl === null) {
        body = (
            <>
                <Poster url={poster} video={video} />
                <div className="detail-note">
                    <p>Preview unavailable</p>
                    {video.embedUrl !== null && (
                        <p className="muted">Use the Open in browser button above.</p>
                    )}
                </div>
            </>
        );
    } else {
        body = (
            <div className="preview-poster">
                <iframe
                    className="preview-frame"
                    title={`Preview of ${video.title}`}
                    src={video.embedUrl}
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    allow="fullscreen"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    onLoad={() => setFrameLoaded(true)}
                />
                {!frameLoaded && <div className="preview-loading">Loading preview…</div>}
            </div>
        );
    }

    return (
        <section className="card detail-card" aria-label="Preview">
            <div className="row detail-card-head">
                <h3>Preview</h3>
                {video.embedUrl !== null && (
                    <button
                        type="button"
                        className="btn btn-sm"
                        title="Open in browser"
                        aria-label="Open in browser"
                        disabled={actions.busy}
                        onClick={actions.open}
                    >
                        <OpenExternalIcon />
                    </button>
                )}
            </div>
            {body}
        </section>
    );
}

/** How long the Copy button shows its "Copied" state. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * Icon-only Copy button with the "copied" feedback: after a successful copy it shows a check and a
 * "Copied" tooltip for a moment (the screen-reader announcement is the toast the copy action shows).
 */
function CopyIconButton({
    ariaLabel,
    disabled,
    onCopy,
}: {
    ariaLabel: string;
    disabled: boolean;
    /** Resolves to whether the copy succeeded. */
    onCopy: () => Promise<boolean>;
}) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
    );

    function copy(): void {
        void onCopy().then((ok) => {
            if (!ok) return;

            if (timer.current !== null) clearTimeout(timer.current);

            setCopied(true);
            timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        });
    }

    return (
        <button
            type="button"
            className={copied ? 'btn btn-sm embed-copy is-copied' : 'btn btn-sm embed-copy'}
            aria-label={ariaLabel}
            title={copied ? 'Copied' : ariaLabel}
            disabled={disabled}
            onClick={copy}
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
    );
}

/**
 * Single-line text with an ellipsis in the middle: the head shrinks, the tail stays. The two
 * visible spans are hidden from assistive tech; one visually-hidden node carries the full text.
 */
function MiddleText({ text, title }: { text: string; title: string | null }) {
    const { head, tail } = splitUrlForMiddleEllipsis(text);

    return (
        <>
            <span className="visually-hidden" title={title ?? undefined}>
                {text}
            </span>
            <span className="embed-value-head" aria-hidden="true">
                {head}
            </span>
            <span className="embed-value-tail" aria-hidden="true">
                {tail}
            </span>
        </>
    );
}

function CopyBox({
    ariaLabel,
    value,
    display = value,
    disabled,
    onCopy,
    wrap = false,
    middle = false,
}: {
    /** Accessible name and tooltip of the Copy button, e.g. "Copy Direct URL". */
    ariaLabel: string;
    /** Full value (the tooltip of the text); null when there is none to show. */
    value: string | null;
    /** The text shown in the box (defaults to the value). */
    display?: string | null;
    disabled: boolean;
    /** Resolves to whether the copy succeeded. */
    onCopy: () => Promise<boolean>;
    /** Long multi-part values (the iframe code) wrap over up to 3 lines instead of one. */
    wrap?: boolean;
    /** One line with the start and the end of the text visible (ellipsis in the middle). */
    middle?: boolean;
}) {
    return (
        <div className={wrap ? 'embed-box embed-box-wrap' : 'embed-box'}>
            <div className="embed-value mono" title={value ?? undefined}>
                {middle ? (
                    <MiddleText text={display ?? 'Copy URL'} title={value} />
                ) : (
                    (display ?? 'Copy URL')
                )}
            </div>
            <CopyIconButton ariaLabel={ariaLabel} disabled={disabled} onCopy={onCopy} />
        </div>
    );
}

/**
 * One labeled field: a caption, then a read-only value box (selectable text, full value in the
 * tooltip) with an icon-only Copy button inside its right end. After a successful copy the button
 * shows a check and a "Copied" tooltip for a moment; the screen-reader announcement is the toast
 * the copy action already shows, so there is no second live region.
 */
function EmbedField({
    kind,
    value,
    actions,
    wrap = false,
}: {
    kind: VideoLinkKind;
    value: string;
    actions: Actions;
    wrap?: boolean;
}) {
    const label = LINK_LABELS[kind];

    return (
        <div className="embed-field">
            <h4>{label}</h4>
            <CopyBox
                ariaLabel={`Copy ${label}`}
                value={value}
                disabled={actions.busy}
                onCopy={() => actions.copy(kind)}
                wrap={wrap}
            />
        </div>
    );
}

function EmbedCard({ video, actions }: { video: VideoDetail; actions: Actions }) {
    if (video.embedUrl === null) return null;

    return (
        <section className="card detail-card" aria-label="Embed">
            <h3>Embed</h3>
            <div className="embed-fields">
                {video.shortcode !== null && (
                    <EmbedField kind="shortcode" value={video.shortcode} actions={actions} />
                )}
                <EmbedField kind="embed-url" value={video.embedUrl} actions={actions} />
                {video.iframeCode !== null && (
                    <EmbedField
                        kind="iframe-code"
                        value={video.iframeCode}
                        actions={actions}
                        wrap
                    />
                )}
                {video.playlistUrl !== null && (
                    <EmbedField kind="playlist-url" value={video.playlistUrl} actions={actions} />
                )}
            </div>
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

/**
 * The storage folder (path only, as returned by Rust) in monospace, wrapping anywhere, with the
 * last segment (slug-id) emphasised, and an icon-only Copy button. Rust copies it; the renderer
 * never sends the text.
 */
function StorageFolder({ folder, actions }: { folder: string; actions: Actions }) {
    const trimmed = folder.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/') + 1;

    return (
        <span className="storage-folder">
            <span className="storage-folder-path mono" title={folder}>
                {trimmed.slice(0, cut)}
                <strong>{trimmed.slice(cut)}</strong>
                {folder.slice(trimmed.length)}
            </span>
            <CopyIconButton
                ariaLabel="Copy storage folder"
                disabled={actions.busy}
                onCopy={() => actions.copy('storage-folder')}
            />
        </span>
    );
}

function InfoCard({
    video,
    titleEditor,
    editRef,
    editDisabled,
    onEdit,
    actions,
}: {
    video: VideoDetail;
    actions: Actions;
    titleEditor: React.ReactNode;
    editRef: React.RefObject<HTMLButtonElement | null>;
    editDisabled: boolean;
    onEdit: () => void;
}) {
    const duration = formatDuration(video.duration);
    const created = video.createdAt === null ? '' : formatDateTime(video.createdAt);
    const updated = video.updatedAt === null ? '' : formatDateTime(video.updatedAt);
    const { outputWidth: width, outputHeight: height } = video;
    const quality = formatQuality(width, height);
    const dimensions = formatResolution(width, height);
    const orientation =
        dimensions !== '' && width !== null && height !== null
            ? videoOrientation(width, height)
            : null;
    const bitrate = formatBitrate(video.outputBitrateKbps);
    const fps = formatFps(video.outputFps);
    const rawCodec = (video.outputCodec ?? '').trim();
    const codec = formatCodec(video.outputCodec);

    return (
        <section className="card detail-card" aria-label="Information">
            <h3>Information</h3>
            <dl className="kv">
                <Row label="Title">
                    {titleEditor ?? (
                        <span className="kv-title">
                            <span className="kv-title-text">{video.title}</span>
                            <button
                                ref={editRef}
                                type="button"
                                className="btn btn-sm kv-title-edit"
                                title="Edit title"
                                aria-label="Edit title"
                                disabled={editDisabled}
                                onClick={onEdit}
                            >
                                <PencilIcon />
                            </button>
                        </span>
                    )}
                </Row>
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
                {dimensions !== '' && (
                    <Row label="Dimensions">
                        <span className="kv-chips">
                            <TierChip
                                label={dimensions}
                                tier={resolutionTier(width, height) ?? 5}
                                title="Dimensions in pixels (width by height)"
                                icon={
                                    <DimensionsIcon orientation={videoOrientation(width, height)} />
                                }
                            />
                            {orientation !== null && <OrientationChip orientation={orientation} />}
                        </span>
                    </Row>
                )}
                {quality !== '' && (
                    <Row label="Quality">
                        <TierChip
                            label={quality}
                            tier={qualityTier(width, height) ?? 5}
                            title="Quality class, from the shorter side of the video"
                            icon={<QualityIcon />}
                        />
                    </Row>
                )}
                {fps !== '' && (
                    <Row label="Frame rate">
                        <TierChip
                            label={fps}
                            tier={fpsTier(video.outputFps) ?? 5}
                            title="Frame rate"
                        />
                    </Row>
                )}
                {bitrate !== '' && (
                    <Row label="Bitrate">
                        <TierChip
                            label={bitrate}
                            tier={bitrateTier(video.outputBitrateKbps) ?? 5}
                            title="Bitrate"
                            icon={<BitrateIcon />}
                        />
                    </Row>
                )}
                {codec !== '' && (
                    <Row label="Codec">
                        <span title={codec === rawCodec ? undefined : `Codec: ${rawCodec}`}>
                            {codec}
                        </span>
                    </Row>
                )}
                {video.originalFilename !== null && (
                    <Row label="Original file">{video.originalFilename}</Row>
                )}
                {video.storageFolder !== null && (
                    <Row label="Storage folder">
                        <StorageFolder folder={video.storageFolder} actions={actions} />
                    </Row>
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
 * Action toolbar inside the sticky header: the destructive icon-only Delete (danger-styled; it
 * still asks for confirmation) and, only while the video is not ready, an icon-only Refresh.
 * The page does not poll, and a ready video is static, so Refresh only matters while the status
 * can still change server-side (pending, processing, failed). Rename sits next to the title and
 * Open in browser in the Preview card; copying links lives in the Embed card.
 */
function ActionBar({ video, actions }: { video: VideoDetail; actions: Actions }) {
    const blocked = deleteBlocked(video);

    return (
        <div className="detail-actionbar" role="toolbar" aria-label="Video actions">
            {video.status !== 'ready' && (
                <button
                    type="button"
                    className="btn btn-sm"
                    title="Refresh"
                    aria-label="Refresh"
                    onClick={actions.refresh}
                >
                    <RefreshIcon />
                </button>
            )}
            <button
                ref={actions.deleteRef}
                type="button"
                className="btn btn-sm btn-accent-danger"
                title={blocked ? DELETE_BLOCKED : 'Delete'}
                aria-label="Delete"
                disabled={actions.busy || blocked}
                aria-describedby={blocked ? 'video-delete-blocked' : undefined}
                onClick={actions.askDelete}
            >
                <TrashIcon />
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
    const editTitleRef = useRef<HTMLButtonElement>(null);
    // Which control opened the title editor, so closing it can return the focus there.
    const renameOpener = useRef<'header' | 'info'>('header');
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
            (renameOpener.current === 'info' ? editTitleRef : renameRef).current?.focus();
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
        (
            action: () => Promise<{ ok: true } | { ok: false; error: string }>,
            success: string,
        ): Promise<boolean> => {
            setBusy(true);

            return action()
                .then((result) => {
                    if (result.ok) toast.show('success', success);
                    else toast.show('error', result.error);

                    return result.ok;
                })
                .catch(() => {
                    toast.show('error', GENERIC_ERROR);

                    return false;
                })
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
                    toast.show('success', 'Custom image updated.');
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
                    toast.show('success', 'Custom image deleted.');
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
                renameOpener.current = 'header';
                setEditing({ draft: load.video.title, error: null, saving: false });
            }
        },
        askDelete: () => setConfirmDelete(true),
        refresh,
        copy: (kind, index) =>
            run(
                () =>
                    index === undefined
                        ? api.videos.copyLink(id, kind)
                        : api.videos.copyLink(id, kind, index),
                `${LINK_LABELS[kind]} copied.`,
            ),
        open: () => run(() => api.videos.openEmbed(id), 'Opened in your browser.'),
    };

    const title = load.kind === 'ready' ? load.video.title : fallbackTitle;

    return (
        <section className="detail" aria-label="Video details">
            <header className="detail-header">
                <button
                    ref={backRef}
                    type="button"
                    className="btn btn-sm detail-back"
                    aria-label="Back to Library"
                    title="Back to Library"
                    onClick={onBack}
                >
                    <ArrowLeftIcon />
                </button>
                {/* The shell's top bar is hidden while this page is open, so this is the page heading. */}
                <div className="detail-titlebar">
                    <h2 className="detail-title" title={title}>
                        {title}
                    </h2>
                    {load.kind === 'ready' && (
                        <button
                            ref={renameRef}
                            type="button"
                            className="btn btn-sm detail-rename"
                            title="Rename"
                            aria-label="Rename"
                            disabled={actions.busy || actions.renaming}
                            onClick={actions.rename}
                        >
                            <PencilIcon />
                        </button>
                    )}
                </div>
                {load.kind === 'ready' && <ActionBar video={load.video} actions={actions} />}
            </header>

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

            {load.kind === 'ready' && deleteBlocked(load.video) && (
                <p id="video-delete-blocked" className="muted detail-note detail-blocked">
                    {DELETE_BLOCKED}
                </p>
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
                        <EmbedCard video={load.video} actions={actions} />
                    </div>
                    <div className="detail-col">
                        <ErrorCard video={load.video} />
                        <ImagesCard video={load.video} actions={actions} />
                        <InfoCard
                            video={load.video}
                            actions={actions}
                            editRef={editTitleRef}
                            editDisabled={actions.busy}
                            onEdit={() => {
                                renameOpener.current = 'info';
                                setEditing({
                                    draft: load.video.title,
                                    error: null,
                                    saving: false,
                                });
                            }}
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
                    title="Delete image"
                    message="Delete this custom image?"
                    confirmLabel="Delete"
                    cancelLabel="Cancel"
                    danger
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
