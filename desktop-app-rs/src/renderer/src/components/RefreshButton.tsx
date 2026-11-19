import { RefreshIcon } from './icons';

/**
 * Icon-only neutral Refresh button. While `busy` the icon turns (the button stays focusable, keeps
 * its name and reports `aria-busy`). `control` is the square `.btn-control` height, `sm` the
 * compact toolbar size.
 */
export function RefreshButton({
    busy = false,
    onClick,
    size = 'sm',
    className,
}: {
    busy?: boolean;
    onClick: () => void;
    size?: 'control' | 'sm';
    className?: string;
}) {
    const classes = `btn ${size === 'control' ? 'btn-control' : 'btn-sm'} refresh-btn${busy ? ' is-spinning' : ''}${className === undefined ? '' : ` ${className}`}`;

    return (
        <button
            type="button"
            className={classes}
            aria-label="Refresh"
            aria-busy={busy}
            title="Refresh"
            onClick={onClick}
        >
            <RefreshIcon />
        </button>
    );
}
