import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { push, renderApp } from '../testing/renderApp';

const signedOut = { status: 'signed_out' } as const;

describe('Login screen', () => {
    it('shows the login form when signed out, with the fixed site shown read-only', async () => {
        await renderApp({ auth: signedOut });

        expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
        // No site URL input: the site is fixed when the app is built.
        expect(screen.queryByLabelText('Site URL')).not.toBeInTheDocument();
        expect(screen.getAllByRole('textbox')).toHaveLength(1);
        expect(screen.getByText('Signing in to', { exact: false })).toHaveTextContent(
            'Signing in to site.example.com',
        );
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText('Stay signed in')).toBeChecked();
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('signs in and moves to the main screen', async () => {
        const { fake, user } = await renderApp({ auth: signedOut });
        const login = vi.spyOn(fake.api.auth, 'login');

        await user.type(screen.getByLabelText('Username'), 'alice');
        await user.type(screen.getByLabelText('Password'), 'secret');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(login).toHaveBeenCalledWith('alice', 'secret', true);
        expect(await screen.findByRole('tablist')).toBeInTheDocument();
    });

    it('passes staySignedIn=false when the box is unchecked', async () => {
        const { fake, user } = await renderApp({ auth: signedOut });
        const login = vi.spyOn(fake.api.auth, 'login');

        await user.type(screen.getByLabelText('Username'), 'alice');
        await user.type(screen.getByLabelText('Password'), 'secret');
        await user.click(screen.getByLabelText('Stay signed in'));
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(login).toHaveBeenCalledWith('alice', 'secret', false);
    });

    it('submits with Enter and shows the returned error inline', async () => {
        const { fake, user } = await renderApp({ auth: signedOut });
        const login = vi
            .spyOn(fake.api.auth, 'login')
            .mockResolvedValue({ status: 'signed_out', error: 'Incorrect username or password.' });

        await user.type(screen.getByLabelText('Username'), 'alice');
        await user.type(screen.getByLabelText('Password'), 'nope{Enter}');

        expect(login).toHaveBeenCalledTimes(1);
        expect(await screen.findByText('Incorrect username or password.')).toBeInTheDocument();
        // The password is not kept after a failed attempt.
        expect(screen.getByLabelText('Password')).toHaveValue('');
        expect(screen.getByLabelText('Username')).toHaveValue('alice');
    });

    it('shows a loading state and disables the form while signing in', async () => {
        const { fake, user } = await renderApp({ auth: signedOut });
        let finish: (state: { status: 'signed_out'; error: string }) => void = () => undefined;

        vi.spyOn(fake.api.auth, 'login').mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );

        await user.type(screen.getByLabelText('Username'), 'alice');
        await user.type(screen.getByLabelText('Password'), 'secret{Enter}');

        expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
        expect(screen.getByLabelText('Username')).toBeDisabled();

        await act(async () => finish({ status: 'signed_out', error: 'Cannot reach the site.' }));
        expect(await screen.findByText('Cannot reach the site.')).toBeInTheDocument();
    });

    it('shows the form disabled while a stored session is being restored', async () => {
        await renderApp({ auth: { status: 'signing_in' } });

        expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('is gated by the auth state: events switch between login and main screens', async () => {
        const { fake } = await renderApp();

        expect(screen.getByRole('tablist')).toBeInTheDocument();

        push(() => fake.emitAuth(signedOut));
        expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

        push(() =>
            fake.emitAuth({
                status: 'signed_in',
                username: 'bob',
                siteUrl: 'https://b.example.com',
            }),
        );

        const header = screen.getByRole('banner');

        expect(within(header).getByText('bob')).toBeInTheDocument();
        expect(within(header).getByText('b.example.com')).toBeInTheDocument();
    });

    it('keeps the main screen when offline', async () => {
        await renderApp({
            auth: { status: 'offline', username: 'alice', siteUrl: 'https://site.example.com' },
        });

        expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('unsubscribes from all events on unmount', async () => {
        const { fake, unmount } = await renderApp();

        expect(fake.listenerCount()).toBe(3);
        unmount();
        expect(fake.listenerCount()).toBe(0);
    });
});
