import { useState } from 'react';
import type { ActionResult, JobDto } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { DetailsDialog } from '../components/DetailsDialog';
import { DropZone } from '../components/DropZone';
import { JobRow, useNow, type JobAction } from '../components/JobRow';
import { QueueBanners } from '../components/QueueBanners';
import { plural } from '../lib/format';
import { isRunning } from '../lib/jobState';
import { finishedCount, useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';

type Confirm = { kind: 'cancel'; job: JobDto } | { kind: 'clear'; count: number } | null;

export function QueueScreen() {
    const { api, jobs, summary } = useApp();
    const toast = useToast();
    const now = useNow();
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [detailsId, setDetailsId] = useState<string | null>(null);

    const details = detailsId === null ? undefined : jobs.find((job) => job.id === detailsId);
    const finished = finishedCount(jobs);

    /** Runs an action; failures from the main process are shown as an error toast. */
    async function run(
        id: string | null,
        action: () => Promise<ActionResult>,
        success?: string,
    ): Promise<void> {
        if (id !== null) setPending((set) => new Set(set).add(id));

        try {
            const result = await action();

            if (!result.ok) toast.show('error', result.error);
            else if (success !== undefined) toast.show('success', success);
        } catch {
            toast.show('error', 'Something went wrong. Please try again.');
        } finally {
            if (id !== null) {
                setPending((set) => {
                    const next = new Set(set);

                    next.delete(id);

                    return next;
                });
            }
        }
    }

    function onAction(action: JobAction, job: JobDto): void {
        switch (action) {
            case 'cancel':
                // Stopping a running job throws its work away: ask first.
                if (isRunning(job)) setConfirm({ kind: 'cancel', job });
                else void run(job.id, () => api.jobs.cancel(job.id));

                break;
            case 'retry':
                void run(job.id, () => api.jobs.retry(job.id));
                break;
            case 'retry-register':
                void run(job.id, () => api.jobs.retryRegister(job.id));
                break;
            case 'remove':
                void run(job.id, () => api.jobs.remove(job.id));
                break;
            case 'copy-url':
                void run(job.id, () => api.jobs.copy(job.id, 'embed-url'), 'Embed URL copied.');
                break;
            case 'copy-shortcode':
                void run(job.id, () => api.jobs.copy(job.id, 'shortcode'), 'Shortcode copied.');
                break;
            case 'open':
                void run(job.id, () => api.jobs.openEmbed(job.id));
                break;
            case 'details':
                setDetailsId(job.id);
                break;
        }
    }

    function clearFinished(): void {
        if (finished > 0) setConfirm({ kind: 'clear', count: finished });
    }

    return (
        <div className="queue">
            <QueueBanners />
            <DropZone compact={jobs.length > 0} />

            <section className="queue-list" aria-labelledby="queue-heading">
                <div className="section-head">
                    <h2 id="queue-heading">Queue</h2>
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={finished === 0}
                        onClick={clearFinished}
                    >
                        Clear finished
                    </button>
                </div>

                {jobs.length === 0 ? (
                    <p className="empty">Drop video files here, or click Add videos</p>
                ) : (
                    <ul className="jobs" aria-label="Video queue">
                        {jobs.map((job) => (
                            <JobRow
                                key={job.id}
                                job={job}
                                now={now}
                                pending={pending.has(job.id)}
                                onAction={onAction}
                            />
                        ))}
                    </ul>
                )}
            </section>

            <footer className="queue-footer" role="status" aria-live="polite">
                <span className="num">{summary.running} running</span>
                <span className="num">{summary.waiting} waiting</span>
                <span className="num">{summary.done} done</span>
                <span className="num">{summary.failed} failed</span>
            </footer>

            {confirm?.kind === 'cancel' && (
                <ConfirmDialog
                    title="Cancel this video?"
                    message={`"${confirm.job.fileName}" is being processed. Cancelling stops it and discards the work done so far.`}
                    confirmLabel="Cancel video"
                    cancelLabel="Keep running"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const { job } = confirm;

                        setConfirm(null);
                        void run(job.id, () => api.jobs.cancel(job.id));
                    }}
                />
            )}
            {confirm?.kind === 'clear' && (
                <ConfirmDialog
                    title="Clear finished videos?"
                    message={`This removes ${plural(confirm.count, 'finished video')} from the list. Videos already on your site are not affected.`}
                    confirmLabel="Clear finished"
                    cancelLabel="Keep"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        setConfirm(null);
                        void run(null, () => api.jobs.clearFinished());
                    }}
                />
            )}
            {details !== undefined && (
                <DetailsDialog job={details} onClose={() => setDetailsId(null)} />
            )}
        </div>
    );
}
