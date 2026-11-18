import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectBox } from './SelectBox';

describe('SelectBox', () => {
    it('is a native select with a Fluent chevron icon and passes its props through', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();

        render(
            <>
                <label htmlFor="size">Size</label>
                <SelectBox id="size" value="b" onChange={onChange}>
                    <option value="a">A</option>
                    <option value="b">B</option>
                </SelectBox>
            </>,
        );

        const select = screen.getByRole('combobox', { name: 'Size' });

        expect(select.tagName).toBe('SELECT');
        expect(select.parentElement).toHaveClass('select');
        expect(select.parentElement?.querySelector('svg.icon path')).not.toBeNull();

        await user.selectOptions(select, 'a');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('can be disabled and keeps extra classes', () => {
        render(
            <SelectBox className="wide" disabled aria-label="Mode">
                <option>One</option>
            </SelectBox>,
        );

        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeDisabled();
        expect(screen.getByRole('combobox').parentElement).toHaveClass('select', 'wide');
    });
});
