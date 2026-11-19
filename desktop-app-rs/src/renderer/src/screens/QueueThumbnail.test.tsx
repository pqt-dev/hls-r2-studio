import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobDto } from '../../../shared/ipc';
import { makeJob } from '../testing/fakeApi';
import { renderQueue } from '../testing/renderApp';

const THUMB = 'https://cdn.example.com/2026/01/01/clip-abc/thumbnail.jpg';

function doneJob(partial: Partial<JobDto> = {}): JobDto {
    return makeJob({
        id: 'a',
        fileName: 'clip.mp4',
        state: 'done',
        progress: 100,
        canRemove: true,
        embedUrl: 'https://site.example.com/embed/abc123',
        publicId: 'abc123',
        ...partial,
    });
}

function row(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-job-id="a"]');

    if (element === null) throw new Error('row not found');

    return element;
}

describe('Queue row thumbnail', () => {
    it('shows the real thumbnail when Rust supplies its URL', async () => {
        await renderQueue({ jobs: [doneJob({ videoId: 7, thumbnailUrl: THUMB })] });

        expect(row().querySelector('.media-tile img.thumb')).toHaveAttribute('src', THUMB);
    });

    it('shows the neutral icon tile when there is no thumbnail URL', async () => {
        await renderQueue({ jobs: [doneJob({ videoId: 7 })] });

        expect(row().querySelector('.media-tile img')).toBeNull();
        expect(row().querySelector('.media-tile svg')).not.toBeNull();
    });

    it('falls back to the icon tile when the image fails to load', async () => {
        await renderQueue({ jobs: [doneJob({ videoId: 7, thumbnailUrl: THUMB })] });

        fireEvent.error(row().querySelector('.media-tile img') as HTMLImageElement);

        expect(row().querySelector('.media-tile img')).toBeNull();
        expect(row().querySelector('.media-tile svg')).not.toBeNull();
        expect(row().querySelector('.thumb-placeholder')).toBeNull();
    });

    it('copies the thumbnail URL by video id through Rust', async () => {
        const { fake, user } = await renderQueue({
            jobs: [doneJob({ videoId: 7, thumbnailUrl: THUMB })],
        });
        const copyLink = vi.spyOn(fake.api.videos, 'copyLink');
        const group = within(row()).getByRole('group', { name: 'Quick actions for clip.mp4' });
        const buttons = within(group).getAllByRole('button');

        // Same order as the Library: shortcode, thumbnail, then the menu.
        expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
            'Copy shortcode for clip.mp4',
            'Copy thumbnail URL for clip.mp4',
            'More actions for clip.mp4',
        ]);

        await user.click(within(group).getByRole('button', { name: /Copy thumbnail URL/ }));

        expect(copyLink).toHaveBeenCalledWith(7, 'thumbnail-url');
        expect(await screen.findByText('Thumbnail URL copied.')).toBeInTheDocument();
    });

    it('offers no thumbnail copy without a video id or without a thumbnail URL', async () => {
        await renderQueue({
            jobs: [
                doneJob({ id: 'a', thumbnailUrl: THUMB }),
                doneJob({ id: 'b', fileName: 'other.mp4', videoId: 8 }),
            ],
        });

        expect(screen.queryByRole('button', { name: /Copy thumbnail URL/ })).toBeNull();
    });
});
