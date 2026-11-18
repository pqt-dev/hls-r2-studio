import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';

function setup(page: number, lastPage: number, total = lastPage * 24) {
    const onPageChange = vi.fn();
    const user = userEvent.setup();

    render(
        <Pagination page={page} lastPage={lastPage} total={total} onPageChange={onPageChange} />,
    );

    return { onPageChange, user };
}

const nav = () => within(screen.getByRole('navigation', { name: 'Pagination' }));

describe('Pagination', () => {
    it('shows the summary and the numbers with gaps for many pages', () => {
        setup(6, 1000, 24000);

        expect(nav().getByText('Page 6 of 1000 · 24000 videos')).toBeInTheDocument();
        expect(
            nav()
                .getAllByRole('button', { name: /^Page \d+$/ })
                .map((button) => button.textContent),
        ).toEqual(['1', '4', '5', '6', '7', '8', '1000']);
        expect(nav().getByRole('button', { name: 'Page 6' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        expect(
            nav()
                .getAllByRole('button', { name: /^Page \d+$/ })
                .filter((b) => b.hasAttribute('aria-current')),
        ).toHaveLength(1);
        // The gaps are not interactive and not announced.
        expect(document.querySelectorAll('.pager-gap')).toHaveLength(2);
        expect(nav().queryByRole('button', { name: '…' })).toBeNull();
    });

    it('labels the controls', () => {
        setup(3, 9);

        for (const name of ['First page', 'Previous page', 'Next page', 'Last page', 'Go']) {
            expect(nav().getByRole('button', { name })).toBeInTheDocument();
        }

        expect(nav().getByRole('textbox', { name: 'Go to page' })).toHaveAttribute(
            'inputmode',
            'numeric',
        );
    });

    it('disables First and Previous on the first page, Next and Last on the last', () => {
        const { unmount } = render(
            <Pagination page={1} lastPage={5} total={100} onPageChange={() => undefined} />,
        );

        expect(nav().getByRole('button', { name: 'First page' })).toBeDisabled();
        expect(nav().getByRole('button', { name: 'Previous page' })).toBeDisabled();
        expect(nav().getByRole('button', { name: 'Next page' })).toBeEnabled();
        expect(nav().getByRole('button', { name: 'Last page' })).toBeEnabled();
        unmount();

        render(<Pagination page={5} lastPage={5} total={100} onPageChange={() => undefined} />);
        expect(nav().getByRole('button', { name: 'Next page' })).toBeDisabled();
        expect(nav().getByRole('button', { name: 'Last page' })).toBeDisabled();
        expect(nav().getByRole('button', { name: 'First page' })).toBeEnabled();
    });

    it('goes to First, Previous, a number, Next and Last', async () => {
        const { onPageChange, user } = setup(6, 20);

        await user.click(nav().getByRole('button', { name: 'First page' }));
        await user.click(nav().getByRole('button', { name: 'Previous page' }));
        await user.click(nav().getByRole('button', { name: 'Page 8' }));
        await user.click(nav().getByRole('button', { name: 'Next page' }));
        await user.click(nav().getByRole('button', { name: 'Last page' }));

        expect(onPageChange.mock.calls.map((call) => call[0])).toEqual([1, 5, 8, 7, 20]);
    });

    it('does nothing when the current page is clicked', async () => {
        const { onPageChange, user } = setup(6, 20);

        await user.click(nav().getByRole('button', { name: 'Page 6' }));
        expect(onPageChange).not.toHaveBeenCalled();
    });

    it('jumps to a valid page with the Go button and clears the field', async () => {
        const { onPageChange, user } = setup(1, 50);
        const field = nav().getByRole('textbox', { name: 'Go to page' });

        await user.type(field, '12');
        await user.click(nav().getByRole('button', { name: 'Go' }));

        expect(onPageChange).toHaveBeenCalledExactlyOnceWith(12);
        expect(field).toHaveValue('');
        expect(nav().queryByRole('alert')).toBeNull();
    });

    it('submits with Enter', async () => {
        const { onPageChange, user } = setup(1, 50);

        await user.type(nav().getByRole('textbox', { name: 'Go to page' }), '7{Enter}');
        expect(onPageChange).toHaveBeenCalledExactlyOnceWith(7);
    });

    it.each([
        ['999', 50],
        ['0', 1],
    ])('clamps %s into 1..last', async (text, expected) => {
        const { onPageChange, user } = setup(10, 50);

        await user.type(nav().getByRole('textbox', { name: 'Go to page' }), `${text}{Enter}`);
        expect(onPageChange).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it.each(['', 'abc', '-2', '1.5'])('ignores %j with an inline hint', async (text) => {
        const { onPageChange, user } = setup(3, 50);
        const field = nav().getByRole('textbox', { name: 'Go to page' });

        if (text !== '') await user.type(field, text);

        await user.click(nav().getByRole('button', { name: 'Go' }));

        expect(onPageChange).not.toHaveBeenCalled();
        expect(nav().getByRole('alert')).toHaveTextContent('Enter a page number from 1 to 50.');
        expect(field).toHaveAttribute('aria-invalid', 'true');

        // Typing again clears the hint.
        await user.type(field, '4');
        expect(nav().queryByRole('alert')).toBeNull();
    });

    it('shows only the summary for a single page', () => {
        setup(1, 1, 5);

        expect(nav().getByText('Page 1 of 1 · 5 videos')).toBeInTheDocument();
        expect(nav().queryAllByRole('button')).toHaveLength(0);
        expect(nav().queryByRole('textbox')).toBeNull();
    });

    it('treats lastPage 0 like a single page', () => {
        setup(1, 0, 0);
        expect(nav().getByText('Page 1 of 1 · 0 videos')).toBeInTheDocument();
        expect(nav().queryAllByRole('button')).toHaveLength(0);
    });
});
