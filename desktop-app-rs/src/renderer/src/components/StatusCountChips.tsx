export interface StatusCounts {
    running: number;
    waiting: number;
    done: number;
    failed: number;
    /** Shown only when above zero. */
    attention?: number;
}

export type StatusCountKey = keyof StatusCounts;

const CHIPS: readonly { key: StatusCountKey; label: string }[] = [
    { key: 'running', label: 'running' },
    { key: 'waiting', label: 'waiting' },
    { key: 'done', label: 'done' },
    { key: 'failed', label: 'failed' },
    { key: 'attention', label: 'need attention' },
];

/**
 * Colored dot + count chips (running blue, waiting amber, done green, failed red). With
 * `onSelect` each chip is a button; without it they are plain text.
 */
export function StatusCountChips({
    counts,
    onSelect,
}: {
    counts: StatusCounts;
    onSelect?: (key: StatusCountKey) => void;
}) {
    return (
        <span className="status-counts">
            {CHIPS.filter((chip) => chip.key !== 'attention' || (counts.attention ?? 0) > 0).map(
                (chip) => {
                    const className = `status-count status-count-${chip.key} num`;
                    const body = (
                        <>
                            <span className="status-count-dot" aria-hidden="true" />
                            {`${counts[chip.key] ?? 0} ${chip.label}`}
                        </>
                    );

                    return onSelect === undefined ? (
                        <span key={chip.key} className={className}>
                            {body}
                        </span>
                    ) : (
                        <button
                            key={chip.key}
                            type="button"
                            className={className}
                            onClick={() => onSelect(chip.key)}
                        >
                            {body}
                        </button>
                    );
                },
            )}
        </span>
    );
}
