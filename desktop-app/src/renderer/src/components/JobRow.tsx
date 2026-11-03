import { useEffect, useState } from 'react';
import type { JobDto } from '../../../shared/ipc';
import { formatBytes, formatDateTime, formatRelativeTime, stageLabel } from '../lib/format';
import { hasDetailsView, isRunning, STATUS_ICON, statusKind } from '../lib/jobState';

export type JobAction =
    | 'cancel'
    | 'retry'
    | 'retry-register'
    | 'remove'
    | 'copy-url'
    | 'copy-shortcode'
    | 'open'
    | 'details';

/** Re-renders every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 15_000): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

        return () => window.clearInterval(timer);
    }, [intervalMs]);

    return now;
}

function timeInfo(job: JobDto, now: number): { label: string; iso: string } {
    if (job.finishedAt !== null) {
        return {
            label: `Finished ${formatRelativeTime(job.finishedAt, now)}`,
            iso: job.finishedAt,
        };
    }

    if (job.startedAt !== null && isRunning(job)) {
        return { label: `Started ${formatRelativeTime(job.startedAt, now)}`, iso: job.startedAt };
    }

    return { label: `Added ${formatRelativeTime(job.createdAt, now)}`, iso: job.createdAt };
}

/** One short line under the stage: why it waits, or what went wrong. */
function noteOf(job: JobDto): string | null {
    switch (job.state) {
        case 'waiting':
            return job.waitingReason;
        case 'needs_sign_in':
            return job.errorMessage ?? 'Uploaded. Sign in again to finish.';
        case 'register_failed':
            return job.errorMessage ?? 'Uploaded, but the site could not register the video.';
        case 'failed':
        case 'interrupted':
        case 'cancelled':
            return job.errorMessage;
        default:
            return null;
    }
}

export function JobRow({
    job,
    now,
    pending,
    onAction,
}: {
    job: JobDto;
    now: number;
    pending: boolean;
    onAction: (action: JobAction, job: JobDto) => void;
}) {
    const kind = statusKind(job.state);
    const running = kind === 'running';
    const time = timeInfo(job, now);
    const note = noteOf(job);
    const stage = stageLabel(job.state);

    const button = (action: JobAction, label: string, enabled = true, danger = false) =>
        enabled ? (
            <button
                type="button"
                className={danger ? 'btn btn-sm btn-danger-quiet' : 'btn btn-sm'}
                disabled={pending}
                aria-label={`${label}: ${job.fileName}`}
                onClick={() => onAction(action, job)}
            >
                {label}
            </button>
        ) : null;

    return (
        <li className={`job job-${kind}`} data-state={job.state}>
            <div className="job-main">
                <p className="job-name" title={job.fileName}>
                    {job.fileName}
                </p>
                <p className="job-meta">
                    <span className="num">{formatBytes(job.sizeBytes)}</span>
                    <span aria-hidden="true"> {'·'} </span>
                    <time dateTime={time.iso} title={formatDateTime(time.iso)}>
                        {time.label}
                    </time>
                </p>
            </div>

            <div className="job-status">
                <span className={`chip chip-${kind}`}>
                    <span className="chip-icon" aria-hidden="true">
                        {STATUS_ICON[kind]}
                    </span>
                    {stage}
                </span>
                {running && (
                    <div className="job-progress">
                        <progress
                            max={100}
                            value={job.progress}
                            aria-label={`Progress of ${job.fileName}`}
                        />
                        <span className="num job-percent">{job.progress}%</span>
                    </div>
                )}
                {note !== null && !running && (
                    <p className="job-note" title={note}>
                        {note}
                    </p>
                )}
            </div>

            <div className="job-actions">
                {button('cancel', 'Cancel', job.canCancel)}
                {button('retry', 'Retry', job.canRetry)}
                {button('retry-register', 'Retry register', job.canRetryRegister)}
                {job.state === 'done' && job.embedUrl !== null && (
                    <>
                        {button('copy-url', 'Copy embed URL')}
                        {button('copy-shortcode', 'Copy shortcode')}
                        {button('open', 'Open on site')}
                    </>
                )}
                {hasDetailsView(job.state) && button('details', 'View details')}
                {button('remove', 'Remove', job.canRemove, true)}
            </div>
        </li>
    );
}
