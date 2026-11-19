import type { ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './icons';

/**
 * Header of a group in a list or a screen section: title and count, an optional collapse toggle
 * (`open` + `onToggle`) and an optional right-aligned `action` (e.g. Clear finished). With
 * `headingLevel` the title is a real heading (named by `titleId`), so a section can use it as its
 * label; the count stays outside the heading text.
 */
export function GroupHeader({
    title,
    count,
    open,
    onToggle,
    action,
    headingLevel,
    titleId,
}: {
    title: string;
    count?: number;
    /** With `onToggle`: whether the group is expanded. */
    open?: boolean;
    onToggle?: () => void;
    action?: ReactNode;
    /** Renders the title as a heading of this level (not with `onToggle`). */
    headingLevel?: 2 | 3;
    /** Id of the heading, for `aria-labelledby`. */
    titleId?: string;
}) {
    const Heading = headingLevel === 3 ? 'h3' : 'h2';
    const titleNode =
        headingLevel === undefined || onToggle !== undefined ? (
            <span className="group-header-title">{title}</span>
        ) : (
            <Heading id={titleId} className="group-header-title">
                {title}
            </Heading>
        );
    const label = (
        <>
            {titleNode}
            {count !== undefined && <span className="num group-header-count">{count}</span>}
        </>
    );

    return (
        <div className="group-header">
            {onToggle === undefined ? (
                label
            ) : (
                <button
                    type="button"
                    className="group-header-toggle"
                    aria-expanded={open === true}
                    onClick={onToggle}
                >
                    {open === true ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    {label}
                </button>
            )}
            {action !== undefined && <div className="group-header-action">{action}</div>}
        </div>
    );
}
