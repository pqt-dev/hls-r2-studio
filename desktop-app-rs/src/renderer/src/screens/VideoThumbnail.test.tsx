import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
    ActionResult,
    VideoDetail,
    VideosGetResult,
    VideosListResult,
    VideosSetImageResult,
} from '../../../shared/ipc';
import { makeVideo, makeVideoDetail } from '../testing/fakeApi';
import { renderApp } from '../testing/renderApp';

const CUSTOM_URL = 'https://cdn.example.com/videos/abcdefghijkl/custom.png?v=2';
const GENERATED_URL = 'https://cdn.example.com/videos/abcdefghijkl/thumb.jpg';
const CONFIRM_TEXT = 'Remove the custom thumbnail? The generated thumbnail will be used again.';

const withCustom: Partial<VideoDetail> = {
    hasCustomImage: true,
    customImageUrl: CUSTOM_URL,
};

function listOf(): VideosListResult {
    return {
        ok: true,
        data: [makeVideo({ id: 7, title: 'Holiday', thumbnailUrl: GENERATED_URL })],
        meta: { page: 1, perPage: 24, total: 1, lastPage: 1 },
    };
}

interface Options {
    /** Detail returned by successive `videos.get` calls; the last one repeats. */
    details?: Partial<VideoDetail>[];
    setImage?: (id: number) => Promise<VideosSetImageResult>;
    removeImage?: (id: number) => Promise<ActionResult>;
}

async function openDetail(options: Options = {}) {
    const rendered = await renderApp();
    const { videos } = rendered.fake.api;
    const details = options.details ?? [{}];
    let calls = 0;

    const list = vi.spyOn(videos, 'list').mockImplementation(() => Promise.resolve(listOf()));
    const get = vi.spyOn(videos, 'get').mockImplementation((id) => {
        const detail = details[Math.min(calls, details.length - 1)];

        calls += 1;

        return Promise.resolve<VideosGetResult>({
            ok: true,
            video: makeVideoDetail({
                id,
                title: 'Holiday',
                thumbnailUrl: GENERATED_URL,
                ...detail,
            }),
        });
    });
    const setImage = vi
        .spyOn(videos, 'setImage')
        .mockImplementation(
            options.setImage ?? (() => Promise.resolve({ ok: true, canceled: false })),
        );
    const removeImage = vi
        .spyOn(videos, 'removeImage')
        .mockImplementation(options.removeImage ?? (() => Promise.resolve({ ok: true })));

    await rendered.user.click(screen.getByRole('tab', { name: 'Library' }));
    await rendered.user.click(await screen.findByRole('button', { name: /^Holiday/ }));
    await screen.findByText('Information');

    return { ...rendered, list, get, setImage, removeImage };
}

function card() {
    return within(screen.getByRole('region', { name: 'Thumbnail' }));
}

