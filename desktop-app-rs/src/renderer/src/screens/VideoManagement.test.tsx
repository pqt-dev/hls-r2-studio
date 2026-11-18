import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
    VideoDetail,
    VideoListItem,
    VideosBulkDeleteResult,
    VideosDeleteResult,
    VideosGetResult,
    VideosListResult,
    VideosUpdateTitleResult,
} from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

const CONFIRM_TEXT =
    /Delete this video\? This removes it from the site and may remove its files from storage\. This cannot be undone\./;

function listOf(items: VideoListItem[], page = 1, lastPage = 1): VideosListResult {
    return { ok: true, data: items, meta: { page, perPage: 24, total: items.length, lastPage } };
}

interface Options {
    list?: (params?: unknown) => Promise<VideosListResult>;
    detail?: Partial<VideoDetail>;
    updateTitle?: (id: number, title: string) => Promise<VideosUpdateTitleResult>;
    remove?: (id: number) => Promise<VideosDeleteResult>;
    bulkDelete?: (ids: number[]) => Promise<VideosBulkDeleteResult>;
}

async function openLibrary(options: Options = {}) {
    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const list = vi
        .spyOn(videos, 'list')
        .mockImplementation(
            options.list ??
                (() => Promise.resolve(listOf([makeVideo({ id: 7, title: 'Holiday' })]))),
        );

    vi.spyOn(videos, 'get').mockImplementation((id) =>
        Promise.resolve<VideosGetResult>({
            ok: true,
            video: makeVideoDetail({ id, title: 'Holiday', ...options.detail }),
        }),
    );

    const updateTitle = vi
        .spyOn(videos, 'updateTitle')
        .mockImplementation(
            options.updateTitle ??
                ((id, title) =>
                    Promise.resolve({ ok: true, video: makeVideoDetail({ id, title }) })),
        );
    const remove = vi
        .spyOn(videos, 'delete')
        .mockImplementation(
            options.remove ??
                (() => Promise.resolve({ ok: true, status: 'deleted', message: 'Gone.' })),
        );
    const bulkDelete = vi.spyOn(videos, 'bulkDelete').mockImplementation(
        options.bulkDelete ??
            ((ids) =>
                Promise.resolve({
                    ok: true,
                    deleted: ids.length,
                    failed: 0,
                    skipped: 0,
                    message: `Deleted ${ids.length} videos.`,
                })),
    );

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));

    return { ...rendered, list, updateTitle, remove, bulkDelete };
}

type Opened = Awaited<ReturnType<typeof openLibrary>>;

async function openDetail(user: Opened['user']) {
    await user.click(await screen.findByRole('button', { name: /^Holiday/ }));
    await screen.findByText('Information');
}

describe('Rename (video detail)', () => {
    it('saves with Enter, updates the page and the list row, and returns focus to Rename', async () => {
        const { user, updateTitle, list } = await openLibrary();

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));

        const field = screen.getByRole('textbox', { name: 'Title' });

        expect(field).toHaveFocus();
        expect(field).toHaveValue('Holiday');

        await user.clear(field);
        await user.type(field, '  New name  {Enter}');

        expect(updateTitle).toHaveBeenCalledTimes(1);
        expect(updateTitle).toHaveBeenCalledWith(7, 'New name');
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull());
        expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
        expect(
            within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('New name'),
        ).toBeInTheDocument();
        expect(await screen.findByText('Title updated.')).toBeInTheDocument();

        const lists = list.mock.calls.length;

        await user.click(screen.getByRole('button', { name: '← Library' }));
        // The row shows the new title without reloading the list.
        expect(screen.getByRole('button', { name: /^New name/ })).toBeInTheDocument();
        expect(list.mock.calls.length).toBe(lists);
    });

    it('Save and Cancel buttons work; Esc cancels the edit but keeps the page open', async () => {
        const { user, updateTitle } = await openLibrary();

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), ' more');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();

        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), ' more{Escape}');

        expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
        // Still on the detail page.
        expect(screen.getByText('Information')).toBeInTheDocument();
        expect(updateTitle).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), ' two');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(updateTitle).toHaveBeenCalledWith(7, 'Holiday two');
    });

    it('does nothing when the trimmed title is unchanged', async () => {
        const { user, updateTitle } = await openLibrary();

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), '   {Enter}');

        expect(updateTitle).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    });

    it('shows validation problems inline without calling the API', async () => {
        const { user, updateTitle } = await openLibrary();

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));

        const field = screen.getByRole('textbox', { name: 'Title' });

        await user.clear(field);
        await user.type(field, '   {Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Title is required.');

        await user.clear(field);
        await user.click(field);
        await user.paste('a'.repeat(256));
        await user.keyboard('{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Title is too long');
        expect(updateTitle).not.toHaveBeenCalled();
        // Typing again clears the message.
        await user.type(field, 'b');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('is disabled while saving and shows a server error inline', async () => {
        let finish: (result: VideosUpdateTitleResult) => void = () => undefined;
        const { user } = await openLibrary({
            updateTitle: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), ' x{Enter}');

        expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

        await act(async () => {
            finish({ ok: false, error: 'Title is invalid.' });
        });

        expect(screen.getByRole('alert')).toHaveTextContent('Title is invalid.');
        expect(screen.getByRole('textbox', { name: 'Title' })).toBeEnabled();
        expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Holiday x');
    });

    it('shows a generic error when the call throws', async () => {
        const { user } = await openLibrary({ updateTitle: () => Promise.reject(new Error('x')) });

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByRole('textbox', { name: 'Title' }), ' x{Enter}');

        expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    });
});

