import { useLayoutEffect, useRef } from 'react';
import type { VideoOrientation } from '../lib/format';
import { STATUS_ICON, type StatusKind } from '../lib/jobState';
import { FLUENT, type FluentName } from './fluentIcons';

/**
 * 20px Fluent System Icons (MIT, see LICENSES/fluent-system-icons) drawn with currentColor so they
 * follow the theme and forced-colors. `duo` also renders the filled style: CSS shows it instead
 * of the regular one while a `.tab` parent is selected (active sidebar item).
 */
function Glyph({
    name,
    duo = false,
    orientation,
}: {
    name: FluentName;
    duo?: boolean;
    orientation?: VideoOrientation;
}) {
    const glyph = FLUENT[name];
    const svg = (style: 'regular' | 'filled') => (
        <svg
            className={`icon icon-${style}`}
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
 * Path of the gear in the app mark: a cog with 8 trapezoid teeth (outer radius 10.4, root radius
 * 7.9 on a 32 grid) and a round centre hole, cut out with the even-odd rule.
 */
const GEAR_PATH =
    'M13.80 8.41 L14.37 5.73 L17.63 5.73 L18.20 8.41 L19.81 9.08 L22.11 7.59 L24.41 9.89 L22.92 12.19 L23.59 13.80 L26.27 14.37 L26.27 17.63 L23.59 18.20 L22.92 19.81 L24.41 22.11 L22.11 24.41 L19.81 22.92 L18.20 23.59 L17.63 26.27 L14.37 26.27 L13.80 23.59 L12.19 22.92 L9.89 24.41 L7.59 22.11 L9.08 19.81 L8.41 18.20 L5.73 17.63 L5.73 14.37 L8.41 13.80 L9.08 12.19 L7.59 9.89 L9.89 7.59 L12.19 9.08 Z M19.30 16 A3.3 3.3 0 1 0 12.70 16 A3.3 3.3 0 1 0 19.30 16 Z';

/**
 * App mark: a brand-blue rounded tile with a white gear. A gear says "tool / processing" (this app
 * builds and uploads videos), not "player": there is no play triangle anywhere. `size` is in rem.
 */
export function BrandMark({ size = 1.75 }: { size?: number }) {
    const ref = useRef<SVGSVGElement>(null);

    useLayoutEffect(() => {
        ref.current?.style.setProperty('--brand-size', `${size}rem`);
    }, [size]);

    return (
        <svg
            ref={ref}
            className="brand-mark"
            viewBox="0 0 32 32"
            aria-hidden="true"
            focusable="false"
        >
            <rect className="brand-tile" width="32" height="32" rx="8" />
            <path className="brand-gear" d={GEAR_PATH} fillRule="evenodd" />
        </svg>
    );
}
