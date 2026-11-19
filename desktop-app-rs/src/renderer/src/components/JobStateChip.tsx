import type { JobDto } from '../../../shared/ipc';
import { stageLabel } from '../lib/format';
import { statusKind } from '../lib/jobState';
import { StatusIcon } from './icons';

/**
 * The state chip of a job (icon + stage label, colored by status kind), shared by the Queue rows
 * and the Home attention list.
 */
export function JobStateChip({ job }: { job: Pick<JobDto, 'state' | 'waitingForNetwork'> }) {
    const kind = statusKind(job.state);
    const label = job.waitingForNetwork ? 'Waiting for network…' : stageLabel(job.state);

    return (
        <span className={`chip chip-${kind}`}>
            <span className="chip-icon" aria-hidden="true">
                <StatusIcon kind={kind} />
            </span>
            {label}
        </span>
    );
}
