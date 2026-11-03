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

        expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');

        screen.getByRole('tab', { name: 'Queue' }).focus();
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
        expect(screen.getByRole('tab', { name: 'Queue' })).toHaveAttribute('aria-selected', 'true');
    });
});

describe('Settings screen', () => {
    it('shows the current values', async () => {
        const { user } = await renderApp();

        await openTab(user, 'Settings');

        expect(screen.getByLabelText('Site URL')).toHaveValue('https://site.example.com');
        expect(screen.getByLabelText('Temporary folder')).toHaveValue('C:\\Temp\\hls-r2-studio');
        expect(screen.getByLabelText('Temporary folder')).toHaveAttribute('readonly');
        expect(screen.getByLabelText('Parallel jobs')).toHaveValue('1');
        expect(screen.getByText(/much more CPU/)).toBeInTheDocument();
    });

    it('disables the site URL and folder while jobs run, and explains why', async () => {
        const { fake, user } = await renderApp();

        await openTab(user, 'Settings');
        push(() => fake.emitSummary(makeSummary({ running: 1 })));

        expect(screen.getByLabelText('Site URL')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Change site' })).toBeDisabled();
        expect(screen.getByRole('button', { name: /Choose folder/ })).toBeDisabled();
        expect(
            screen.getByText('The site cannot be changed while videos are being processed.'),
        ).toBeInTheDocument();
    });

    it('picks a folder through the native dialog and saves it', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        fake.state.nextDirectory = 'D:\\video-temp';
        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: /Choose folder/ }));

        expect(set).toHaveBeenCalledWith({ tmpRoot: 'D:\\video-temp' });
        expect(await screen.findByText('Temporary folder saved.')).toBeInTheDocument();
        expect(screen.getByLabelText('Temporary folder')).toHaveValue('D:\\video-temp');
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
        expect(screen.getByLabelText('Temporary folder')).toHaveValue('C:\\Temp\\hls-r2-studio');
    });

    it('saves the parallel jobs setting on change', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        await openTab(user, 'Settings');
        await user.selectOptions(screen.getByLabelText('Parallel jobs'), '2');

        expect(set).toHaveBeenCalledWith({ maxConcurrent: 2 });
        expect(await screen.findByText('Parallel jobs saved.')).toBeInTheDocument();
        expect(screen.getByLabelText('Parallel jobs')).toHaveValue('2');
    });

    it('warns before switching to another host and signs out through the main process', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        await openTab(user, 'Settings');
        await user.clear(screen.getByLabelText('Site URL'));
        await user.type(screen.getByLabelText('Site URL'), 'https://other.example.org');
        await user.click(screen.getByRole('button', { name: 'Change site' }));

        const dialog = screen.getByRole('alertdialog', { name: 'Change the site?' });

        expect(dialog).toHaveTextContent('signs you out');
        expect(set).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Change site and sign out' }));
        expect(set).toHaveBeenCalledWith({ siteUrl: 'https://other.example.org' });
    });

    it('saves a same-host URL change without a warning', async () => {
        const { fake, user } = await renderApp();
        const set = vi.spyOn(fake.api.settings, 'set');

        await openTab(user, 'Settings');
        await user.clear(screen.getByLabelText('Site URL'));
        await user.type(screen.getByLabelText('Site URL'), 'https://site.example.com/');
        await user.click(screen.getByRole('button', { name: 'Change site' }));

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(set).toHaveBeenCalledWith({ siteUrl: 'https://site.example.com/' });
    });

    it('signs out immediately when no job is running', async () => {
        const { fake, user } = await renderApp();
        const logout = vi.spyOn(fake.api.auth, 'logout');

        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        expect(logout).toHaveBeenCalled();
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    });

    it('asks for confirmation before signing out while jobs run', async () => {
        const { fake, user } = await renderApp({
            jobs: [makeJob({ state: 'uploading', canCancel: true })],
        });
        const logout = vi.spyOn(fake.api.auth, 'logout');

        push(() => fake.emitSummary(makeSummary({ running: 1 })));
        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        const dialog = screen.getByRole('alertdialog', { name: 'Sign out now?' });

        expect(dialog).toHaveTextContent('1 video is still being processed');
        expect(logout).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
        expect(logout).toHaveBeenCalled();
    });

    it('reloads the configuration', async () => {
        const { fake, user } = await renderApp();
        const reload = vi.spyOn(fake.api.auth, 'reloadConfig');

        await openTab(user, 'Settings');
        await user.click(screen.getByRole('button', { name: 'Reload config' }));

        expect(reload).toHaveBeenCalled();
        expect(await screen.findByText('Configuration reloaded.')).toBeInTheDocument();
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