describe('Custom thumbnail (video detail)', () => {
    it('without a custom image: no chip, no Remove button, the generated thumbnail is shown', async () => {
        await openDetail();

        expect(card().getByRole('button', { name: 'Choose image…' })).toBeEnabled();
        expect(card().queryByText('Custom')).toBeNull();
        expect(card().queryByRole('button', { name: 'Remove custom image' })).toBeNull();
        expect(
            screen.getByRole('region', { name: 'Thumbnail' }).querySelector('img'),
        ).toHaveAttribute('src', GENERATED_URL);
    });

    it('with a custom image: chip and Remove button, the custom image wins', async () => {
        await openDetail({ details: [withCustom] });

        expect(card().getByText('Custom')).toBeInTheDocument();
        expect(card().getByRole('button', { name: 'Remove custom image' })).toBeEnabled();
        expect(
            screen.getByRole('region', { name: 'Thumbnail' }).querySelector('img'),
        ).toHaveAttribute('src', CUSTOM_URL);
    });

    it('choose: calls setImage with the id only, toasts, refetches and updates the list row', async () => {
        const { user, setImage, get, list } = await openDetail({ details: [{}, withCustom] });
        const loads = get.mock.calls.length;
        const lists = list.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Choose image…' }));

        expect(setImage).toHaveBeenCalledTimes(1);
        expect(setImage).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Thumbnail updated.')).toBeInTheDocument();
        await waitFor(() => expect(card().getByText('Custom')).toBeInTheDocument());
        expect(get.mock.calls.length).toBe(loads + 1);
        expect(card().getByRole('button', { name: 'Choose image…' })).toHaveFocus();

        await user.click(screen.getByRole('button', { name: 'Library' }));

        // The row got the fresh (cache-busted) URL without reloading the list.
        expect(list.mock.calls.length).toBe(lists);
        expect(
            screen.getByRole('button', { name: /^Holiday/ }).closest('li, article, div')?.innerHTML,
        ).toContain(CUSTOM_URL);
    });

    it('canceling the picker is a no-op: no toast, no refetch', async () => {
        const { user, get } = await openDetail({
            setImage: () => Promise.resolve({ ok: true, canceled: true }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Choose image…' }));
        await waitFor(() =>
            expect(card().getByRole('button', { name: 'Choose image…' })).toBeEnabled(),
        );

        expect(screen.queryByText('Thumbnail updated.')).toBeNull();
        expect(screen.getByRole('status')).toBeEmptyDOMElement();
        expect(get.mock.calls.length).toBe(loads);
    });

    it('an error shows the safe message, does not refetch and re-enables the button', async () => {
        const { user, get } = await openDetail({
            setImage: () =>
                Promise.resolve({ ok: false, error: 'Choose a JPG, PNG or WebP image.' }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Choose image…' }));

        expect(await screen.findByText(/Choose a JPG, PNG or WebP image\./)).toBeInTheDocument();
        expect(get.mock.calls.length).toBe(loads);
        expect(card().getByRole('button', { name: 'Choose image…' })).toBeEnabled();
        expect(card().getByRole('button', { name: 'Choose image…' })).toHaveFocus();
    });

    it('a rejected call shows the generic error', async () => {
        const { user } = await openDetail({ setImage: () => Promise.reject(new Error('boom')) });

        await user.click(card().getByRole('button', { name: 'Choose image…' }));

        expect(
            await screen.findByText(/Something went wrong\. Please try again\./),
        ).toBeInTheDocument();
    });

    it('while uploading both buttons are disabled and the label says Uploading…', async () => {
        let finish: (result: VideosSetImageResult) => void = () => undefined;
        const { user } = await openDetail({
            details: [withCustom],
            setImage: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });

        await user.click(card().getByRole('button', { name: 'Choose image…' }));

        expect(card().getByRole('button', { name: 'Uploading…' })).toBeDisabled();
        expect(card().getByRole('button', { name: 'Remove custom image' })).toBeDisabled();
        // The other page actions are blocked too.
        expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();

        finish({ ok: true, canceled: true });

        await waitFor(() =>
            expect(card().getByRole('button', { name: 'Choose image…' })).toBeEnabled(),
        );
        expect(card().getByRole('button', { name: 'Remove custom image' })).toBeEnabled();
    });

    it('remove: asks first, Cancel does nothing', async () => {
        const { user, removeImage } = await openDetail({ details: [withCustom] });

        await user.click(card().getByRole('button', { name: 'Remove custom image' }));

        const dialog = screen.getByRole('alertdialog');

        expect(within(dialog).getByText(CONFIRM_TEXT)).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        expect(removeImage).not.toHaveBeenCalled();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(card().getByRole('button', { name: 'Remove custom image' })).toHaveFocus();
    });

    it('remove: confirming calls the API, toasts, refetches and drops the chip', async () => {
        const { user, removeImage, get } = await openDetail({ details: [withCustom, {}] });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Remove custom image' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
        );

        expect(removeImage).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Custom thumbnail removed.')).toBeInTheDocument();
        await waitFor(() => expect(card().queryByText('Custom')).toBeNull());
        expect(card().queryByRole('button', { name: 'Remove custom image' })).toBeNull();
        expect(get.mock.calls.length).toBe(loads + 1);
        expect(card().getByRole('button', { name: 'Choose image…' })).toHaveFocus();
    });

    it('remove: "No custom thumbnail to remove." is shown and the state is re-read', async () => {
        const { user, get } = await openDetail({
            details: [withCustom, {}],
            removeImage: () =>
                Promise.resolve({ ok: false, error: 'No custom thumbnail to remove.' }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Remove custom image' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
        );

        expect(await screen.findByText(/No custom thumbnail to remove\./)).toBeInTheDocument();
        await waitFor(() => expect(card().queryByText('Custom')).toBeNull());
        expect(get.mock.calls.length).toBe(loads + 1);
    });
});
