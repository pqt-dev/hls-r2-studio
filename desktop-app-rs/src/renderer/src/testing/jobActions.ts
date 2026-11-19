import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** The visible icon-only action buttons of a queue row are named "<Action> for <file name>". */
function actionOf(button: HTMLElement): string {
    return (button.getAttribute('aria-label') ?? '').split(' for ')[0] ?? '';
}

/** Clicks a visible action button of any queue row (the first match, in document order). */
export async function clickJobAction(user: UserEvent, name: string | RegExp): Promise<void> {
    const [button] = screen.queryAllByRole('button', { name });

    if (button === undefined) throw new Error(`No queue action matches ${String(name)}`);

    await user.click(button);
}

/** Action names of a row's visible buttons, in visual (DOM) order. */
export function actionsOfRow(row: HTMLElement): string[] {
    return within(row).queryAllByRole('button').map(actionOf);
}
