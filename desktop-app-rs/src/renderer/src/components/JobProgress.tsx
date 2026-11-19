/**
 * The progress bar of a running job (native `<progress>` plus the percent), shared by the Queue
 * rows and the Home running list. The bar is named after the file.
 */
export function JobProgress({ fileName, progress }: { fileName: string; progress: number }) {
    return (
        <div className="job-progress">
            <progress max={100} value={progress} aria-label={`Progress of ${fileName}`} />
            <span className="num job-percent">{progress}%</span>
        </div>
    );
}
