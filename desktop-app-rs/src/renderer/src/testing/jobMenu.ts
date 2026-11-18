import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

const KEBAB = /^More actions for /;

/** Opens the kebab menu of a queue row (the first row when `row` is omitted). */
export async function openJobMenu(user: UserEvent, row?: HTMLElement): Promise<HTMLElement> {
    const scope = row === undefined ? screen : within(row);

    await user.click(scope.getByRole('button', { name: KEBAB }));

    return screen.getByRole('menu');
}

/**
 * Clicks an action of any queue row: first a visible button, else the matching item of a kebab
 * menu (rows are tried in order; menus that do not hold it are closed again).
 */
export async function clickJobAction(user: UserEvent, name: string | RegExp): Promise<void> {
    const visible = screen
        .queryAllByRole('button', { name })
        .filter((button) => !KEBAB.test(button.getAttribute('aria-label') ?? ''));

    if (visible[0] !== undefined) {
        await user.click(visible[0]);

        return;
    }

    for (const kebab of screen.queryAllByRole('button', { name: KEBAB })) {
        await user.click(kebab);

        const match = screen.queryByRole('menuitem', { name });

        if (match !== null) {
            await user.click(match);

            return;
        }

        await user.keyboard('{Escape}');
    }

    throw new Error(`No queue action matches ${String(name)}`);
}

/** Names (before the colon) of every action of a row: visible buttons plus the menu items. */
export async function actionsOfRow(user: UserEvent, row: HTMLElement): Promise<string[]> {
    const label = (node: HTMLElement) =>
        (node.getAttribute('aria-label') ?? '').split(':')[0] ?? '';
    const names = within(row)
        .queryAllByRole('button')
        .filter((button) => !KEBAB.test(button.getAttribute('aria-label') ?? ''))
        .map(label);
    const kebab = within(row).queryByRole('button', { name: KEBAB });

    if (kebab !== null) {
        await user.click(kebab);
        names.push(...within(screen.getByRole('menu')).getAllByRole('menuitem').map(label));
        await user.keyboard('{Escape}');
    }

    return names.sort();
}
