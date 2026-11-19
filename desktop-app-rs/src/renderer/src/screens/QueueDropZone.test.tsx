import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeJob } from '../testing/fakeApi';
import { renderQueue } from '../testing/renderApp';

const zone = () => screen.getByTestId('dropzone');
const queue = () => document.querySelector<HTMLElement>('.queue')!;

describe('Queue drop zone card', () => {
    it('is a labelled group in a sticky header with the title, hint and Upload button', async () => {
        await renderQueue();

        const group = screen.getByRole('group', { name: 'Upload videos' });

        expect(group).toBe(zone());
        expect(group.closest('.queue-sticky')).not.toBeNull();
        expect(within(group).getByText('Drop videos here to upload')).toBeInTheDocument();
        expect(within(group).getByText(/MP4, MOV, MKV, AVI or WebM/)).toBeInTheDocument();
        expect(within(group).getByRole('button', { name: 'Upload videos' })).toBeInTheDocument();
    });

    it('is roomy when the queue is empty and compact when it has jobs', async () => {
        const empty = await renderQueue();

        expect(zone()).not.toHaveClass('is-compact');
        empty.unmount();

        await renderQueue({ jobs: [makeJob({ id: 'a', state: 'waiting' })] });
        expect(zone()).toHaveClass('is-compact');
    });

    it('shows the drag state while files are over the card and clears it on body leave', async () => {
        await renderQueue();

        fireEvent.dragEnter(zone(), { dataTransfer: { types: ['Files'], files: [] } });
        expect(zone()).toHaveClass('is-dragging');
        expect(screen.getByText('Release to upload the videos')).toBeInTheDocument();
        expect(screen.queryByText('Drop videos here to upload')).toBeNull();

        fireEvent.dragLeave(document.body);
        expect(zone()).not.toHaveClass('is-dragging');
        expect(screen.getByText('Drop videos here to upload')).toBeInTheDocument();
    });

    it('is in the normal state by default', async () => {
        await renderQueue();

        expect(zone()).toHaveClass('dropzone');
        expect(zone()).not.toHaveClass('is-dragging');
        expect(zone()).toHaveAttribute('data-testid', 'dropzone');
    });

    it('highlights for a dragover on a child of the card, even with an empty DataTransfer', async () => {
        await renderQueue();

        fireEvent.dragOver(within(zone()).getByText('Drop videos here to upload'), {
            dataTransfer: { types: [], files: [] },
        });
        expect(zone()).toHaveClass('is-dragging');
    });

    it('does NOT highlight for a dragover on another element of the Queue or the window', async () => {
        await renderQueue({ jobs: [makeJob({ id: 'a', fileName: 'one.mp4', state: 'waiting' })] });

        const data = { dataTransfer: { types: ['Files'], files: [] } };

        fireEvent.dragEnter(queue(), data);
        fireEvent.dragOver(screen.getByRole('list', { name: 'Video queue' }), data);
        fireEvent.dragOver(document.body, data);
        expect(zone()).not.toHaveClass('is-dragging');
    });

    it('toggles with the pointer: on over the card, off when it moves outside, on again', async () => {
        await renderQueue({ jobs: [makeJob({ id: 'a', fileName: 'one.mp4', state: 'waiting' })] });

        const data = { dataTransfer: { types: [], files: [] } };
        const list = screen.getByRole('list', { name: 'Video queue' });

        fireEvent.dragOver(zone(), data);
        expect(zone()).toHaveClass('is-dragging');
        fireEvent.dragOver(list, data);
        expect(zone()).not.toHaveClass('is-dragging');
        fireEvent.dragOver(zone(), data);
        expect(zone()).toHaveClass('is-dragging');
    });

    it('ignores drags that carry no files (text, links)', async () => {
        await renderQueue();

        fireEvent.dragEnter(zone(), { dataTransfer: { types: ['text/plain'], files: [] } });
        fireEvent.dragOver(zone(), { dataTransfer: { types: ['text/plain'], files: [] } });
        expect(zone()).not.toHaveClass('is-dragging');
    });

    it('prevents the default on a file dragover so a drop is allowed', async () => {
        await renderQueue();

        expect(fireEvent.dragOver(zone(), { dataTransfer: { types: ['Files'] } })).toBe(false);
    });

    it('adds files dropped on the card, clears the state and shows the toast', async () => {
        const { fake } = await renderQueue();
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');
        const files = [new File(['a'], 'one.mp4', { type: 'video/mp4' })];

        fireEvent.dragEnter(zone(), { dataTransfer: { types: ['Files'], files } });
        expect(zone()).toHaveClass('is-dragging');

        // Default is prevented so the webview does not open the file.
        const notPrevented = fireEvent.drop(zone(), { dataTransfer: { types: ['Files'], files } });

        expect(notPrevented).toBe(false);
        expect(zone()).not.toHaveClass('is-dragging');
        await waitFor(() => expect(addDropped).toHaveBeenCalledTimes(1));
        expect(addDropped.mock.calls[0]?.[0]).toEqual(files);
        expect(await screen.findByText('Added 1 video to the queue.')).toBeInTheDocument();
    });

    it('adds nothing for a drop outside the card, but still prevents the default and resets', async () => {
        const { fake } = await renderQueue({
            jobs: [makeJob({ id: 'a', fileName: 'one.mp4', state: 'waiting' })],
        });
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');
        const files = [new File(['a'], 'one.mp4', { type: 'video/mp4' })];
        const data = { dataTransfer: { types: ['Files'], files } };
        const list = screen.getByRole('list', { name: 'Video queue' });

        fireEvent.dragOver(zone(), data);
        expect(zone()).toHaveClass('is-dragging');

        expect(fireEvent.drop(list, data)).toBe(false);
        expect(fireEvent.drop(document.body, data)).toBe(false);
        expect(zone()).not.toHaveClass('is-dragging');
        expect(addDropped).not.toHaveBeenCalled();
    });

    it('calls the add API once for a drop on the card even with an empty file list', async () => {
        const { fake } = await renderQueue();
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');

        fireEvent.drop(zone(), { dataTransfer: { types: ['Files'], files: [] } });
        await waitFor(() => expect(addDropped).toHaveBeenCalledTimes(1));
        expect(addDropped.mock.calls[0]?.[0]).toEqual([]);
    });

    it('does not call the add API for an empty-list drop outside the card', async () => {
        const { fake } = await renderQueue();
        const addDropped = vi.spyOn(fake.api.jobs, 'addDroppedFiles');

        fireEvent.drop(document.body, { dataTransfer: { types: ['Files'], files: [] } });
        expect(addDropped).not.toHaveBeenCalled();
    });

    it('resets on dragend', async () => {
        await renderQueue();

        fireEvent.dragOver(zone(), { dataTransfer: { types: ['Files'], files: [] } });
        expect(zone()).toHaveClass('is-dragging');
        fireEvent.dragEnd(document.body);
        expect(zone()).not.toHaveClass('is-dragging');
    });

    it('disables the Upload button while a drop is being processed', async () => {
        const { fake } = await renderQueue();
        let finish: () => void = () => {};

        vi.spyOn(fake.api.jobs, 'addDroppedFiles').mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ added: 1, rejected: [], canceled: false });
                }),
        );
        fireEvent.drop(zone(), {
            dataTransfer: { types: ['Files'], files: [new File(['a'], 'a.mp4')] },
        });

        const button = within(zone()).getByRole('button', { name: 'Upload videos' });

        await waitFor(() => expect(button).toBeDisabled());
        finish();
        await waitFor(() => expect(button).toBeEnabled());
    });
});