describe('Delete (video detail)', () => {
    it('asks first (Cancel is focused) and does not call the API when canceled', async () => {
        const { user, remove } = await openLibrary();

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        const dialog = screen.getByRole('alertdialog');

        expect(within(dialog).getByText(CONFIRM_TEXT)).toBeInTheDocument();
        expect(within(dialog).getByText('Holiday')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        expect(remove).not.toHaveBeenCalled();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    });

    it('deleted: toasts the server message, returns to the list and reloads it', async () => {
        const { user, remove, list } = await openLibrary({
            remove: () =>
                Promise.resolve({
                    ok: true,
                    status: 'deleted',
                    message: 'Video has been deleted.',
                }),
        });

        await openDetail(user);

        const lists = list.mock.calls.length;

        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(remove).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Video has been deleted.')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByText('Information')).toBeNull());
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(lists));
        expect(screen.getByRole('heading', { name: 'Library' })).toHaveFocus();
    });

    it('skipped: tells the user to try later and stays on the page', async () => {
        const { user } = await openLibrary({
            remove: () => Promise.resolve({ ok: true, status: 'skipped', message: 'skipped' }),
        });

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(
            await screen.findByText('The video is still processing; try again later.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Information')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus());
    });

    it('failed: shows the server message as an error toast and stays on the page', async () => {
        const { user } = await openLibrary({
            remove: () =>
                Promise.resolve({ ok: true, status: 'failed', message: 'Storage cleanup failed.' }),
        });

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/Storage cleanup failed\./)).toBeInTheDocument();
        expect(screen.getByText('Information')).toBeInTheDocument();
    });

    it('a request error shows an error toast and stays on the page', async () => {
        const { user } = await openLibrary({
            remove: () => Promise.resolve({ ok: false, error: 'Video not found.' }),
        });

        await openDetail(user);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/Video not found\./)).toBeInTheDocument();
        expect(screen.getByText('Information')).toBeInTheDocument();
    });

    it.each(['pending', 'processing'])(
        'is disabled with an explanation while the video is %s',
        async (status) => {
            const { user, remove } = await openLibrary({ detail: { status } });

            await openDetail(user);

            const button = screen.getByRole('button', { name: 'Delete' });

            expect(button).toBeDisabled();
            expect(button).toHaveAttribute('title', expect.stringMatching(/cannot be deleted/));
            expect(button).toHaveAccessibleDescription(/cannot be deleted/);
            await user.click(button);
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(remove).not.toHaveBeenCalled();
        },
    );
});

function many(count: number, start = 1): VideoListItem[] {
    return Array.from({ length: count }, (_, index) =>
        makeVideo({ id: start + index, title: `Clip ${start + index}` }),
    );
}

