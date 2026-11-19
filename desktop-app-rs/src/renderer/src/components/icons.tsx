import { useId, useLayoutEffect, useRef } from 'react';
import type { VideoOrientation } from '../lib/format';
import { STATUS_ICON, type StatusKind } from '../lib/jobState';
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
export const LogsIcon = ({ duo }: IconProps) => <Glyph name="logs" duo={duo} />;
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
export const RefreshIcon = () => <Glyph name="refresh" />;
export const CopyIcon = () => <Glyph name="copy" />;
export const ImageIcon = () => <Glyph name="image" />;
export const SuccessIcon = () => <Glyph name="success" />;
export const ErrorIcon = () => <Glyph name="failure" />;
export const WarningIcon = () => <Glyph name="warning" />;
export const InfoIcon = () => <Glyph name="about" />;
export const ArrowLeftIcon = () => <Glyph name="arrowLeft" />;
/** Icon of a queue status kind (shown next to the status text). */
export const StatusIcon = ({ kind }: { kind: StatusKind }) => <Glyph name={STATUS_ICON[kind]} />;
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
 * App mark: a rounded tile with a brand-blue to cyan gradient, a white play triangle and two
 * convert arrows (white and warm amber) that say "transcode", not just "tool". Gradient ids come
 * from `useId` so several instances never clash. Keep in sync with
 * `src-tauri/icons/source/logo.svg`. `size` is in rem.
 */
export function BrandMark({ size = 1.75 }: { size?: number }) {
    const ref = useRef<SVGSVGElement>(null);
    const gradientId = `brand-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

    useLayoutEffect(() => {
        ref.current?.style.setProperty('--brand-size', `${size}rem`);
    }, [size]);

    return (
        <svg
            ref={ref}
            className="brand-mark"
            viewBox="0 0 64 64"
            aria-hidden="true"
            focusable="false"
        >
            <defs>
                <linearGradient
                    id={gradientId}
                    x1="6"
                    y1="2"
                    x2="58"
                    y2="62"
                    gradientUnits="userSpaceOnUse"
                >
                    <stop offset="0" stopColor="#0f6cbd" />
                    <stop offset="1" stopColor="#12b5cb" />
                </linearGradient>
            </defs>
            <rect
                className="brand-tile"
                width="64"
                height="64"
                rx="14"
                fill={`url(#${gradientId})`}
            />
            <path
                className="brand-ink"
                d="M14.5 18h13a6.5 6.5 0 0 1 6.5 6.5v15a6.5 6.5 0 0 1 -6.5 6.5h-13a6.5 6.5 0 0 1 -6.5 -6.5v-15a6.5 6.5 0 0 1 6.5 -6.5zM16.95 26.12L27.29 32L16.95 37.88z"
                fill="#fff"
                fillRule="evenodd"
            />
            <rect className="brand-ink" x="38" y="23" width="9" height="18" rx="3" fill="#fff" />
            <rect className="brand-ink" x="50" y="28" width="6" height="8" rx="3" fill="#ffb324" />
        </svg>
    );
}
