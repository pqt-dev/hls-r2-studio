import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { createFakeApi, type FakeApi, type FakeState } from './fakeApi';

export interface Rendered {
    fake: FakeApi;
    user: ReturnType<typeof userEvent.setup>;
    unmount: () => void;
}

/** Renders the whole app against a fake API and waits for the first load. */
export async function renderApp(initial: Partial<FakeState> = {}): Promise<Rendered> {
    const fake = createFakeApi(initial);
    const user = userEvent.setup();
    const { unmount } = render(<App api={fake.api} />);

    await screen.findByRole('main');

    return { fake, user, unmount };
}

/** Pushes a main -> renderer event inside `act`. */
export function push(run: () => void): void {
    act(run);
}
