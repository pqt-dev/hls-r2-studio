import { useState } from 'react';
import type { JobDto } from '../../../shared/ipc';
import { copyText } from '../lib/clipboard';
import { stageLabel } from '../lib/format';
import { useToast } from '../state/Toasts';
import { Dialog } from './Dialog';

/** Plain-text version of the details, used by the Copy button. */
export function detailsText(job: JobDto): string {
    const detail = job.errorDetail;
    const lines = [
        `File: ${job.fileName}`,
        `Status: ${stageLabel(job.state)}`,
        `Message: ${job.errorMessage ?? 'none'}`,
    ];

    if (detail !== null) {
        lines.push(`Failing step: ${stageLabel(detail.step)}`);
        lines.push(`Exit code: ${detail.exitCode ?? 'n/a'}`);
        lines.push('', 'ffmpeg output (last lines):', ...detail.stderrTail);
    }

    return lines.join('\n');
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
                <dt>Message</dt>
                <dd>{job.errorMessage ?? 'No message was recorded.'}</dd>
                {detail !== null && (
                    <>
                        <dt>Failing step</dt>
                        <dd>{stageLabel(detail.step)}</dd>
                        <dt>Exit code</dt>
                        <dd className="num">{detail.exitCode ?? 'Not available'}</dd>
                    </>
                )}
            </dl>

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
