import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Enters the Library select mode the way a user does: item menu, then "Select" (that item is picked). */
export async function enterSelectMode(user: UserEvent, title: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Select' }));
}
