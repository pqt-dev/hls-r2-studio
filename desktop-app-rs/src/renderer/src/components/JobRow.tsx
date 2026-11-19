import { useEffect, useState } from 'react';
import type { JobDto } from '../../../shared/ipc';
import { formatBytes, formatDateTime, formatRelativeTime } from '../lib/format';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { JobProgress } from './JobProgress';
import { JobStateChip } from './JobStateChip';
import { MediaTile } from './MediaTile';
import { VideoQuickActions, type QuickAction } from './VideoQuickActions';
import { hasDetailsView, isRunning, statusKind } from '../lib/jobState';

export type JobAction =
    | 'cancel'
    | 'retry'
    | 'retry-register'
    | 'resume'
    | 'remove'
    | 'copy-url'
    | 'copy-shortcode'
    | 'copy-thumbnail'
    | 'open'
    | 'view-library'
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
    if (job.state === 'upload_interrupted') {
        return {
            label: `Paused ${formatRelativeTime(job.updatedAt, now)}`,
            iso: job.updatedAt,
        };
    }

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
        case 'upload_interrupted':
            return job.errorMessage ?? 'The upload was paused. Resume to continue.';
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
    const paused = job.state === 'upload_interrupted';

    const name = job.fileName;
    const item = (
        action: JobAction,
        label: string,
        enabled: boolean,
        danger = false,
    ): ActionMenuItem[] =>
        enabled
            ? [
                  {
                      key: action,
                      label,
                      ariaLabel: `${label}: ${name}`,
                      danger,
                      onSelect: () => onAction(action, job),
                  },
              ]
            : [];
    const done = job.state === 'done';
    // Everything except the one shortcut on the row lives in the kebab menu.
    const items: ActionMenuItem[] = [
        ...item('resume', 'Resume', job.canResume),
        ...item('retry', paused ? 'Start over' : 'Retry', job.canRetry),
        ...item('retry-register', 'Retry register', job.canRetryRegister),
        ...item('copy-url', 'Copy direct URL', done && job.embedUrl !== null),
        ...item('open', 'Open on site', done && job.embedUrl !== null),
        ...item('view-library', 'View in Library', done),
        ...item('details', 'View details', hasDetailsView(job.state)),
        ...item('cancel', 'Cancel', job.canCancel, true),
        ...item('remove', 'Remove', job.canRemove, true),
    ];

    // The thumbnail copy goes by video id through Rust, so it needs a registered video that
    // already has a thumbnail.
    const quickActions: QuickAction[] = [
        ...(done && job.embedUrl !== null ? (['shortcode'] as const) : []),
        ...(done && job.videoId !== undefined && (job.thumbnailUrl ?? null) !== null
            ? (['thumbnail-url'] as const)
            : []),
    ];

    return (
        <li
            className={`job job-${kind} row-surface`}
            data-state={job.state}
            data-job-id={job.id}
            data-network-wait={job.waitingForNetwork ? 'true' : undefined}
        >
            {/* Rust supplies the thumbnail URL when it knows it; else the neutral media tile. */}
            <MediaTile thumbnailUrl={job.thumbnailUrl ?? null} />
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
                <JobStateChip job={job} />
                {running && <JobProgress fileName={job.fileName} progress={job.progress} />}
                {running && job.waitingForNetwork && (
                    <p className="job-note">Retrying automatically</p>
                )}
                {note !== null && !running && (
                    <p className="job-note" title={note}>
                        {note}
                    </p>
                )}
                {paused && (
                    <p className="job-note">
                        Temporary files are kept on disk until you resume or remove this video.
                    </p>
                )}
            </div>

            <div className="job-actions">
                <VideoQuickActions
                    title={name}
                    busy={pending}
                    actions={quickActions}
                    onQuick={(action) => {
                        if (action === 'shortcode') onAction('copy-shortcode', job);
                        else if (action === 'thumbnail-url') onAction('copy-thumbnail', job);
                    }}
                    menu={
                        items.length > 0 ? (
                            <ActionMenu
                                label={`More actions for ${name}`}
                                items={items}
                                disabled={pending}
                            />
                        ) : undefined
                    }
                />
            </div>
        </li>
    );
}
