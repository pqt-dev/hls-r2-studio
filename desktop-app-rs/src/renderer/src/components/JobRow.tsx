import { useEffect, useState, type ReactNode } from 'react';
import type { JobDto } from '../../../shared/ipc';
import { formatBytes, formatDateTime, formatRelativeTime } from '../lib/format';
import { JobProgress } from './JobProgress';
import { JobStateChip } from './JobStateChip';
import { MediaTile } from './MediaTile';
import { CloseIcon, InfoIcon, LibraryIcon, PlayIcon, RefreshIcon, TrashIcon } from './icons';
import { QUICK_ACCENT_CLASS, QuickIconButton } from './VideoQuickActions';
import { hasDetailsView, isRunning, statusKind } from '../lib/jobState';

export type JobAction =
    'cancel' | 'retry' | 'retry-register' | 'resume' | 'remove' | 'view-library' | 'details';

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

interface RowButton {
    action: JobAction;
    label: string;
    icon: ReactNode;
}

/** Actions that can carry the accent, in priority order. */
const ACCENT_ORDER: readonly JobAction[] = ['view-library', 'resume', 'retry', 'retry-register'];

/**
 * Every action of a row as a visible icon-only button, in display order: primary actions, then
 * View details, Cancel, and Remove last. Queue rows only manage the local job: no copy/open of
 * site links here (Library has them). Each action appears at most once.
 */
function actionButtons(job: JobDto): RowButton[] {
    const all: Array<RowButton & { enabled: boolean }> = [
        {
            action: 'view-library',
            label: 'View in Library',
            icon: <LibraryIcon />,
            enabled: job.state === 'done',
        },
        { action: 'resume', label: 'Resume', icon: <PlayIcon />, enabled: job.canResume },
        {
            action: 'retry',
            label: job.state === 'upload_interrupted' ? 'Start over' : 'Retry',
            icon: <RefreshIcon />,
            enabled: job.canRetry,
        },
        {
            action: 'retry-register',
            label: 'Retry register',
            icon: <RefreshIcon />,
            enabled: job.canRetryRegister,
        },
        {
            action: 'details',
            label: 'View details',
            icon: <InfoIcon />,
            enabled: hasDetailsView(job.state),
        },
        { action: 'cancel', label: 'Cancel', icon: <CloseIcon />, enabled: job.canCancel },
        { action: 'remove', label: 'Remove', icon: <TrashIcon />, enabled: job.canRemove },
    ];

    return all
        .filter((button) => button.enabled)
        .map(({ action, label, icon }) => ({
            action,
            label,
            icon,
        }));
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
    const buttons = actionButtons(job);
    // The accent is the primary action: View in Library, else Resume/Retry/Retry register, else
    // Cancel when it is the only way forward (running and waiting rows).
    const accent =
        buttons.find((button) => ACCENT_ORDER.includes(button.action)) ??
        buttons.find((button) => button.action === 'cancel');

    return (
        <li
            className={`job job-${kind} row-surface`}
            data-state={job.state}
            data-job-id={job.id}
            data-network-wait={job.waitingForNetwork ? 'true' : undefined}
        >
            {/* Local data only: the thumbnail URL stored in the job record at completion. Jobs
                finished before it was stored have none and keep the neutral media tile. */}
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
                {buttons.map((button) => (
                    <QuickIconButton
                        key={button.action}
                        className={
                            button === accent
                                ? QUICK_ACCENT_CLASS
                                : button.action === 'remove'
                                  ? 'btn btn-sm video-quick job-remove'
                                  : 'btn btn-sm video-quick'
                        }
                        ariaLabel={`${button.label} for ${name}`}
                        label={button.label}
                        icon={button.icon}
                        busy={pending}
                        onClick={() => onAction(button.action, job)}
                    />
                ))}
            </div>
        </li>
    );
}
