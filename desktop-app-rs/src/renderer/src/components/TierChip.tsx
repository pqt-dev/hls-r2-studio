import type { ReactElement } from 'react';
import type { Tier } from '../lib/format';

/**
 * Colour-tiered media chip (tier 1 purple to 5 gray), shared by the Library cards and the detail
 * page. `decorative` hides it from assistive tech where the value is read elsewhere.
 */
export function TierChip({
    label,
    tier,
    title,
    icon,
    decorative = false,
}: {
    label: string;
    tier: Tier;
    title: string;
    icon?: ReactElement;
    decorative?: boolean;
}) {
    return (
        <span
            className={`spec media-chip num chip-tier-${tier}`}
            title={title}
            aria-hidden={decorative ? 'true' : undefined}
        >
            {icon}
            {label}
        </span>
    );
}