const holderOf = (band: HTMLElement): HTMLElement =>
    band.closest<HTMLElement>('.panel') ?? band.parentElement!;

describe('Queue sticky band scroll offset', () => {
    const original = globalThis.ResizeObserver;

    afterEach(() => {
        globalThis.ResizeObserver = original;
    });

    it('publishes the band height as --queue-sticky-h when ResizeObserver exists', async () => {
        const observe = vi.fn();
        const disconnect = vi.fn();

        globalThis.ResizeObserver = class {
            constructor(public cb: () => void) {}
            observe = observe;
            unobserve = vi.fn();
            disconnect = disconnect;
        } as unknown as typeof ResizeObserver;
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get: () => 88,
        });

        const view = await renderQueue();
        const band = document.querySelector<HTMLElement>('.queue-sticky')!;

        expect(observe).toHaveBeenCalledWith(band);
        expect(holderOf(band).style.getPropertyValue('--queue-sticky-h')).toBe('88px');

        const holder = holderOf(band);

        view.unmount();
        expect(disconnect).toHaveBeenCalled();
        expect(holder.style.getPropertyValue('--queue-sticky-h')).toBe('');
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    });

    it('renders fine without ResizeObserver', async () => {
        // @ts-expect-error simulating an environment without ResizeObserver
        delete globalThis.ResizeObserver;

        await renderQueue();
        expect(zone()).toBeInTheDocument();
    });
});
