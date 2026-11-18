import { useId, useState, type FormEvent } from 'react';
import { plural } from '../lib/format';
import { ChevronLeftIcon, ChevronRightIcon, FirstPageIcon, LastPageIcon } from './icons';
import { parseJump } from '../lib/pagination';

/**
 * WordPress-style pager on one line, right-aligned: the count ("239 videos"), icon-only
 * First / Previous buttons, the current page as a small input (type a number and press Enter
 * to jump), "of LAST", and icon-only Next / Last buttons.
 * With a single page only the count is shown.
 */
export function Pagination({
    page,
    lastPage,
    total,
    noun = 'video',
    onPageChange,
    label = 'Pagination',
}: {
    page: number;
    lastPage: number;
    total: number;
    /** What is counted in the summary ("3 videos", "3 logs"). */
    noun?: string;
    onPageChange: (page: number) => void;
    /** Accessible name of the navigation (two pagers on one screen need different names). */
    label?: string;
}) {
    const last = Math.max(1, lastPage);
    const current = Math.min(last, Math.max(1, page));
    // null = show the current page; a string = what the user is typing right now.
    const [draft, setDraft] = useState<string | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const jumpId = useId();
    const hintId = `${jumpId}-hint`;

    function go(target: number): void {
        if (target !== current) onPageChange(target);
    }

    function submit(event: FormEvent): void {
        event.preventDefault();

        const target = parseJump(draft ?? String(current), last);

        if (target === null) {
            setHint(`Enter a page number from 1 to ${last}.`);

            return;
        }

        setHint(null);
        setDraft(null);
        go(target);
    }

    const summary = (
        <span className="num pager-summary" role="status">
            {plural(total, noun)}
        </span>
    );
    if (last === 1) {
        return (
            <nav className="pager" aria-label={label}>
                <div className="pager-nav">{summary}</div>
            </nav>
        );
    }

    return (
        <nav className="pager" aria-label={label}>
            <div className="pager-nav">
                {summary}
                <div className="pager-controls">
                    <button
                        type="button"
                        className="btn btn-sm pager-btn"
                        aria-label="First page"
                        disabled={current <= 1}
                        onClick={() => go(1)}
                    >
                        <FirstPageIcon />
                    </button>
                    <button
                        type="button"
                        className="btn btn-sm pager-btn"
                        aria-label="Previous page"
                        disabled={current <= 1}
                        onClick={() => go(current - 1)}
                    >
                        <ChevronLeftIcon />
                    </button>
                    <form className="pager-jump" onSubmit={submit} noValidate>
                        <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            aria-label="Current page"
                            value={draft ?? String(current)}
                            aria-invalid={hint !== null}
                            aria-describedby={hint === null ? undefined : hintId}
                            onChange={(event) => {
                                setDraft(event.target.value);
                                setHint(null);
                            }}
                            onBlur={() => {
                                setDraft(null);
                                setHint(null);
                            }}
                        />
                        <span className="num pager-of">of {last}</span>
                        {hint !== null && (
                            <p id={hintId} role="alert" className="pager-hint">
                                {hint}
                            </p>
                        )}
                    </form>
                    <button
                        type="button"
                        className="btn btn-sm pager-btn"
                        aria-label="Next page"
                        disabled={current >= last}
                        onClick={() => go(current + 1)}
                    >
                        <ChevronRightIcon />
                    </button>
                    <button
                        type="button"
                        className="btn btn-sm pager-btn"
                        aria-label="Last page"
                        disabled={current >= last}
                        onClick={() => go(last)}
                    >
                        <LastPageIcon />
                    </button>
                </div>
            </div>
        </nav>
    );
}
