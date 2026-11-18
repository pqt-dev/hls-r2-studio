const STATUS_LABELS: Record<string, { label: string; chip: string }> = {
    ready: { label: 'Ready', chip: 'chip--ready' },
    processing: { label: 'Processing', chip: 'chip--processing' },
    pending: { label: 'Pending', chip: 'chip--pending' },
    failed: { label: 'Failed', chip: 'chip--failed' },
};

/** Status chip (colored dot + label) shared by the Library, Home and the video detail page. */
export function StatusBadge({ status }: { status: string }) {
    const known = Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined;
    const { label, chip } = known ?? { label: 'Unknown', chip: 'chip--neutral' };

    return <span className={`chip chip--dot ${chip}`}>{label}</span>;
}
