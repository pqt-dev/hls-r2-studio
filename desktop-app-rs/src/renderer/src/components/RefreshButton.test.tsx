import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RefreshButton } from './RefreshButton';

describe('RefreshButton', () => {
    it('is an icon-only neutral button named Refresh', async () => {
        const onClick = vi.fn();

        render(<RefreshButton onClick={onClick} />);

        const button = screen.getByRole('button', { name: 'Refresh' });

        expect(button).toHaveAttribute('title', 'Refresh');
        expect(button).toHaveAttribute('aria-busy', 'false');
        expect(button).not.toHaveClass('is-spinning');
        expect(button.querySelector('svg.icon')).not.toBeNull();
        expect(button).toHaveTextContent('');

        button.click();
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('spins and reports busy without changing its name or being disabled', () => {
        render(<RefreshButton busy onClick={() => undefined} />);

        const button = screen.getByRole('button', { name: 'Refresh' });

        expect(button).toHaveAttribute('aria-busy', 'true');
        expect(button).toHaveClass('is-spinning');
        expect(button).toBeEnabled();
    });

    it('has a compact and a control size', () => {
        const { rerender } = render(<RefreshButton onClick={() => undefined} />);

        expect(screen.getByRole('button')).toHaveClass('btn-sm');
        rerender(<RefreshButton size="control" className="extra" onClick={() => undefined} />);
        expect(screen.getByRole('button')).toHaveClass('btn-control', 'extra');
        expect(screen.getByRole('button')).not.toHaveClass('btn-sm');
    });
});