describe('Select mode (library)', () => {
    it('toggles select mode, ticks rows without opening details, select all and clear', async () => {
        const { user } = await openLibrary({ list: () => Promise.resolve(listOf(many(3))) });

        await screen.findByText('Clip 1');
        expect(screen.queryByRole('checkbox')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Select' }));
        expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();

        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 2' }));
        expect(screen.getByRole('checkbox', { name: 'Select Clip 2' })).toBeChecked();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        // Clicking the card (not only the box) toggles; no detail page opens.
        await user.click(screen.getByText('Clip 3'));
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        expect(screen.queryByText('Information')).toBeNull();
        await user.click(screen.getByText('Clip 3'));
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Select all on this page' }));
        expect(screen.getByText('3 selected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete selected' })).toBeEnabled();

        await user.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        expect(
            screen.getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked),
        ).toBe(true);

        await user.click(screen.getByRole('button', { name: 'Select' }));
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('Esc leaves select mode and returns the focus to the Select button', async () => {
        const { user } = await openLibrary({ list: () => Promise.resolve(listOf(many(2))) });

        await screen.findByText('Clip 1');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 1' }));
        await user.keyboard('{Escape}');

        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(screen.queryByText(/selected$/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
    });

    it('confirms with the count, deletes, shows the server message, exits and reloads', async () => {
        const { user, bulkDelete, list } = await openLibrary({
            list: () => Promise.resolve(listOf(many(4))),
            bulkDelete: () =>
                Promise.resolve({
                    ok: true,
                    deleted: 2,
                    failed: 0,
                    skipped: 1,
                    message: 'Deleted 2 videos (1 skipped: still processing).',
                }),
        });

        await screen.findByText('Clip 1');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 1' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 2' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 3' }));
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));

        const dialog = screen.getByRole('alertdialog');

        expect(
            within(dialog).getByText(
                'Delete 3 videos? This removes them from the site and may remove their files from storage. This cannot be undone.',
            ),
        ).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

        // Cancel: nothing is sent and the selection stays.
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(bulkDelete).not.toHaveBeenCalled();
        expect(screen.getByText('3 selected')).toBeInTheDocument();

        const lists = list.mock.calls.length;

        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(bulkDelete).toHaveBeenCalledWith([1, 2, 3]);
        expect(
            await screen.findByText('Deleted 2 videos (1 skipped: still processing).'),
        ).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
        await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(lists));
        expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus();
    });

    it('keeps the selection and shows an error toast when the request fails', async () => {
        const { user, list } = await openLibrary({
            list: () => Promise.resolve(listOf(many(2))),
            bulkDelete: () => Promise.resolve({ ok: false, error: 'Too many requests.' }),
        });

        await screen.findByText('Clip 1');

        const lists = list.mock.calls.length;

        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 1' }));
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/Too many requests\./)).toBeInTheDocument();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(list.mock.calls.length).toBe(lists);
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Delete selected' })).toHaveFocus(),
        );
    });

    it('goes to the previous page when the current page becomes empty', async () => {
        const { user, list, bulkDelete } = await openLibrary({
            list: (params) => {
                const { page } = params as { page: number };

                return Promise.resolve(
                    page === 1 ? listOf(many(2), 1, 2) : listOf(many(1, 30), 2, 2),
                );
            },
        });

        await screen.findByText('Clip 1');
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('Clip 30');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 30' }));
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(bulkDelete).toHaveBeenCalledWith([30]);
        await screen.findByText('Page 1 of 2 · 2 videos');
        expect(list).toHaveBeenLastCalledWith({ page: 1, perPage: 24 });
    });

    it('resets the selection when the page or the search changes', async () => {
        const { user } = await openLibrary({
            list: (params) => {
                const { page } = params as { page: number };

                return Promise.resolve(listOf(many(2, page === 1 ? 1 : 10), page, 2));
            },
        });

        await screen.findByText('Clip 1');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 1' }));
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('Clip 10');
        expect(screen.getByText('0 selected')).toBeInTheDocument();

        await user.click(screen.getByRole('checkbox', { name: 'Select Clip 10' }));
        expect(screen.getByText('1 selected')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Search videos'), 'abc');
        await waitFor(() => expect(screen.getByText('0 selected')).toBeInTheDocument());
        // Select mode itself stays on.
        expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });
});
