import { useEffect, useRef, useState } from 'react';
import type { JobDto } from '../../../shared/ipc';
import { copyText } from '../lib/clipboard';
import { formatDateTime, formatTimeOfDay, stageLabel } from '../lib/format';
import { isFinished } from '../lib/jobState';
import { useToast } from '../state/Toasts';
import { Dialog } from './Dialog';

/** Plain-text version of the details, used by the Copy button. */
export function detailsText(job: JobDto): string {
    const detail = job.errorDetail;
    const lines = [`File: ${job.fileName}`, `Status: ${stageLabel(job.state)}`];

    if (job.errorMessage !== null) lines.push(`Message: ${job.errorMessage}`);

    if (detail !== null) {
        lines.push(`Failing step: ${stageLabel(detail.step)}`);
        lines.push(`Exit code: ${detail.exitCode ?? 'n/a'}`);
        lines.push('', 'ffmpeg output (last lines):', ...detail.stderrTail);
    }

    lines.push('', 'Activity:');

    if (job.activity.length === 0) lines.push('No activity was recorded.');

    for (const entry of job.activity) {
        lines.push(`${formatTimeOfDay(entry.at)} ${entry.text}`);
    }

    return lines.join('\n');
}

/** Distance from the bottom (px) within which the list counts as "following" new lines. */
const FOLLOW_SLACK = 8;

/**
 * Activity lines, oldest first. While the job is still running the list follows new lines, unless
 * the user scrolled up to read earlier ones.
 */
function ActivityLog({ job }: { job: JobDto }) {
    const list = useRef<HTMLOListElement>(null);
    const following = useRef(true);
    const live = !isFinished(job.state);

    useEffect(() => {
        const node = list.current;

        if (live && following.current && node !== null) node.scrollTop = node.scrollHeight;
    }, [live, job.activity.length]);

    function onScroll(): void {
        const node = list.current;

        if (node === null) return;

        following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
    }

    if (job.activity.length === 0) {
        return <p className="muted small">No activity was recorded.</p>;
    }

    return (
        <ol
            className="log activity-log"
            tabIndex={0}
            aria-label="Activity"
            ref={list}
            onScroll={onScroll}
        >
            {job.activity.map((entry, index) => (
                <li
                    key={`${entry.at}-${index}`}
                    className={entry.level === 'error' ? 'activity-error' : undefined}
                >
                    <time dateTime={entry.at} title={formatDateTime(entry.at)}>
                        {formatTimeOfDay(entry.at)}
                    </time>
                    <span className="break">{entry.text}</span>
                </li>
            ))}
        </ol>
    );
}

export function DetailsDialog({ job, onClose }: { job: JobDto; onClose: () => void }) {
    const toast = useToast();
    const [copying, setCopying] = useState(false);
    const detail = job.errorDetail;

    async function copy(): Promise<void> {
        setCopying(true);

        const ok = await copyText(detailsText(job));

        setCopying(false);

        if (ok) toast.show('success', 'Details copied.');
        else toast.show('error', 'Could not copy the details.');
    }

    return (
        <Dialog
            title="Job details"
            onClose={onClose}
            wide
            footer={
                <>
                    <button
                        type="button"
                        className="btn"
                        disabled={copying}
                        onClick={() => void copy()}
                    >
                        Copy details
                    </button>
                    <button type="button" className="btn btn-primary" onClick={onClose}>
                        Close
                    </button>
                </>
            }
        >
            <dl className="facts">
                <dt>File</dt>
                <dd className="break">{job.fileName}</dd>
                <dt>Status</dt>
                <dd>{stageLabel(job.state)}</dd>
                {job.errorMessage !== null && (
                    <>
                        <dt>Message</dt>
                        <dd>{job.errorMessage}</dd>
                    </>
                )}
                {detail !== null && (
                    <>
                        <dt>Failing step</dt>
                        <dd>{stageLabel(detail.step)}</dd>
                        <dt>Exit code</dt>
                        <dd className="num">{detail.exitCode ?? 'Not available'}</dd>
                    </>
                )}
            </dl>

            <h3 className="subheading">Activity</h3>
            <ActivityLog job={job} />

            {job.state === 'upload_interrupted' && (
                <p className="muted small">
                    The processed files are kept on disk so Resume can continue without converting
                    the video again. They are deleted when you resume successfully, start over or
                    remove this video.
                </p>
            )}

            {detail !== null && job.state !== 'upload_interrupted' && (
                <>
                    <h3 className="subheading">ffmpeg output (last lines)</h3>
                    <pre className="log" tabIndex={0} aria-label="ffmpeg output">
                        {detail.stderrTail.length > 0
                            ? detail.stderrTail.join('\n')
                            : 'No output was captured.'}
                    </pre>
                    <p className="muted small">Personal paths are removed from this output.</p>
                </>
            )}
        </Dialog>
    );
}
