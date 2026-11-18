import type { SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from './icons';

/**
 * The app's one styled select (Fluent): a native `<select>` (keyboard and screen reader support
 * stay native) without the platform look, with a Fluent chevron on the right. Same height, border
 * and focus accent as the text inputs. Pass the usual select props and `<option>` children.
 */
export function SelectBox(props: SelectHTMLAttributes<HTMLSelectElement>) {
    const { className, children, ...rest } = props;

    return (
        <div className={className === undefined ? 'select' : `select ${className}`}>
            <select {...rest}>{children}</select>
            <ChevronDownIcon />
        </div>
    );
}
