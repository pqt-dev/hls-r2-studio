import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import type { ActionResult, JobDto } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { DetailsDialog } from '../components/DetailsDialog';
import { DropZone } from '../components/DropZone';
import { JobRow, useNow, type JobAction } from '../components/JobRow';
import { QueueBanners } from '../components/QueueBanners';
import { plural } from '../lib/format';
import { isRunning } from '../lib/jobState';
import { sortJobsForQueue } from '../lib/queueOrder';
import { finishedCount, useApp } from '../state/AppProvider';
import { useNavigation } from '../state/Navigation';
import { useToast } from '../state/Toasts';

type Confirm =
    | { kind: 'cancel'; job: JobDto }
    | { kind: 'start-over'; job: JobDto }
    | { kind: 'remove-paused'; job: JobDto }
    | { kind: 'clear'; count: number }
    | null;

export function QueueScreen() {
    const { api, jobs, summary } = useApp();
    const toast = useToast();
    const { openLibraryVideo } = useNavigation();
    const now = useNow();
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [detailsId, setDetailsId] = useState<string | null>(null);

    const listRef = useRef<HTMLUListElement>(null);
    // The job button that has the focus, so the focus survives a job moving to another group.
    const focusTarget = useRef<{ id: string; label: string } | null>(null);

    const details = detailsId === null ? undefined : jobs.find((job) => job.id === detailsId);
    const finished = finishedCount(jobs);
    // Display order only; `details` above and the footer counts use the original list.
    const ordered = useMemo(() => sortJobsForQueue(jobs), [jobs]);

    // Rows are keyed by job id, so a job that changes group is moved, not recreated. Moving a DOM
    // node can drop its focus: give it back when it vanished with the reorder (not when the user
    // moved the focus away on purpose; focusout/pointerdown clear the target in that case).
    useLayoutEffect(() => {
        const target = focusTarget.current;
        const list = listRef.current;

        if (target === null || list === null) return;

        const active = document.activeElement;

        if (active !== null && active !== document.body && list.contains(active)) return;

        for (const row of list.querySelectorAll<HTMLElement>('li[data-job-id]')) {
            if (row.dataset.jobId !== target.id) continue;

            for (const button of row.querySelectorAll<HTMLButtonElement>('button')) {
                if (button.getAttribute('aria-label') === target.label) {
                    button.focus({ preventScroll: true });
                }
            }
        }
    }, [ordered]);

    useEffect(() => {
        function onPointerDown(event: PointerEvent): void {
            if (!(event.target instanceof Node) || !listRef.current?.contains(event.target)) {
                focusTarget.current = null;
            }
        }

        document.addEventListener('pointerdown', onPointerDown, true);

        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, []);

    function trackFocus(event: FocusEvent<HTMLUListElement>): void {
        const button = event.target;
        const id = button.closest<HTMLElement>('li[data-job-id]')?.dataset.jobId;

        focusTarget.current =
            id !== undefined && button.tagName === 'BUTTON'
                ? { id, label: button.getAttribute('aria-label') ?? '' }
                : null;
    }

    function releaseFocus(event: FocusEvent<HTMLUListElement>): void {
        // Focus moving to another element is deliberate; a plain blur (null) may be a DOM move.
        if (event.relatedTarget !== null) focusTarget.current = null;
    }

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
                // A paused upload holds saved progress: starting over discards it.
                if (job.state === 'upload_interrupted') setConfirm({ kind: 'start-over', job });
                else void run(job.id, () => api.jobs.retry(job.id));

                break;
            case 'resume':
                void run(job.id, () => api.jobs.resume(job.id));
                break;
            case 'retry-register':
                void run(job.id, () => api.jobs.retryRegister(job.id));
                break;
            case 'remove':
                if (job.state === 'upload_interrupted') setConfirm({ kind: 'remove-paused', job });
                else void run(job.id, () => api.jobs.remove(job.id));

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
            case 'view-library':
                openLibraryVideo(job.videoId);
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
                        className="btn btn-sm btn-accent-danger"
                        disabled={finished === 0}
                        onClick={clearFinished}
                    >
                        Clear finished
                    </button>
                </div>

                {jobs.length === 0 ? (
                    <p className="empty">Drop videos here to upload, or click Upload videos</p>
                ) : (
                    <ul
                        ref={listRef}
                        className="jobs"
                        aria-label="Video queue"
                        onFocus={trackFocus}
                        onBlur={releaseFocus}
                    >
                        {ordered.map((job) => (
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
                {summary.attention > 0 && (
                    <span className="num">{summary.attention} need attention</span>
                )}
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
            {confirm?.kind === 'start-over' && (
                <ConfirmDialog
                    title="Start over?"
                    message={`The saved progress for ${confirm.job.fileName} will be discarded and the video will be processed again from the beginning.`}
                    confirmLabel="Start over"
                    cancelLabel="Keep paused"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const { job } = confirm;

                        setConfirm(null);
                        void run(job.id, () => api.jobs.retry(job.id));
                    }}
                />
            )}
            {confirm?.kind === 'remove-paused' && (
                <ConfirmDialog
                    title="Remove this video?"
                    message={`The temporary files for ${confirm.job.fileName} will be deleted, so it can no longer be resumed.`}
                    confirmLabel="Remove"
                    cancelLabel="Keep"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const { job } = confirm;

                        setConfirm(null);
                        void run(job.id, () => api.jobs.remove(job.id));
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
