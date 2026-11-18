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

const field = () => nav().getByRole('textbox', { name: 'Current page' });

describe('Pagination', () => {
    it('shows the count, the current page input and "of LAST"', () => {
        setup(6, 1000, 24000);

        expect(nav().getByRole('status')).toHaveTextContent('24000 videos');
        expect(field()).toHaveValue('6');
        expect(nav().getByText('of 1000')).toBeInTheDocument();
        // No numbered buttons, no text labels, no Go to page form.
        expect(nav().queryByRole('button', { name: /^Page \d+$/ })).toBeNull();
        expect(nav().queryByRole('button', { name: 'Go' })).toBeNull();
        expect(nav().queryByText(/Go to page/)).toBeNull();
    });

    it('labels the controls', () => {
        setup(3, 9);

        for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
            expect(nav().getByRole('button', { name })).toBeInTheDocument();
        }

        expect(field()).toHaveAttribute('inputmode', 'numeric');
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

    it('goes to First, Previous, Next and Last', async () => {
        const { onPageChange, user } = setup(6, 20);

        await user.click(nav().getByRole('button', { name: 'First page' }));
        await user.click(nav().getByRole('button', { name: 'Previous page' }));
        await user.click(nav().getByRole('button', { name: 'Next page' }));
        await user.click(nav().getByRole('button', { name: 'Last page' }));

        expect(onPageChange.mock.calls.map((call) => call[0])).toEqual([1, 5, 7, 20]);
    });

    it('jumps to a typed page with Enter', async () => {
        const { onPageChange, user } = setup(1, 50);

        await user.clear(field());
        await user.type(field(), '12{Enter}');

        expect(onPageChange).toHaveBeenCalledExactlyOnceWith(12);
        expect(nav().queryByRole('alert')).toBeNull();
    });

    it('does nothing when Enter is pressed on the unchanged current page', async () => {
        const { onPageChange, user } = setup(6, 20);

        await user.click(field());
        await user.keyboard('{Enter}');

        expect(onPageChange).not.toHaveBeenCalled();
        expect(nav().queryByRole('alert')).toBeNull();
    });

    it('follows the page prop and reverts an abandoned edit on blur', async () => {
        const onPageChange = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(
            <Pagination page={2} lastPage={9} total={216} onPageChange={onPageChange} />,
        );

        expect(field()).toHaveValue('2');

        await user.clear(field());
        await user.type(field(), '7');
        await user.tab();
        expect(field()).toHaveValue('2');
        expect(onPageChange).not.toHaveBeenCalled();

        await user.clear(field());
        await user.tab();
        expect(field()).toHaveValue('2');

        rerender(<Pagination page={3} lastPage={9} total={216} onPageChange={onPageChange} />);
        expect(field()).toHaveValue('3');
    });

    it.each([
        ['999', 50],
        ['0', 1],
    ])('clamps %s into 1..last', async (text, expected) => {
        const { onPageChange, user } = setup(10, 50);

        await user.clear(field());
        await user.type(field(), `${text}{Enter}`);
        expect(onPageChange).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it.each(['', 'abc', '-2', '1.5'])('ignores %j with an inline hint', async (text) => {
        const { onPageChange, user } = setup(3, 50);

        await user.clear(field());

        if (text !== '') await user.type(field(), text);

        await user.keyboard('{Enter}');

        expect(onPageChange).not.toHaveBeenCalled();
        expect(nav().getByRole('alert')).toHaveTextContent('Enter a page number from 1 to 50.');
        expect(field()).toHaveAttribute('aria-invalid', 'true');

        // Typing again clears the hint.
        await user.type(field(), '4');
        expect(nav().queryByRole('alert')).toBeNull();
    });

    it('shows only the count for a single page', () => {
        setup(1, 1, 5);

        expect(nav().getByRole('status')).toHaveTextContent('5 videos');
        expect(nav().queryAllByRole('button')).toHaveLength(0);
        expect(nav().queryByRole('textbox')).toBeNull();
    });

    it('treats lastPage 0 like a single page', () => {
        setup(1, 0, 0);
        expect(nav().getByRole('status')).toHaveTextContent('0 videos');
        expect(nav().queryAllByRole('button')).toHaveLength(0);
    });

    it('does not render a Per page select', () => {
        setup(1, 3, 60);
        expect(nav().queryByText('Per page')).toBeNull();
        expect(nav().queryByRole('combobox')).toBeNull();
    });
});
