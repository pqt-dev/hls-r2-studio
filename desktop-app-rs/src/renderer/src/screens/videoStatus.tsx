import { StatusIcon } from '../components/icons';
import type { StatusKind } from '../lib/jobState';

const STATUS_LABELS: Record<string, { label: string; chip: string; kind: StatusKind }> = {
    ready: { label: 'Ready', chip: 'chip--ready', kind: 'done' },
    processing: { label: 'Processing', chip: 'chip--processing', kind: 'running' },
    pending: { label: 'Pending', chip: 'chip--pending', kind: 'waiting' },
    failed: { label: 'Failed', chip: 'chip--failed', kind: 'failed' },
};

/**
 * Status chip shared by the Library, Home, Logs and the video detail page: the same solid status
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

/** Site pipeline stage -> label, the same texts as the web Logs page. */
const STAGE_LABELS: Record<string, string> = {
    queued: 'Queued',
    merging: 'Merging chunks…',
    transcoding: 'Transcoding…',
    generating_thumbnail: 'Generating thumbnail…',
    generating_storyboard: 'Generating storyboard…',
    uploading_r2: 'Uploading to R2…',
};

/** A pending video that has not started merging yet is waiting in the queue. */
export function isQueuedVideo(status: string, stage: string | null): boolean {
    return status === 'pending' && stage !== 'merging';
}

/** The one place that turns a stage into text; an unknown stage keeps its name readable. */
export function stageLabel(status: string, stage: string | null): string {
    if (isQueuedVideo(status, stage)) return 'Queued';

    if (stage === null || stage === '') return 'Queued';

    return Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage]! : stage.replaceAll('_', ' ');
}

/** "Queued" or "Processing" chip of a video that is still being handled by the site. */
export function ProcessingBadge({ queued }: { queued: boolean }) {
    return (
        <span className={`chip ${queued ? 'chip--pending' : 'chip--processing'}`}>
            <span className="chip-icon" aria-hidden="true">
                <StatusIcon kind={queued ? 'waiting' : 'running'} />
            </span>
            {queued ? 'Queued' : 'Processing'}
        </span>
    );
}
