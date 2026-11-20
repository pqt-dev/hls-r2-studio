import type { ComponentProps } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AddFilesResult } from '../../../shared/ipc';
import { makeJob } from '../testing/fakeApi';
import { renderApp, renderQueue } from '../testing/renderApp';
import { EmptyState } from './EmptyState';
import { GroupHeader } from './GroupHeader';
import { JobProgress } from './JobProgress';
import { JobStateChip } from './JobStateChip';
import { SectionCard } from './SectionCard';
import { StatTile } from './StatTile';
import { StatusCountChips } from './StatusCountChips';
import { VideoMenu } from './VideoMenu';
import { VideoQuickActions } from './VideoQuickActions';

describe('UploadVideosButton', () => {
    it('is the solid primary variant on Home, with the upload icon', async () => {
        await renderApp();

        const button = screen.getByRole('button', { name: 'Upload videos' });

        expect(button).toHaveClass('btn-primary', 'upload-videos');
        expect(button.querySelector('svg')).not.toBeNull();
    });

    it('is the accented create variant on the Library', async () => {
        const { user } = await renderApp();

        await user.click(screen.getByRole('tab', { name: 'Library' }));

        expect(await screen.findByRole('button', { name: 'Upload videos' })).toHaveClass(
            'btn-accent-create',
            'upload-videos',
        );
    });

    it('opens the Queue after an upload from another screen, but stays on the Queue', async () => {
        const { user, fake } = await renderApp();

        fake.api.jobs.addFiles = vi.fn(() =>
            Promise.resolve({ added: 1, rejected: [], canceled: false }),
        );
        await user.click(screen.getByRole('button', { name: 'Upload videos' }));
        expect(await screen.findByText('Added 1 video to the queue.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    it('in the Queue drop zone it uploads without navigating and is disabled while busy', async () => {
        const { user, fake } = await renderQueue();
        let finish: (value: AddFilesResult) => void = () => {};

        fake.api.jobs.addFiles = vi.fn(
            () =>
                new Promise<AddFilesResult>((resolve) => {
                    finish = resolve;
                }),
        );

        const button = within(screen.getByTestId('dropzone')).getByRole('button', {
            name: 'Upload videos',
        });

        await user.click(button);
        expect(button).toBeDisabled();

        finish({ added: 1, rejected: [], canceled: false });
        await waitFor(() => expect(button).toBeEnabled());
        expect(screen.getByRole('tab', { name: /^Queue/ })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });
});

describe('StatusCountChips', () => {
    const counts = { running: 1, waiting: 2, done: 3, failed: 4 };

    it('renders the four counts with their color classes and no attention chip at zero', () => {
        render(<StatusCountChips counts={counts} />);

        expect(screen.getByText('1 running')).toHaveClass('status-count-running');
        expect(screen.getByText('2 waiting')).toHaveClass('status-count-waiting');
        expect(screen.getByText('3 done')).toHaveClass('status-count-done');
        expect(screen.getByText('4 failed')).toHaveClass('status-count-failed');
        expect(screen.queryByText(/need attention/)).toBeNull();
    });

    it('shows the attention chip when above zero', () => {
        render(<StatusCountChips counts={{ ...counts, attention: 2 }} />);

        expect(screen.getByText('2 need attention')).toBeInTheDocument();
    });

    it('is plain text without onSelect and buttons with it', async () => {
        const { rerender } = render(<StatusCountChips counts={counts} />);

        expect(screen.queryAllByRole('button')).toHaveLength(0);

        const onSelect = vi.fn();

        rerender(<StatusCountChips counts={counts} onSelect={onSelect} />);
        await userEvent.click(screen.getByRole('button', { name: '3 done' }));
        expect(onSelect).toHaveBeenCalledWith('done');
    });
});

describe('StatTile as a filter', () => {
    it('is a toggle button with aria-pressed when selected is given', async () => {
        const onClick = vi.fn();

        render(
            <StatTile
                icon={null}
                value={3}
                label="Success"
                actionLabel="show success logs"
                selected
                onClick={onClick}
            />,
        );

        const button = screen.getByRole('button', { name: 'Success: 3, show success logs' });

        expect(button).toHaveAttribute('aria-pressed', 'true');
        expect(button).toHaveClass('is-selected');
        await userEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('has no pressed state when selected is omitted', () => {
        render(<StatTile icon={null} value={3} label="Ready" onClick={() => undefined} />);

        expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed');
    });
});

describe('VideoQuickActions', () => {
    it('renders the chosen actions in a fixed order, then the menu', async () => {
        const onQuick = vi.fn();

        render(
            <VideoQuickActions
                title="Alpha"
                busy={false}
                actions={['open', 'thumbnail-url', 'shortcode', 'embed-url']}
                onQuick={onQuick}
                menu={<button type="button">Menu</button>}
            />,
        );

        const group = screen.getByRole('group', { name: 'Quick actions for Alpha' });
        const labels = within(group)
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label') ?? button.textContent);

        expect(labels).toEqual([
            'Copy shortcode for Alpha',
            'Copy thumbnail URL for Alpha',
            'Copy direct URL for Alpha',
            'Open in browser for Alpha',
            'Menu',
        ]);
        expect(screen.getByRole('button', { name: 'Copy shortcode for Alpha' })).toHaveClass(
            'video-quick-primary',
        );
        expect(
            screen.getByRole('button', { name: 'Copy thumbnail URL for Alpha' }),
        ).not.toHaveClass('video-quick-primary');

        await userEvent.click(screen.getByRole('button', { name: 'Open in browser for Alpha' }));
        expect(onQuick).toHaveBeenCalledWith('open');
    });

    it('only renders the requested actions, disables them when busy, and supports ghost', () => {
        render(
            <VideoQuickActions
                title="Alpha"
                busy
                variant="ghost"
                actions={['shortcode']}
                onQuick={() => {}}
            />,
        );

        const button = screen.getByRole('button', { name: 'Copy shortcode for Alpha' });

        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(button).toBeDisabled();
        expect(button).toHaveClass('video-quick-ghost');
    });
});

describe('GroupHeader', () => {
    it('shows title, count and an optional action; the toggle reports clicks', async () => {
        const onToggle = vi.fn();

        render(
            <GroupHeader
                title="Finished"
                count={3}
                open
                onToggle={onToggle}
                action={<button type="button">Clear</button>}
            />,
        );

        expect(screen.getByRole('button', { name: /Finished/ })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        expect(screen.getByRole('button', { name: 'Clear' }).parentElement).toHaveClass(
            'group-header-action',
        );
        await userEvent.click(screen.getByRole('button', { name: /Finished/ }));
        expect(onToggle).toHaveBeenCalledTimes(1);
    });
});

describe('Queue rows with the shared pieces', () => {
    it('shows the accented View in Library button, View details and Remove on a finished row, with the shared row surface', async () => {
        await renderQueue({
            jobs: [
                makeJob({
                    id: 'd',
                    fileName: 'done.mp4',
                    state: 'done',
                    canRemove: true,
                }),
            ],
        });

        const row = document.querySelector<HTMLElement>('li[data-job-id="d"]')!;

        expect(row).toHaveClass('row-surface');
        // No quick actions cluster (and no empty group) in the Queue.
        expect(within(row).queryByRole('group')).toBeNull();
        expect(
            within(row)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual([
            'View in Library for done.mp4',
            'View details for done.mp4',
            'Remove for done.mp4',
        ]);
        expect(
            within(row).getByRole('button', { name: 'View in Library for done.mp4' }),
        ).toHaveClass('video-quick-primary');
    });

    it('puts Clear finished in the Finished group header, right of the title', async () => {
        await renderQueue({
            jobs: [makeJob({ id: 'd', state: 'done', canRemove: true })],
        });

        const header = document.querySelector<HTMLElement>('[data-group="4"] .group-header')!;
        const clear = within(header).getByRole('button', { name: 'Clear finished' });

        expect(clear.parentElement).toHaveClass('group-header-action');
        expect(within(header).getByText('Finished')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Queue' })).toBeNull();
    });

    it('keeps Clear finished on the header when the finished group is collapsed', async () => {
        const { user } = await renderQueue({
            jobs: [makeJob({ id: 'd', state: 'done', canRemove: true })],
        });

        await user.click(screen.getByRole('button', { name: /Finished/ }));
        await user.click(screen.getByRole('button', { name: /Finished/ }));
        expect(screen.getByRole('button', { name: 'Clear finished' })).toBeInTheDocument();
    });

    it('has the relative time with the full date-time as tooltip, and a neutral media tile', async () => {
        await renderQueue({
            jobs: [makeJob({ id: 'd', state: 'done', finishedAt: '2026-01-02T03:04:05Z' })],
        });

        const row = document.querySelector<HTMLElement>('li[data-job-id="d"]')!;

        expect(row.querySelector('time')!.getAttribute('title')).not.toBe('');
        expect(row.querySelector('.media-tile')).not.toBeNull();
        expect(row.querySelector('.thumb-frame')).toBeNull();
    });

    it('shows the footer as status count chips', async () => {
        await renderQueue({ jobs: [makeJob({ id: 'd', state: 'done' })] });

        const footer = document.querySelector<HTMLElement>('.queue-footer')!;

        expect(within(footer).getByText('1 done')).toHaveClass('status-count-done');
    });
});

describe('EmptyState', () => {
    it('renders the icon circle, title, description and action', () => {
        render(
            <EmptyState
                icon={<svg data-testid="icon" />}
                title="Nothing yet"
                description="Come back later."
                action={<button type="button">Do it</button>}
            />,
        );

        expect(screen.getByText('Nothing yet')).toHaveClass('empty-title');
        expect(screen.getByText('Come back later.')).toHaveClass('muted');
        expect(screen.getByTestId('icon').closest('.empty-icon')).toHaveAttribute(
            'aria-hidden',
            'true',
        );
        expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
    });

    it('omits the optional parts', () => {
        const { container } = render(<EmptyState compact title="Nothing here." />);

        expect(container.querySelector('.empty-icon')).toBeNull();
        expect(container.querySelector('.muted')).toBeNull();
        expect(container.firstElementChild).toHaveClass('empty', 'is-compact');
    });

    it('is used by the Queue, Library, Logs and Home placeholders', async () => {
        const { user } = await renderApp();

        const recent = screen.getByRole('region', { name: 'Recent videos' });

        expect(
            (await within(recent).findByText('No videos yet')).closest('.empty-state'),
        ).not.toBeNull();

        await user.click(screen.getByRole('tab', { name: /^Queue/ }));
        expect(screen.getByText('No videos in the queue').closest('.empty-state')).not.toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Library' }));
        expect((await screen.findByText('No videos yet')).closest('.empty-state')).not.toBeNull();

        await user.click(screen.getByRole('tab', { name: 'Logs' }));
        expect((await screen.findByText('No error logs.')).closest('.empty-state')).not.toBeNull();
    });
});

describe('SectionCard and heading GroupHeader', () => {
    it('is a card region named by its heading, with an action slot', () => {
        render(
            <SectionCard title="Account" action={<button type="button">Go</button>}>
                <p>Body</p>
            </SectionCard>,
        );

        const region = screen.getByRole('region', { name: 'Account' });

        expect(region).toHaveClass('card');
        expect(
            within(region).getByRole('heading', { level: 2, name: 'Account' }),
        ).toBeInTheDocument();
        expect(within(region).getByRole('button', { name: 'Go' })).toBeInTheDocument();
    });

    it('can use heading level 3', () => {
        render(
            <SectionCard title="Recent" level={3}>
                <p>Body</p>
            </SectionCard>,
        );

        expect(screen.getByRole('heading', { level: 3, name: 'Recent' })).toBeInTheDocument();
    });

    it('renders the GroupHeader title as a heading without the count in its name', () => {
        render(<GroupHeader title="Recent errors" count={3} headingLevel={3} />);

        expect(screen.getByRole('heading', { level: 3, name: 'Recent errors' })).toHaveClass(
            'group-header-title',
        );
        expect(screen.getByText('3')).toHaveClass('group-header-count');
    });
});

describe('VideoMenu optional items', () => {
    function open(props: Partial<ComponentProps<typeof VideoMenu>> = {}) {
        render(
            <VideoMenu
                title="Alpha"
                busy={false}
                ready
                onQuick={vi.fn()}
                onOpen={vi.fn()}
                {...props}
            />,
        );

        return userEvent.click(screen.getByRole('button', { name: 'More actions for Alpha' }));
    }

    const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

    it('has no Select and no Delete unless the caller passes them (Home)', async () => {
        await open();

        expect(items()).toEqual(['Copy direct URL', 'Open in browser', 'Details']);
    });

    it('keeps the Library menu: Select first, Delete last', async () => {
        await open({ onSelect: vi.fn(), onDelete: vi.fn() });

        expect(items()).toEqual([
            'Select',
            'Copy direct URL',
            'Open in browser',
            'Details',
            'Delete',
        ]);
    });

    it('offers only Details for a video that is not ready', async () => {
        await open({ ready: false });

        expect(items()).toEqual(['Details']);
    });
});

describe('JobProgress', () => {
    it('renders a progress bar named after the file with the percent', () => {
        render(<JobProgress fileName="clip.mp4" progress={42} />);

        const bar = screen.getByRole('progressbar', { name: 'Progress of clip.mp4' });

        expect(bar).toHaveAttribute('value', '42');
        expect(screen.getByText('42%')).toHaveClass('job-percent');
    });
});

describe('JobStateChip', () => {
    it('shows the stage label in a chip of the status kind', () => {
        render(<JobStateChip job={{ state: 'needs_sign_in', waitingForNetwork: false }} />);

        expect(screen.getByText('Sign-in needed').closest('.chip')).toHaveClass('chip-attention');
    });

    it('says it waits for the network when the upload retries offline', () => {
        render(<JobStateChip job={{ state: 'uploading', waitingForNetwork: true }} />);

        expect(screen.getByText('Waiting for network…')).toBeInTheDocument();
    });
});
