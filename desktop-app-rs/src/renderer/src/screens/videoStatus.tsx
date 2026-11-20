import { StatusIcon } from '../components/icons';
import type { StatusKind } from '../lib/jobState';

const STATUS_LABELS: Record<string, { label: string; chip: string; kind: StatusKind }> = {
    ready: { label: 'Ready', chip: 'chip--ready', kind: 'done' },
    processing: { label: 'Processing', chip: 'chip--processing', kind: 'running' },
    pending: { label: 'Pending', chip: 'chip--pending', kind: 'waiting' },
    failed: { label: 'Failed', chip: 'chip--failed', kind: 'failed' },
};

/**
 * Status chip shared by the Library, Home and the video detail page: the same solid status
 * icon as the Queue job chips (`JobStateChip`) plus the label. Unknown statuses keep a neutral dot.
 */
export function StatusBadge({ status }: { status: string }) {
    const known = Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined;

    if (!known) return <span className="chip chip--dot chip--neutral">Unknown</span>;

    return (
        <span className={`chip ${known.chip}`}>
            <span className="chip-icon" aria-hidden="true">
                <StatusIcon kind={known.kind} />
            </span>
            {known.label}
        </span>
    );
}
