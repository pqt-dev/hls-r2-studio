import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeJob, makeSummary } from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';

async function openTab(user: Awaited<ReturnType<typeof renderApp>>['user'], name: string) {
    await user.click(screen.getByRole('tab', { name }));
}

describe('Tabs', () => {
    it('switches panels and supports arrow-key navigation', async () => {
        const { user } = await renderApp();

        // Home is the first and default tab; Settings is the fourth.
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');

        screen.getByRole('tab', { name: 'Home' }).focus();
        await user.keyboard('{ArrowRight}{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Settings');

        await user.keyboard('{End}');
        expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    });
});

describe('Settings screen', () => {
    it('shows the current values', async () => {
        const { user } = await renderApp();

        await openTab(user, 'Settings');

        expect(screen.queryByLabelText('Embed site URL')).not.toBeInTheDocument();
        // Sign out lives in the sidebar footer, not on the Settings page.
        expect(
            within(screen.getByRole('tabpanel')).queryByRole('button', { name: 'Sign out' }),
        ).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Refresh site settings' })).toBeNull();
        expect(screen.getByLabelText('Working folder')).toHaveValue('C:\\Temp\\hls-r2-studio');
        expect(screen.getByLabelText('Working folder')).toHaveAttribute('readonly');
        expect(screen.getByLabelText('Videos processed at once')).toHaveValue('1');
        expect(screen.getByText(/uses more CPU, memory and disk/)).toBeInTheDocument();
    });

    it('disables the folder while jobs run, and explains why', async () => {
        const { fake, user } = await renderApp();

        await openTab(user, 'Settings');
        push(() => fake.emitSummary(makeSummary({ running: 1 })));

        expect(screen.getByRole('button', { name: /Choose folder/ })).toBeDisabled();
        expect(
            screen.getByText('The folder cannot be changed while videos are being processed.'),
        ).toBeInTheDocument();
    });

    it('picks a folder through the native dialog and saves it', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        fake.state.nextDirectory = 'D:\\video-temp';
        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: /Choose folder/ }));

        expect(set).toHaveBeenCalledWith({ tmpRoot: 'D:\\video-temp' });
        expect(await screen.findByText('Working folder saved.')).toBeInTheDocument();
        expect(screen.getByLabelText('Working folder')).toHaveValue('D:\\video-temp');
    });

    it('does nothing when the folder dialog is cancelled', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: /Choose folder/ }));
        expect(set).not.toHaveBeenCalled();
    });

    it('shows the error when saving the folder fails', async () => {
        const { fake, user } = await renderApp();

        fake.state.nextDirectory = 'D:\\locked';
        vi.spyOn(fake.api.settings, 'set').mockResolvedValue({
            ok: false,
            error: 'The temporary folder cannot be created or is not writable.',
        });
        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: /Choose folder/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('not writable');
        expect(screen.getByLabelText('Working folder')).toHaveValue('C:\\Temp\\hls-r2-studio');
    });

    it('saves the videos processed at once setting on change', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        await openTab(user, 'Settings');
        await user.selectOptions(screen.getByLabelText('Videos processed at once'), '2');

        expect(set).toHaveBeenCalledWith({ maxConcurrent: 2 });
        expect(await screen.findByText('Setting saved.')).toBeInTheDocument();
        // It is a toast, not inline text next to the field.
        expect(
            screen.getByLabelText('Videos processed at once').closest('.field'),
        ).not.toHaveTextContent('Setting saved.');
        expect(screen.getByLabelText('Videos processed at once')).toHaveValue('2');
    });

    it('shows a toast when saving the videos processed at once setting fails', async () => {
        const { fake, user } = await renderApp();

        vi.spyOn(fake.api.settings, 'set').mockResolvedValue({ ok: false, error: 'Nope.' });
        await openTab(user, 'Settings');
        await user.selectOptions(screen.getByLabelText('Videos processed at once'), '2');

        expect(await screen.findByText(/Nope\./)).toBeInTheDocument();
        expect(screen.getByLabelText('Videos processed at once')).toHaveValue('1');
    });
});

describe('About screen', () => {
    it('shows version, platform and a passed self-check', async () => {
        const { user } = await renderApp();

        await openTab(user, 'About');

        expect(screen.getByText('1.2.3')).toBeInTheDocument();
        expect(screen.getByText('win32 x64')).toBeInTheDocument();
        expect(screen.getByText('9.0.2')).toBeInTheDocument();
        expect(screen.getByText('Passed')).toBeInTheDocument();
    });

    it('lists the missing features when the self-check failed', async () => {
        const { user } = await renderApp({
            diagnostics: {
                appVersion: '1.2.3',
                platform: 'win32 x64',
                ffmpeg: {
                    checked: true,
                    ok: false,
                    version: null,
                    missing: ['libx264', 'ffprobe'],
                },
            },
        });

        await openTab(user, 'About');

        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('libx264')).toBeInTheDocument();
        expect(screen.getByText('ffprobe')).toBeInTheDocument();
    });

    it('shows the GPL notice and opens the logs folder and licenses', async () => {
        const { fake, user } = await renderApp();
        const logs = vi.spyOn(fake.api.app, 'openLogsFolder');
        const notices = vi.spyOn(fake.api.app, 'openNotices');

        await openTab(user, 'About');

        expect(screen.getByText(/GNU General\s+Public License/)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open logs folder' }));
        await user.click(screen.getByRole('button', { name: 'Open licenses' }));

        expect(logs).toHaveBeenCalled();
        expect(notices).toHaveBeenCalled();
    });

    it('shows the error when the notices file is missing', async () => {
        const { fake, user } = await renderApp();

        vi.spyOn(fake.api.app, 'openNotices').mockResolvedValue({
            ok: false,
            error: 'Notices file not found.',
        });
        await openTab(user, 'About');
        await user.click(screen.getByRole('button', { name: 'Open licenses' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Notices file not found.');
    });
});

describe('Load failure', () => {
    it('offers a retry when the initial load fails', async () => {
        const { createFakeApi } = await import('../testing/fakeApi');
        const { render } = await import('@testing-library/react');
        const { App } = await import('../App');
        const userEvent = (await import('@testing-library/user-event')).default;
        const fake = createFakeApi();
        const getState = vi
            .spyOn(fake.api.auth, 'getState')
            .mockRejectedValueOnce(new Error('ipc down'));

        render(<App api={fake.api} />);

        expect(await screen.findByText('Could not load the app state.')).toBeInTheDocument();

        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('tablist')).toBeInTheDocument();
        expect(getState).toHaveBeenCalledTimes(2);
    });
});
