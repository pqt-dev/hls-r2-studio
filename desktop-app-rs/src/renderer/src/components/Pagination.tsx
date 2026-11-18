import { useId, useState, type FormEvent } from 'react';
import { plural } from '../lib/format';
import { pageWindow, parseJump } from '../lib/pagination';

/**
 * Pager: First, Previous, numbered pages with gaps, Next, Last, and a "Go to page" field.
 * With a single page only the summary text is shown (nothing to move to). Below ~520px of
 * container width the numbers collapse to the current one (CSS container query).
 */
export function Pagination({
    page,
    lastPage,
    total,
    onPageChange,
}: {
    page: number;
    lastPage: number;
    total: number;
    onPageChange: (page: number) => void;
}) {
    const last = Math.max(1, lastPage);
    const current = Math.min(last, Math.max(1, page));
    const [jump, setJump] = useState('');
    const [hint, setHint] = useState<string | null>(null);
    const jumpId = useId();
    const hintId = `${jumpId}-hint`;

    function go(target: number): void {
        if (target !== current) onPageChange(target);
    }

    function submit(event: FormEvent): void {
        event.preventDefault();

        const target = parseJump(jump, last);

        if (target === null) {
            setHint(`Enter a page number from 1 to ${last}.`);

            return;
        }

        setHint(null);
        setJump('');
        go(target);
    }

    const summary = (
        <span className="num pager-summary" role="status">
            Page {current} of {last}
            {' · '}
            {plural(total, 'video')}
        </span>
    );

    if (last === 1) {
        return (
            <nav className="pager" aria-label="Pagination">
                {summary}
            </nav>
        );
    }

    return (
        <nav className="pager" aria-label="Pagination">
            <div className="pager-controls">
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label="First page"
                    disabled={current <= 1}
                    onClick={() => go(1)}
                >
                    <span aria-hidden="true">{'«'}</span> First
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label="Previous page"
                    disabled={current <= 1}
                    onClick={() => go(current - 1)}
                >
                    <span aria-hidden="true">{'‹'}</span> Previous
                </button>
                {pageWindow(current, last).map((item) =>
                    typeof item === 'number' ? (
                        <button
                            key={item}
                            type="button"
                            className="btn btn-sm pager-number"
                            aria-label={`Page ${item}`}
                            aria-current={item === current ? 'page' : undefined}
                            onClick={() => go(item)}
                        >
                            {item}
                        </button>
                    ) : (
                        <span key={item} className="pager-gap" aria-hidden="true">
                            {'…'}
                        </span>
                    ),
                )}
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label="Next page"
                    disabled={current >= last}
                    onClick={() => go(current + 1)}
                >
                    Next <span aria-hidden="true">{'›'}</span>
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label="Last page"
                    disabled={current >= last}
                    onClick={() => go(last)}
                >
                    Last <span aria-hidden="true">{'»'}</span>
                </button>
            </div>
            {summary}
            <form className="pager-jump" onSubmit={submit} noValidate>
                <label htmlFor={jumpId}>Go to page</label>
                <input
                    id={jumpId}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={jump}
                    aria-invalid={hint !== null}
                    aria-describedby={hint === null ? undefined : hintId}
                    onChange={(event) => {
                        setJump(event.target.value);
                        setHint(null);
                    }}
                />
                <button type="submit" className="btn btn-sm">
                    Go
                </button>
                {hint !== null && (
                    <p id={hintId} role="alert" className="pager-hint">
                        {hint}
                    </p>
                )}
            </form>
        </nav>
    );
}
