import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';

function rect(top: number, height: number): DOMRect {
    return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

afterEach(() => vi.restoreAllMocks());

function setup(onSelect = vi.fn()) {
    const user = userEvent.setup();

    render(
        <ActionMenu
            label="More actions for clip.mp4"
            items={[
                { key: 'a', label: 'Retry', ariaLabel: 'Retry: clip.mp4', onSelect },
                { key: 'b', label: 'Remove', danger: true, onSelect: () => undefined },
            ]}
        />,
    );

    return { user, onSelect };
}

describe('ActionMenu', () => {
    it('opens with the first item focused, moves with the arrows and closes with Escape', async () => {
        const { user } = setup();
        const trigger = screen.getByRole('button', { name: 'More actions for clip.mp4' });

        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await user.click(trigger);
        expect(screen.getByRole('menuitem', { name: 'Retry: clip.mp4' })).toHaveFocus();

        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveFocus();
        expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveClass('video-menu-danger');

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger).toHaveFocus();
    });

    it('runs the item, closes the menu and returns the focus to the trigger', async () => {
        const { user, onSelect } = setup();

        await user.click(screen.getByRole('button', { name: 'More actions for clip.mp4' }));
        await user.click(screen.getByRole('menuitem', { name: 'Retry: clip.mp4' }));

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByRole('button', { name: 'More actions for clip.mp4' })).toHaveFocus();
    });

    it('opens upward when there is no room below (last rows of a long list)', async () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ) {
            if (this.getAttribute('role') === 'menu') return rect(0, 90);

            return this instanceof HTMLButtonElement ? rect(740, 28) : rect(0, 0);
        });

        const { user } = setup();

        await user.click(screen.getByRole('button', { name: 'More actions for clip.mp4' }));
        expect(screen.getByRole('menu')).toHaveClass('is-up');
    });

    it('opens downward when there is room', async () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ) {
            if (this.getAttribute('role') === 'menu') return rect(0, 90);

            return this instanceof HTMLButtonElement ? rect(100, 28) : rect(0, 0);
        });

        const { user } = setup();

        await user.click(screen.getByRole('button', { name: 'More actions for clip.mp4' }));
        expect(screen.getByRole('menu')).not.toHaveClass('is-up');
    });
});
