import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeJob } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

const ITEMS = ['Home', 'Queue', 'Library', 'Settings', 'About'];

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
        // Home is the default tab after sign-in (it used to be Queue).
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute(
            'aria-selected',
            'false',
        );
        expect(screen.getByText('Home', { selector: '.page-title' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'About' })).toHaveClass('tab-secondary');
    });

    it('moves the selection with ArrowDown, ArrowUp, End and Home across the five tabs', async () => {
        const { user } = await renderApp();
        const selected = () =>
            screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');

        screen.getByRole('tab', { name: 'Home' }).focus();

        // Walk forward through every tab in order, then wrap around to the first.
        for (const name of ITEMS.slice(1)) {
            await user.keyboard('{ArrowDown}');
            expect(selected()).toHaveTextContent(name);
            expect(selected()).toHaveFocus();
        }

        expect(screen.getByText('About', { selector: '.page-title' })).toBeInTheDocument();
        await user.keyboard('{ArrowRight}');
        expect(selected()).toHaveTextContent('Home');
        await user.keyboard('{ArrowLeft}');
        expect(selected()).toHaveTextContent('About');
        await user.keyboard('{ArrowUp}{ArrowUp}');
        expect(selected()).toHaveTextContent('Library');
        await user.keyboard('{Home}');
        expect(selected()).toHaveTextContent('Home');
        await user.keyboard('{End}');
        expect(selected()).toHaveTextContent('About');
    });

    it('keeps a roving tabindex: only the selected tab is in the tab order', async () => {
        const { user } = await renderApp();

        expect(screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.tabIndex])).toEqual(
            ITEMS.map((name) => [name, name === 'Home' ? 0 : -1]),
        );

        await user.click(screen.getByRole('tab', { name: 'Library' }));
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('tabindex', '0');
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('tabindex', '-1');
        expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-library');
    });

    it('keeps the Queue count badge on the Queue tab', async () => {
        await renderApp({ jobs: [makeJob({ id: 'a', state: 'transcoding' })] });

        expect(screen.getByRole('tab', { name: /Queue/ })).toHaveTextContent('1');
        expect(screen.getByRole('tab', { name: /Home/ })).not.toHaveTextContent('1');
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
