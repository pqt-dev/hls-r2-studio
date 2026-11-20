import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { push, renderApp } from '../testing/renderApp';

const signedOut = { status: 'signed_out' } as const;

describe('Login screen', () => {
    it('shows the login form when signed out, with only the two fields', async () => {
        await renderApp({ auth: signedOut });

        expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
        // The logo is decorative: present in the DOM but hidden from the accessibility tree.
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
        expect(document.querySelector('.login-brand img.brand-mark')).toHaveAttribute('aria-hidden', 'true');
        // No site URL input: the site is fixed when the app is built.
        expect(screen.queryByLabelText('Site URL')).not.toBeInTheDocument();
        expect(screen.getAllByRole('textbox')).toHaveLength(1);
        expect(screen.queryByText('Signing in to', { exact: false })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Stay signed in')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
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

    it('always signs in with staySignedIn=true', async () => {
        const { fake, user } = await renderApp({ auth: signedOut });
        const login = vi.spyOn(fake.api.auth, 'login');

        await user.type(screen.getByLabelText('Username'), 'alice');
        await user.type(screen.getByLabelText('Password'), 'secret');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(login).toHaveBeenCalledWith('alice', 'secret', true);
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

        // The account now lives in the sidebar footer (it used to be in the top bar).
        const account = screen.getByRole('group', { name: 'Account' });

        expect(within(account).getByText('bob')).toBeInTheDocument();
    });

    it('keeps the main screen when offline', async () => {
        await renderApp({
            auth: { status: 'offline', username: 'alice', siteUrl: 'https://site.example.com' },
        });

        expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('unsubscribes from all events on unmount', async () => {
        const { fake, unmount } = await renderApp();

        // Auth, jobs and summary (app state) plus the jobs listener of the Home screen.
        expect(fake.listenerCount()).toBe(4);
        unmount();
        expect(fake.listenerCount()).toBe(0);
    });
});
