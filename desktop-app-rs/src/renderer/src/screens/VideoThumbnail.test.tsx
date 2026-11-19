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
const CONFIRM_TEXT = 'Delete this custom image?';

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
    return within(screen.getByRole('region', { name: 'Images' }));
}

describe('Images card (video detail)', () => {
    it('without a custom image: Thumbnail card, dashed upload tile, no Replace/Delete', async () => {
        await openDetail();

        const labels = Array.from(document.querySelectorAll('.image-card-label')).map(
            (node) => node.textContent,
        );

        expect(labels).toEqual(['Thumbnail', 'Custom image']);
        expect(card().getByRole('button', { name: 'Upload image' })).toBeEnabled();
        expect(card().queryByRole('button', { name: 'Replace' })).toBeNull();
        expect(card().queryByRole('button', { name: 'Delete' })).toBeNull();
        expect(card().getByRole('button', { name: 'Copy thumbnail URL' })).toBeEnabled();
        // One compact line: the URL is the text (CSS ellipsises it), also in the tooltip, and the
        // Copy button sits in the same single-row box.
        const urlText = card().getByText(GENERATED_URL);

        expect(urlText).toHaveAttribute('title', GENERATED_URL);
        const urlBox = urlText.closest('.embed-box') as HTMLElement;

        expect(urlBox).toBeInTheDocument();
        expect(urlBox).not.toHaveClass('embed-box-full');
        expect(urlBox).not.toHaveClass('embed-box-wrap');
        // Middle ellipsis: head + tail spans are aria-hidden, the full URL is read once.
        expect(urlBox.querySelector('.embed-value-head')).toHaveAttribute('aria-hidden', 'true');
        expect(urlBox.querySelector('.embed-value-tail')).toHaveAttribute('aria-hidden', 'true');
        expect(urlBox).toContainElement(card().getByRole('button', { name: 'Copy thumbnail URL' }));
        // The empty tile carries the limits hint itself, so the block-level one is not repeated.
        expect(
            within(document.querySelector('.image-upload-tile') as HTMLElement).getByText(
                'JPG, PNG or WebP · up to 5 MB',
            ),
        ).toBeInTheDocument();
        expect(card().queryByText('JPG, PNG or WebP, up to 5 MB.')).toBeNull();
        expect(card().getByText('No custom image')).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Images' }).querySelector('img')).toHaveAttribute(
            'src',
            GENERATED_URL,
        );
    });

    it('with a custom image: both images side by side, the thumbnail is not replaced', async () => {
        await openDetail({ details: [withCustom] });

        const sources = Array.from(
            screen.getByRole('region', { name: 'Images' }).querySelectorAll('img'),
        ).map((img) => img.getAttribute('src'));

        expect(sources).toEqual([GENERATED_URL, CUSTOM_URL]);
        expect(
            document.querySelectorAll('.image-row[data-row="thumbnails"] .image-card'),
        ).toHaveLength(2);
        expect(card().getByRole('button', { name: 'Replace' })).toBeEnabled();
        expect(card().getByRole('button', { name: 'Delete' })).toBeEnabled();
        expect(card().getByRole('button', { name: 'Copy custom image URL' })).toBeEnabled();
        expect(card().queryByRole('button', { name: 'Upload image' })).toBeNull();
        expect(card().getByText(CUSTOM_URL)).toHaveAttribute('title', CUSTOM_URL);
        expect(card().getByText('JPG, PNG or WebP, up to 5 MB.')).toBeInTheDocument();
        expect(card().queryByText('No custom image')).toBeNull();
    });

    it('puts the storyboards after the other tiles in the one Images gallery, labelled and in order', async () => {
        const SB3 = 'https://cdn.example.com/sb3.jpg';
        const SB5 = 'https://cdn.example.com/sb5.jpg';
        const storyboards = {
            '3x3': { url: SB3, columns: 3, count: 9 },
            '4x4': { url: null, columns: 4, count: 16 },
            '5x5': { url: SB5, columns: 5, count: 25 },
        };
        const { user, fake } = await openDetail({ details: [{ ...withCustom, storyboards }] });
        const copyLink = vi.spyOn(fake.api.videos, 'copyLink');
        const block = screen.getByRole('region', { name: 'Images' });

        expect(screen.getAllByRole('region', { name: 'Images' })).toHaveLength(1);
        expect(screen.queryByRole('region', { name: 'Storyboards' })).toBeNull();
        expect(
            Array.from(block.querySelectorAll('.image-card-label')).map((node) => node.textContent),
        ).toEqual(['Thumbnail', 'Custom image', 'Storyboard 1', 'Storyboard 2']);
        expect(
            Array.from(block.querySelectorAll('img')).map((img) => img.getAttribute('src')),
        ).toEqual([GENERATED_URL, CUSTOM_URL, SB3, SB5]);
        const rows = block.querySelectorAll('.image-row');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.getAttribute('data-row')).toBe('thumbnails');
        expect(rows[1]!.getAttribute('data-row')).toBe('storyboards');
        expect(rows[0]!.textContent).toContain('Thumbnails');
        expect(rows[1]!.textContent).toContain('Storyboards');
        expect(
            Array.from(rows[0]!.querySelectorAll('.image-card-label')).map((n) => n.textContent),
        ).toEqual(['Thumbnail', 'Custom image']);
        expect(
            Array.from(rows[1]!.querySelectorAll('.image-card-label')).map((n) => n.textContent),
        ).toEqual(['Storyboard 1', 'Storyboard 2']);

        // Every tile has its Copy button after the image, inside the same tile.
        for (const tile of Array.from(block.querySelectorAll('.image-card'))) {
            const frame = tile.querySelector('.image-card-frame') as HTMLElement;
            const actions = tile.querySelector('.image-card-actions') as HTMLElement;

            expect(frame.compareDocumentPosition(actions)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
            expect(within(actions).getByRole('button', { name: /^Copy/ })).toBeInTheDocument();
        }

        await user.click(card().getByRole('button', { name: 'Copy storyboard 1 URL' }));
        await user.click(card().getByRole('button', { name: 'Copy storyboard 2 URL' }));

        expect(copyLink).toHaveBeenNthCalledWith(1, 7, 'storyboard-url', 0);
        expect(copyLink).toHaveBeenNthCalledWith(2, 7, 'storyboard-url', 1);
    });

    it('labels a single storyboard just Storyboard, and the upload tile has no Copy', async () => {
        const { user, fake } = await openDetail({
            details: [
                {
                    storyboards: {
                        '3x3': { url: 'https://cdn.example.com/sb.jpg', columns: 3, count: 9 },
                    },
                },
            ],
        });
        const copyLink = vi.spyOn(fake.api.videos, 'copyLink');

        expect(
            Array.from(document.querySelectorAll('.image-card-label')).map((n) => n.textContent),
        ).toEqual(['Thumbnail', 'Custom image', 'Storyboard']);
        // Copy buttons: thumbnail + storyboard only (the upload tile has none).
        expect(card().getAllByRole('button', { name: /^Copy/ })).toHaveLength(2);

        await user.click(card().getByRole('button', { name: 'Copy storyboard URL' }));
        expect(copyLink).toHaveBeenCalledWith(7, 'storyboard-url', 0);
    });

    it('Replace and Delete sit in the custom tile label bar; Copy is a URL box with feedback', async () => {
        const { user } = await openDetail({ details: [withCustom] });
        const tile = screen.getByText('Custom image').closest('figure') as HTMLElement;
        const bar = tile.querySelector('.image-card-bar') as HTMLElement;

        expect(within(bar).getByRole('button', { name: 'Replace' })).toBeInTheDocument();
        expect(within(bar).getByRole('button', { name: 'Delete' })).toBeInTheDocument();

        const box = tile.querySelector('.image-card-actions .embed-box') as HTMLElement;

        expect(box).toHaveTextContent(CUSTOM_URL);

        const copy = within(box).getByRole('button', { name: 'Copy custom image URL' });

        await user.click(copy);
        await waitFor(() => expect(copy).toHaveAttribute('title', 'Copied'));
    });

    it('shows the Images block before the Information block', async () => {
        await openDetail();

        const images = screen.getByRole('region', { name: 'Images' });
        const info = screen.getByText('Information').closest('section') as HTMLElement;

        expect(images.compareDocumentPosition(info)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('has no storyboard row when the video has no storyboards', async () => {
        await openDetail();

        expect(document.querySelector('.image-card-wide')).toBeNull();
        expect(document.querySelectorAll('.image-row')).toHaveLength(1);
        expect(card().queryByRole('button', { name: /storyboard/i })).toBeNull();
    });

    it('the Preview poster of a video that is not ready uses the generated thumbnail', async () => {
        await openDetail({ details: [{ ...withCustom, status: 'processing' }] });

        const preview = screen.getByRole('region', { name: 'Preview' });

        expect(preview.querySelector('img')).toHaveAttribute('src', GENERATED_URL);
    });

    it('Copy asks the main process to copy the thumbnail or the custom image URL', async () => {
        const { user, fake } = await openDetail({ details: [withCustom] });
        const copyLink = vi.spyOn(fake.api.videos, 'copyLink');

        await user.click(card().getByRole('button', { name: 'Copy thumbnail URL' }));
        await user.click(card().getByRole('button', { name: 'Copy custom image URL' }));

        expect(copyLink).toHaveBeenNthCalledWith(1, 7, 'thumbnail-url');
        expect(copyLink).toHaveBeenNthCalledWith(2, 7, 'custom-image-url');
    });

    it('shows a No thumbnail placeholder when there is no generated thumbnail', async () => {
        await openDetail({ details: [{ thumbnailUrl: null }] });

        expect(card().getAllByText('No thumbnail').length).toBeGreaterThan(0);
        expect(card().getByRole('button', { name: 'Copy thumbnail URL' })).toBeDisabled();
    });

    it('choose: calls setImage with the id only, toasts, refetches and updates the list row', async () => {
        const { user, setImage, get, list } = await openDetail({ details: [{}, withCustom] });
        const loads = get.mock.calls.length;
        const lists = list.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Upload image' }));

        expect(setImage).toHaveBeenCalledTimes(1);
        expect(setImage).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Custom image updated.')).toBeInTheDocument();
        await waitFor(() =>
            expect(card().getByRole('button', { name: 'Replace' })).toBeInTheDocument(),
        );
        expect(get.mock.calls.length).toBe(loads + 1);
        expect(card().getByRole('button', { name: 'Replace' })).toHaveFocus();

        await user.click(screen.getByRole('button', { name: 'Back to Library' }));

        // The list was not reloaded and its thumbnail stays the generated one.
        expect(list.mock.calls.length).toBe(lists);

        const rowHtml = screen
            .getByRole('button', { name: /^Holiday/ })
            .closest('li, article, div')?.innerHTML;

        expect(rowHtml).toContain(GENERATED_URL);
        expect(rowHtml).not.toContain(CUSTOM_URL);
    });

    it('canceling the picker is a no-op: no toast, no refetch', async () => {
        const { user, get } = await openDetail({
            setImage: () => Promise.resolve({ ok: true, canceled: true }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Upload image' }));
        await waitFor(() =>
            expect(card().getByRole('button', { name: 'Upload image' })).toBeEnabled(),
        );

        expect(screen.queryByText('Custom image updated.')).toBeNull();
        expect(screen.getByRole('status')).toBeEmptyDOMElement();
        expect(get.mock.calls.length).toBe(loads);
    });

    it('an error shows the safe message, does not refetch and re-enables the button', async () => {
        const { user, get } = await openDetail({
            setImage: () =>
                Promise.resolve({ ok: false, error: 'Choose a JPG, PNG or WebP image.' }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Upload image' }));

        expect(await screen.findByText(/Choose a JPG, PNG or WebP image\./)).toBeInTheDocument();
        expect(get.mock.calls.length).toBe(loads);
        expect(card().getByRole('button', { name: 'Upload image' })).toBeEnabled();
        expect(card().getByRole('button', { name: 'Upload image' })).toHaveFocus();
    });

    it('a rejected call shows the generic error', async () => {
        const { user } = await openDetail({ setImage: () => Promise.reject(new Error('boom')) });

        await user.click(card().getByRole('button', { name: 'Upload image' }));

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

        await user.click(card().getByRole('button', { name: 'Replace' }));

        expect(card().getByRole('button', { name: 'Uploading…' })).toBeDisabled();
        expect(card().getByRole('button', { name: 'Delete' })).toBeDisabled();
        // The other page actions are blocked too.
        expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();

        finish({ ok: true, canceled: true });

        await waitFor(() => expect(card().getByRole('button', { name: 'Replace' })).toBeEnabled());
        expect(card().getByRole('button', { name: 'Delete' })).toBeEnabled();
    });

    it('remove: asks first, Cancel does nothing', async () => {
        const { user, removeImage } = await openDetail({ details: [withCustom] });

        await user.click(card().getByRole('button', { name: 'Delete' }));

        const dialog = screen.getByRole('alertdialog');

        expect(within(dialog).getByText('Delete image')).toBeInTheDocument();
        expect(within(dialog).getByText(CONFIRM_TEXT)).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        expect(removeImage).not.toHaveBeenCalled();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(card().getByRole('button', { name: 'Delete' })).toHaveFocus();
    });

    it('remove: confirming calls the API, toasts, refetches and drops the chip', async () => {
        const { user, removeImage, get } = await openDetail({ details: [withCustom, {}] });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(removeImage).toHaveBeenCalledWith(7);
        expect(await screen.findByText('Custom image deleted.')).toBeInTheDocument();
        await waitFor(() => expect(card().queryByRole('button', { name: 'Replace' })).toBeNull());
        expect(card().queryByRole('button', { name: 'Delete' })).toBeNull();
        expect(get.mock.calls.length).toBe(loads + 1);
        expect(card().getByRole('button', { name: 'Upload image' })).toHaveFocus();
    });

    it('remove: "No custom thumbnail to remove." is shown and the state is re-read', async () => {
        const { user, get } = await openDetail({
            details: [withCustom, {}],
            removeImage: () =>
                Promise.resolve({ ok: false, error: 'No custom thumbnail to remove.' }),
        });
        const loads = get.mock.calls.length;

        await user.click(card().getByRole('button', { name: 'Delete' }));
        await user.click(
            within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
        );

        expect(await screen.findByText(/No custom thumbnail to remove\./)).toBeInTheDocument();
        await waitFor(() => expect(card().queryByRole('button', { name: 'Replace' })).toBeNull());
        expect(get.mock.calls.length).toBe(loads + 1);
    });

    describe('click to zoom', () => {
        const SB3 = 'https://cdn.example.com/sb3.jpg';
        const SB5 = 'https://cdn.example.com/sb5.jpg';
        const storyboards = {
            '3x3': { url: SB3, columns: 3, count: 9 },
            '5x5': { url: SB5, columns: 5, count: 25 },
        };

        it('opens the same image in a square dialog; Close returns focus to the trigger', async () => {
            const { user } = await openDetail();
            const trigger = card().getByRole('button', { name: 'Enlarge Thumbnail' });

            expect(trigger).toHaveAttribute('title', 'Click to enlarge');
            await user.click(trigger);

            const dialog = screen.getByRole('dialog', { name: 'Thumbnail preview' });

            expect(dialog).toHaveAttribute('aria-modal', 'true');
            expect(dialog.querySelector('img')).toHaveAttribute('src', GENERATED_URL);
            expect(dialog.querySelector('img')).toHaveAttribute('loading', 'eager');
            expect(dialog.querySelector('.image-zoom-frame img')).not.toBeNull();
            const close = within(dialog).getByRole('button', { name: 'Close' });

            expect(close).toHaveFocus();
            await user.tab();
            expect(close).toHaveFocus();
            await user.click(close);
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(trigger).toHaveFocus();
        });

        it('Escape closes only the zoom; a backdrop click closes it too', async () => {
            const { user } = await openDetail();
            const trigger = card().getByRole('button', { name: 'Enlarge Thumbnail' });

            await user.click(trigger);
            await user.keyboard('{Escape}');
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(trigger).toHaveFocus();
            // The detail page itself is still open.
            expect(screen.getByText('Information')).toBeInTheDocument();

            await user.click(trigger);
            await user.click(document.querySelector('.image-zoom-backdrop') as HTMLElement);
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('custom image and every storyboard open their own image', async () => {
            const { user } = await openDetail({ details: [{ ...withCustom, storyboards }] });

            for (const [name, src] of [
                ['Custom image', CUSTOM_URL],
                ['Storyboard 1', SB3],
                ['Storyboard 2', SB5],
            ] as const) {
                await user.click(card().getByRole('button', { name: `Enlarge ${name}` }));
                expect(
                    within(screen.getByRole('dialog', { name: `${name} preview` }))
                        .getByRole('img')
                        .getAttribute('src'),
                ).toBe(src);
                await user.keyboard('{Escape}');
                expect(screen.queryByRole('dialog')).toBeNull();
            }
        });

        it('has no trigger on the empty upload tile or the No thumbnail placeholder', async () => {
            await openDetail({ details: [{ thumbnailUrl: null }] });

            expect(card().getByText('No thumbnail')).toBeInTheDocument();
            expect(card().queryByRole('button', { name: /^Enlarge/ })).toBeNull();
            expect(document.querySelector('.image-upload-tile .image-zoom-trigger')).toBeNull();
        });

        it('keeps Copy, Replace and Delete outside the trigger and working', async () => {
            const { user, fake } = await openDetail({ details: [withCustom] });
            const copyLink = vi.spyOn(fake.api.videos, 'copyLink');
            const triggers = Array.from(document.querySelectorAll('.image-zoom-trigger'));

            expect(triggers).toHaveLength(2);
            for (const name of ['Replace', 'Delete', 'Copy custom image URL']) {
                const button = card().getByRole('button', { name });

                expect(triggers.some((t) => t.contains(button))).toBe(false);
            }
            await user.click(card().getByRole('button', { name: 'Copy custom image URL' }));
            expect(copyLink).toHaveBeenCalled();
            await user.click(card().getByRole('button', { name: 'Delete' }));
            expect(screen.getByText(CONFIRM_TEXT)).toBeInTheDocument();
        });
    });
});
