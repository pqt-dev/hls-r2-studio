import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PerPageSelect } from './PerPageSelect';

describe('PerPageSelect', () => {
    it('shows the "Per page" label, the options and the current value', () => {
        render(<PerPageSelect value={20} options={[10, 20, 50]} onChange={() => {}} />);

        const select = screen.getByRole('combobox', { name: 'Items per page' });

        expect(screen.getByText('Per page')).toBeInTheDocument();
        expect(
            within(select)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['10', '20', '50']);
        expect(select).toHaveValue('20');
        // The shared select draws its chevron as an inline SVG.
        expect(select.closest('.select')?.querySelector('svg.icon')).not.toBeNull();
    });

    it('reports the chosen size as a number', async () => {
        const onChange = vi.fn();

        render(<PerPageSelect value={20} options={[10, 20, 50]} onChange={onChange} />);
        await userEvent.selectOptions(
            screen.getByRole('combobox', { name: 'Items per page' }),
            '50',
        );

        expect(onChange).toHaveBeenCalledWith(50);
    });
});
