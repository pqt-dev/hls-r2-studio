import { act, render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { createFakeApi, type FakeApi, type FakeState } from './fakeApi';

export interface Rendered {
    fake: FakeApi;
    user: ReturnType<typeof userEvent.setup>;
    unmount: () => void;
}

/** Renders the whole app against a fake API and waits for the first load. */
export async function renderApp(
    initial: Partial<FakeState> = {},
    /** Runs before the first render: stub the fake API calls the first screen makes. */
    prepare?: (fake: FakeApi) => void,
): Promise<Rendered> {
    const fake = createFakeApi(initial);

    prepare?.(fake);

    const user = userEvent.setup();
    const { unmount } = render(<App api={fake.api} />);

    // The splash screen is a <main aria-busy>; wait until it is gone (the real screen has none).
    await screen.findByRole('main');
    await waitFor(() => expect(document.querySelector('main[aria-busy="true"]')).toBeNull());

    return { fake, user, unmount };
}

/** Pushes a main -> renderer event inside `act`. */
export function push(run: () => void): void {
    act(run);
}

/** Like `renderApp`, then opens the Queue tab (the app now starts on Home after sign-in). */
export async function renderQueue(initial: Partial<FakeState> = {}): Promise<Rendered> {
    const rendered = await renderApp(initial);

    await rendered.user.click(screen.getByRole('tab', { name: /^Queue/ }));

    return rendered;
}
