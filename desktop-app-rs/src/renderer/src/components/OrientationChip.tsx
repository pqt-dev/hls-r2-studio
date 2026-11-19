import type { VideoOrientation } from '../lib/format';
import { DimensionsIcon } from './icons';

/**
 * Neutral "Horizontal" / "Vertical" chip with the landscape or portrait icon. Shared by the detail
 * page's Information card and the Library list rows. `decorative` hides it from assistive tech
 * where the value is read elsewhere.
 */
export function OrientationChip({
    orientation,
    decorative = false,
}: {
    orientation: VideoOrientation;
    decorative?: boolean;
}) {
    return (
        <span
            className="spec media-chip"
            title="Orientation"
            aria-hidden={decorative ? 'true' : undefined}
        >
            <DimensionsIcon orientation={orientation} />
            {orientationLabel(orientation)}
        </span>
    );
}

/** "Vertical" for portrait, "Horizontal" for landscape (including square). */
export function orientationLabel(orientation: VideoOrientation): string {
    return orientation === 'portrait' ? 'Vertical' : 'Horizontal';
}
