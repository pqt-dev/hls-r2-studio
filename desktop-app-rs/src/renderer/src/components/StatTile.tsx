import type { ReactNode } from 'react';

export type StatTone = 'primary' | 'success' | 'warning' | 'danger';

/**
 * One statistic: a tonal icon circle, a large tabular number and a muted label. Rendered as a
 * button when `onClick` is given and the value is loaded; otherwise as a plain block (e.g. while
 * loading, `value` null shows a dash with the same size so nothing shifts).
 */
export function StatTile({
    icon,
    value,
    label,
    tone = 'primary',
    onClick,
    actionLabel,
    alert = false,
    className,
}: {
    icon: ReactNode;
    /** The number; null while loading (shown as a dash, not clickable). */
    value: number | string | null;
    label: string;
    /** Tint of the icon circle by meaning. */
    tone?: StatTone;
    onClick?: () => void;
    /** Accessible name tail: "<label>: <value>, <actionLabel>" (e.g. "open Library"). */
    actionLabel?: string;
    /** Highlight the tile as a problem (danger tint). */
    alert?: boolean;
    className?: string;
}) {
    const classes = `stat-tile stat-tile-${tone}${alert ? ' is-danger' : ''}${className === undefined ? '' : ` ${className}`}`;
    const body = (
        <>
            <span className="stat-icon" aria-hidden="true">
                {icon}
            </span>
            <span className="stat-text">
                <span className="stat-value num">{value === null ? '—' : value}</span>
                <span className="stat-label">{label}</span>
            </span>
        </>
    );

    if (value === null || onClick === undefined) return <div className={classes}>{body}</div>;

    return (
        <button
            type="button"
            className={classes}
            aria-label={
                actionLabel === undefined ? undefined : `${label}: ${value}, ${actionLabel}`
            }
            onClick={onClick}
        >
            {body}
        </button>
    );
}
