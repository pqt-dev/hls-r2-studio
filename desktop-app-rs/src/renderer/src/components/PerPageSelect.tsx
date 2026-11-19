import { useId } from 'react';
import { SelectBox } from './SelectBox';

/**
 * The one "Per page" select (Library toolbar, Queue pager row): a small label and the shared
 * select with the allowed page sizes. The caller owns the value and resets its page on change.
 */
export function PerPageSelect({
    value,
    options,
    onChange,
}: {
    value: number;
    options: readonly number[];
    onChange: (size: number) => void;
}) {
    const id = useId();

    return (
        <div className="per-page">
            <label htmlFor={id}>Per page</label>
            <SelectBox
                id={id}
                aria-label="Items per page"
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
            >
                {options.map((size) => (
                    <option key={size} value={size}>
                        {size}
                    </option>
                ))}
            </SelectBox>
        </div>
    );
}
