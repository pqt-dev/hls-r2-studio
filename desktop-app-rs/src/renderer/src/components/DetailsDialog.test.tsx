import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JobActivityEntry } from '../../../shared/ipc';
import { formatTimeOfDay } from '../lib/format';
import { makeJob } from '../testing/fakeApi';
import { ToastProvider } from '../state/Toasts';
import { DetailsDialog, detailsText } from './DetailsDialog';

const ADDED: JobActivityEntry = {
    at: '2026-01-01T10:00:00.000Z',
    level: 'info',
    text: 'Added to the queue',
};
const STARTED: JobActivityEntry = {
    at: '2026-01-01T10:00:05.000Z',
    level: 'info',
    text: 'Start transcoding…',
};
const FAILED: JobActivityEntry = {
    at: '2026-01-01T10:01:00.000Z',
    level: 'error',
    text: 'Failed: ffmpeg failed',
};
const ACTIVITY: JobActivityEntry[] = [ADDED, STARTED, FAILED];

function show(
    job = makeJob({ state: 'failed', errorMessage: 'ffmpeg failed', activity: ACTIVITY }),
) {
    return render(
        <ToastProvider>
            <DetailsDialog job={job} onClose={vi.fn()} />
        </ToastProvider>,
    );
}

describe('DetailsDialog activity', () => {
    it('lists the activity in order with an absolute time and a datetime attribute', () => {
        show();

        const log = screen.getByRole('list', { name: 'Activity' });
        const items = within(log).getAllByRole('listitem');

        expect(screen.getByRole('heading', { name: 'Activity' })).toHaveClass('subheading');
        expect(log).toHaveAttribute('tabindex', '0');
        expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual([
            'Added to the queue',
            'Start transcoding…',
            'Failed: ffmpeg failed',
        ]);

        const time = items[0]?.querySelector('time');

        expect(time).toHaveAttribute('datetime', ADDED.at);
        expect(time).toHaveTextContent(formatTimeOfDay(ADDED.at));
        expect(time).toHaveAttribute('title');
    });

    it('styles error lines as errors and leaves info lines alone', () => {
        show();

        const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole(
            'listitem',
        );

        expect(items[2]).toHaveClass('activity-error');
        expect(items[0]).not.toHaveClass('activity-error');
    });

    it('says so when nothing was recorded', () => {
        show(makeJob({ state: 'failed', activity: [] }));

        expect(screen.getByText('No activity was recorded.')).toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Activity' })).not.toBeInTheDocument();
    });

    it('shows new lines when an updated job arrives', () => {
        const job = makeJob({ state: 'transcoding', activity: [ADDED, STARTED] });
        const view = show(job);

        expect(screen.getAllByRole('listitem')).toHaveLength(2);

        view.rerender(
            <ToastProvider>
                <DetailsDialog
                    job={{ ...job, activity: [ADDED, STARTED, FAILED] }}
                    onClose={vi.fn()}
                />
            </ToastProvider>,
        );

        expect(screen.getAllByRole('listitem')).toHaveLength(3);
        expect(screen.getByText('Failed: ffmpeg failed')).toBeInTheDocument();
    });

    it('adds an Activity section to the copied text', () => {
        const text = detailsText(makeJob({ state: 'failed', activity: ACTIVITY }));

        expect(text).toContain('\nActivity:\n');
        expect(text).toContain(`${formatTimeOfDay(FAILED.at)} Failed: ffmpeg failed`);
        expect(detailsText(makeJob({ activity: [] }))).toContain('No activity was recorded.');
    });
});
