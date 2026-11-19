import type { ReactNode } from 'react';

/**
 * The one empty/no-results placeholder: a small icon in a tonal circle, a one-line title, an
 * optional muted description and an optional action (e.g. a button).
 */
export function EmptyState({
    icon,
    title,
    description,
    action,
    compact = false,
}: {
    icon?: ReactNode;
    title: string;
    description?: string;
    action?: ReactNode;
    /** Tighter spacing for a placeholder inside a card or a short section. */
    compact?: boolean;
}) {
    return (
        <div className={`empty empty-state${compact ? ' is-compact' : ''}`}>
            {icon !== undefined && (
                <span className="empty-icon" aria-hidden="true">
                    {icon}
                </span>
            )}
            <p className="empty-title">{title}</p>
            {description !== undefined && <p className="muted small">{description}</p>}
            {action}
        </div>
    );
}
