import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../testing/renderApp';

const ITEMS = ['Queue', 'Library', 'Settings', 'About'];

describe('App shell navigation', () => {
    it('renders the nav items as a vertical tablist with the first one active', async () => {
        await renderApp();

        const list = screen.getByRole('tablist', { name: 'Sections' });

        expect(list).toHaveAttribute('aria-orientation', 'vertical');
        expect(
            within(list)
                .getAllByRole('tab')
                .map((tab) => tab.textContent),
        ).toEqual(ITEMS);
        expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'false',
        );
        expect(screen.getByText('Queue', { selector: '.page-title' })).toBeInTheDocument();
    });

    it('moves the selection with ArrowDown, ArrowUp, End and Home', async () => {
        const { user } = await renderApp();

        screen.getByRole('tab', { name: 'Queue' }).focus();

        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveFocus();
        expect(screen.getByText('Library', { selector: '.page-title' })).toBeInTheDocument();

        await user.keyboard('{ArrowUp}{ArrowUp}');
        expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');

        await user.keyboard('{Home}');
        expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    });

    it('shows the signed-in username and site in the sidebar footer', async () => {
        await renderApp({
            auth: { status: 'signed_in', username: 'alice', siteUrl: 'https://site.example.com' },
        });

        const account = screen.getByRole('group', { name: 'Account' });

        expect(within(account).getByText('alice')).toBeInTheDocument();
        expect(within(account).getByText('site.example.com')).toBeInTheDocument();
    });

    it('shows the Offline chip in the top bar', async () => {
        await renderApp({
            auth: { status: 'offline', username: 'alice', siteUrl: 'https://site.example.com' },
        });

        expect(within(screen.getByRole('banner')).getByText('Offline')).toBeInTheDocument();
    });
});
