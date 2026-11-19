import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoListItem } from '../../../shared/ipc';
import { makeVideo } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';
import { enterSelectMode } from '../testing/selectMode';

const VIDEOS = [
    makeVideo({ id: 1, title: 'Alpha' }),
    makeVideo({ id: 2, title: 'Beta' }),
    makeVideo({ id: 3, title: 'Gamma' }),
];

async function openLibrary(data: VideoListItem[] = VIDEOS) {
    const rendered = await renderApp();

    vi.spyOn(rendered.fake.api.videos, 'list').mockImplementation(() =>
        Promise.resolve({
            ok: true,
            data,
            meta: { page: 1, perPage: 24, total: data.length, lastPage: 1 },
        }),
    );
    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await screen.findByRole('list', { name: 'Videos' });

    return rendered;
}

const search = () => screen.getByRole('textbox', { name: 'Search videos' });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Library keyboard shortcuts', () => {
    it('advertises "/" on the search field', async () => {
        await openLibrary();

        expect(search()).toHaveAttribute('title', 'Press / to search');
        expect(search()).toHaveAttribute('aria-keyshortcuts', '/');
    });

    it('focuses the search field on "/"', async () => {
        const { user } = await openLibrary();

        expect(search()).not.toHaveFocus();
        await user.keyboard('/');
        expect(search()).toHaveFocus();
        // The slash is not typed into the field.
        expect(search()).toHaveValue('');
    });

    it('does not hijack "/" while typing in a field', async () => {
        const { user } = await openLibrary();

        await user.click(search());
        await user.keyboard('a/b');
        expect(search()).toHaveValue('a/b');

        await user.selectOptions(screen.getByLabelText('Sort by'), 'Title A-Z');
        screen.getByLabelText('Sort by').focus();
        await user.keyboard('/');
        expect(search()).not.toHaveFocus();
    });

    it('ignores "/" with a modifier and while a dialog is open', async () => {
        const { user } = await openLibrary();

        await user.keyboard('{Control>}/{/Control}');
        expect(search()).not.toHaveFocus();

        await user.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
        await user.keyboard('/');
        expect(search()).not.toHaveFocus();
    });

    it('selects every video on the page with Ctrl+A or Cmd+A in select mode', async () => {
        const { user } = await openLibrary();

        await enterSelectMode(user, 'Alpha');
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        // Default is prevented in select mode (no text selection of the page).
        expect(fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true })).toBe(false);
        await waitFor(() => expect(screen.getByText('3 selected')).toBeInTheDocument());

        await user.click(screen.getByRole('button', { name: 'Unselect all on this page' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();

        expect(fireEvent.keyDown(document.body, { key: 'a', metaKey: true })).toBe(false);
        await waitFor(() => expect(screen.getByText('3 selected')).toBeInTheDocument());
    });

    it('leaves Ctrl+A alone outside select mode and inside inputs', async () => {
        const { user } = await openLibrary();

        expect(fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true })).toBe(true);

        await enterSelectMode(user, 'Alpha');
        await user.click(search());
        expect(fireEvent.keyDown(search(), { key: 'a', ctrlKey: true })).toBe(true);
        expect(screen.getByText('1 selected')).toBeInTheDocument();
    });
});
