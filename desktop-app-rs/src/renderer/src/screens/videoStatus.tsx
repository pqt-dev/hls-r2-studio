const STATUS_LABELS: Record<string, { label: string; chip: string }> = {
    ready: { label: 'Ready', chip: 'chip-done' },
    processing: { label: 'Processing', chip: 'chip-running' },
    pending: { label: 'Pending', chip: '' },
    failed: { label: 'Failed', chip: 'chip-failed' },
};

/** Status chip shared by the Library list and the video detail page. */
export function StatusBadge({ status }: { status: string }) {
    const known = Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined;
    const { label, chip } = known ?? { label: 'Unknown', chip: '' };

    return <span className={`chip ${chip}`.trim()}>{label}</span>;
}
