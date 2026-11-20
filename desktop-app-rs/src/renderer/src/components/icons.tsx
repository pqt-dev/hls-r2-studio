import { useLayoutEffect, useRef } from 'react';
import type { VideoOrientation } from '../lib/format';
import { STATUS_ICON, type StatusKind } from '../lib/jobState';
import logoUrl from '../assets/logo.png';
import { FLUENT, type FluentName } from './fluentIcons';

/**
 * 20px Fluent System Icons (MIT, see LICENSES/fluent-system-icons) drawn with currentColor so they
 * follow the theme and forced-colors. `duo` also renders the filled style: CSS shows it instead
 * of the regular one while a `.tab` parent is selected (active sidebar item). `filled` renders only
 * the filled style as a normal `.icon` (never hidden by the sidebar CSS), for solid accent icons.
 */
function Glyph({
    name,
    duo = false,
    filled = false,
    orientation,
}: {
    name: FluentName;
    duo?: boolean;
    filled?: boolean;
    orientation?: VideoOrientation;
}) {
    const glyph = FLUENT[name];
    const svg = (style: 'regular' | 'filled', className = `icon icon-${style}`) => (
        <svg
            className={className}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
            data-orientation={orientation}
        >
            {glyph[style].map((d) => (
                <path key={d} d={d} />
            ))}
        </svg>
    );

    if (filled) return svg('filled', 'icon');

    return duo ? (
        <>
            {svg('regular')}
            {svg('filled')}
        </>
    ) : (
        svg('regular')
    );
}

interface IconProps {
    /** Also render the filled style, shown while the parent `.tab` is selected. */
    duo?: boolean;
}

export const HomeIcon = ({ duo }: IconProps) => <Glyph name="home" duo={duo} />;
export const QueueIcon = ({ duo }: IconProps) => <Glyph name="queue" duo={duo} />;
export const LibraryIcon = ({ duo }: IconProps) => <Glyph name="library" duo={duo} />;
export const SettingsIcon = ({ duo }: IconProps) => <Glyph name="settings" duo={duo} />;
export const AboutIcon = ({ duo }: IconProps) => <Glyph name="about" duo={duo} />;
export const SearchIcon = () => <Glyph name="search" />;
export const GridViewIcon = () => <Glyph name="grid" />;
export const ListViewIcon = () => <Glyph name="list" />;
export const LinkIcon = () => <Glyph name="link" />;
export const ShortcodeIcon = () => <Glyph name="code" />;
export const PlaylistIcon = () => <Glyph name="playlist" />;
export const OpenExternalIcon = () => <Glyph name="open" />;
export const PencilIcon = () => <Glyph name="edit" />;
export const TrashIcon = () => <Glyph name="delete" />;
export const MoreIcon = () => <Glyph name="more" />;
export const VideoFileIcon = () => <Glyph name="video" />;
export const UploadIcon = () => <Glyph name="upload" />;
export const PlayIcon = () => <Glyph name="play" />;
export const RefreshIcon = () => <Glyph name="refresh" />;
export const CopyIcon = () => <Glyph name="copy" />;
export const ImageIcon = () => <Glyph name="image" />;
export const SuccessIcon = () => <Glyph name="success" />;
export const ErrorIcon = () => <Glyph name="failure" />;
export const WarningIcon = () => <Glyph name="warning" />;
export const InfoIcon = () => <Glyph name="about" />;
export const ArrowLeftIcon = () => <Glyph name="arrowLeft" />;
/** Icon of a queue status kind (shown next to the status text). */
export const StatusIcon = ({ kind }: { kind: StatusKind }) => (
    <Glyph name={STATUS_ICON[kind]} filled />
);
/** Solid (filled) icons of the Home stat tiles; distinct silhouettes: rectangle, badge, circle, triangle. */
export const StatTotalIcon = () => <Glyph name="statTotal" filled />;
export const StatReadyIcon = () => <Glyph name="statReady" filled />;
export const StatProcessingIcon = () => <Glyph name="statProcessing" filled />;
export const StatFailedIcon = () => <Glyph name="statFailed" filled />;
export const ClockIcon = () => <Glyph name="clock" />;
export const StorageIcon = () => <Glyph name="drive" />;
export const RulerIcon = () => <Glyph name="ruler" />;
/** One neutral video icon for every resolution chip: the label and tier colour carry the level. */
export const QualityIcon = () => <Glyph name="quality" />;
/** Dimensions chip: an outline TV (landscape) or phone (portrait); square counts as landscape. */
export const DimensionsIcon = ({ orientation }: { orientation: VideoOrientation }) => (
    <Glyph name={orientation} orientation={orientation} />
);
export const BitrateIcon = () => <Glyph name="bitrate" />;
export const UploadedIcon = () => <Glyph name="uploaded" />;
/** Sign-out glyph (door frame with an outgoing arrow), drawn as a 20px stroke icon. */
export const SignOutIcon = () => (
    <svg
        className="icon"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <path d="M8 3.5H5.5A1.5 1.5 0 0 0 4 5v10a1.5 1.5 0 0 0 1.5 1.5H8" />
        <path d="M8.5 10h8M13.5 7l3 3-3 3" />
    </svg>
);
export const CheckIcon = () => <Glyph name="check" />;
export const CloseIcon = () => <Glyph name="close" />;
export const ChevronLeftIcon = () => <Glyph name="chevronLeft" />;
export const ChevronRightIcon = () => <Glyph name="chevronRight" />;
export const ChevronDownIcon = () => <Glyph name="chevronDown" />;
export const FirstPageIcon = () => <Glyph name="first" />;
export const LastPageIcon = () => <Glyph name="last" />;
export const SortIcon = () => <Glyph name="sort" />;
export const CheckboxIcon = ({ state }: { state: 'none' | 'some' | 'all' }) => (
    <Glyph name={state === 'all' ? 'boxChecked' : state === 'some' ? 'boxPartial' : 'boxEmpty'} />
);

/**
 * App mark: the app logo (red rounded-square tile, clapperboard and gear) as a decorative image. Source of truth
 * is `src-tauri/icons/source/logo.png`; `src/assets/logo.png` is a downscaled copy for the UI.
 * `size` is in rem.
 */
export function BrandMark({ size = 1.75 }: { size?: number }) {
    const ref = useRef<HTMLImageElement>(null);

    useLayoutEffect(() => {
        ref.current?.style.setProperty('--brand-size', `${size}rem`);
    }, [size]);

    return (
        <img
            ref={ref}
            className="brand-mark"
            src={logoUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
        />
    );
}
