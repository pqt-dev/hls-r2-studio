import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { R2Status } from '../../../shared/ipc';
import { makeSummary } from '../testing/fakeApi';
import { push, renderApp } from '../testing/renderApp';

const SAVED: R2Status = {
    configured: true,
    source: 'database',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'media',
    url: 'https://cdn.example.com',
    accessKeyLast4: 'wxyz',
    hasSecret: true,
};

const UNCONFIGURED: R2Status = {
    configured: false,
    source: 'none',
    endpoint: null,
    bucket: null,
    url: null,
    accessKeyLast4: null,
    hasSecret: false,
};

async function openSettings(initial: Parameters<typeof renderApp>[0] = {}) {
    const rendered = await renderApp(initial);

    await rendered.user.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Endpoint');

    return rendered;
}

describe('R2 storage card', () => {
    it('loads the saved values and shows the key and secret masked and read-only', async () => {
        await openSettings();

        expect(screen.getByRole('heading', { name: 'R2 storage' })).toBeInTheDocument();
        expect(screen.getByText('Configured')).toBeInTheDocument();
        expect(screen.getByLabelText('Endpoint')).toHaveValue(
            'https://acct.r2.cloudflarestorage.com',
        );
        expect(screen.getByLabelText('Bucket')).toHaveValue('media');
        expect(screen.getByLabelText('Public URL')).toHaveValue('https://cdn.example.com');

        const key = screen.getByLabelText('Access Key ID');
        const secret = screen.getByLabelText('Secret Access Key');

        expect(key).toHaveValue('••••••••••••wxyz');
        expect(key).toHaveAttribute('readonly');
        expect(key).not.toHaveAttribute('placeholder');
        expect(secret).toHaveValue('••••••••••••••••');
        expect(secret).toHaveAttribute('readonly');
        expect(screen.getByRole('button', { name: 'Change Access Key ID' })).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'Change Secret Access Key' }),
        ).toBeInTheDocument();
        expect(screen.getByText('Test connection checks the saved settings.')).toBeInTheDocument();
        expect(screen.queryByText(/leave blank/i)).not.toBeInTheDocument();
    });

    it('swaps a masked field for an empty input on Change and restores it on Cancel', async () => {
        const { user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Change Secret Access Key' }));

        const secret = screen.getByLabelText('Secret Access Key');

        expect(secret).toHaveValue('');
        expect(secret).not.toHaveAttribute('readonly');
        expect(secret).toHaveAttribute('type', 'password');
        expect(secret).toHaveAttribute('autocomplete', 'off');

        await user.type(secret, 'typed-secret');
        await user.click(screen.getByRole('button', { name: 'Cancel changing Secret Access Key' }));

        expect(screen.getByLabelText('Secret Access Key')).toHaveValue('••••••••••••••••');
        expect(screen.getByLabelText('Secret Access Key')).toHaveAttribute('readonly');

        await user.click(screen.getByRole('button', { name: 'Change Secret Access Key' }));
        expect(screen.getByLabelText('Secret Access Key')).toHaveValue('');

        await user.click(screen.getByRole('button', { name: 'Change Access Key ID' }));
        expect(screen.getByLabelText('Access Key ID')).toHaveValue('');
        await user.click(screen.getByRole('button', { name: 'Cancel changing Access Key ID' }));
        expect(screen.getByLabelText('Access Key ID')).toHaveValue('••••••••••••wxyz');
    });

    it('shows Not configured with editable required key and secret fields', async () => {
        await openSettings({ r2: UNCONFIGURED });

        expect(screen.getByText('Not configured')).toBeInTheDocument();
        expect(screen.getByLabelText('Endpoint')).toHaveValue('');

        const key = screen.getByLabelText('Access Key ID');
        const secret = screen.getByLabelText('Secret Access Key');

        expect(key).toHaveValue('');
        expect(key).not.toHaveAttribute('readonly');
        expect(key).toBeRequired();
        expect(secret).toHaveValue('');
        expect(secret).toHaveAttribute('type', 'password');
        expect(secret).toBeRequired();
        expect(screen.queryByRole('button', { name: /^Change / })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Cancel changing/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    });

    it('shows an error with Retry when the status cannot be loaded', async () => {
        const { fake, user } = await renderApp();
        const get = vi.spyOn(fake.api.r2, 'get').mockResolvedValueOnce({
            ok: false,
            error: 'Could not load the R2 settings (HTTP 500).',
        });

        await user.click(screen.getByRole('tab', { name: 'Settings' }));
        expect(
            await screen.findByText('Could not load the R2 settings (HTTP 500).'),
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByLabelText('Endpoint')).toHaveValue(
            'https://acct.r2.cloudflarestorage.com',
        );
        expect(get).toHaveBeenCalledTimes(2);
    });

    it('omits the masked key and secret from the save request', async () => {
        const { fake, user } = await openSettings();
        const save = vi.spyOn(fake.api.r2, 'save');

        await user.clear(screen.getByLabelText('Bucket'));
        await user.type(screen.getByLabelText('Bucket'), '  new-bucket ');
        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));

        expect(save).toHaveBeenCalledWith({
            endpoint: 'https://acct.r2.cloudflarestorage.com',
            bucket: 'new-bucket',
            url: 'https://cdn.example.com',
        });
        expect(await screen.findByText('R2 settings saved.')).toBeInTheDocument();
        expect(screen.getByLabelText('Bucket')).toHaveValue('new-bucket');
    });

    it('sends a typed key and secret once, then clears them and never shows them', async () => {
        const { fake, user } = await openSettings();
        const save = vi.spyOn(fake.api.r2, 'save');

        await user.click(screen.getByRole('button', { name: 'Change Access Key ID' }));
        await user.click(screen.getByRole('button', { name: 'Change Secret Access Key' }));
        await user.type(screen.getByLabelText('Access Key ID'), 'AKIANEWKEY1234');
        await user.type(screen.getByLabelText('Secret Access Key'), 'super-secret-value');
        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));

        expect(save).toHaveBeenCalledWith({
            endpoint: 'https://acct.r2.cloudflarestorage.com',
            bucket: 'media',
            url: 'https://cdn.example.com',
            accessKeyId: 'AKIANEWKEY1234',
            secretAccessKey: 'super-secret-value',
        });
        expect(await screen.findByText('R2 settings saved.')).toBeInTheDocument();
        expect(screen.getByLabelText('Access Key ID')).toHaveValue('••••••••••••1234');
        expect(screen.getByLabelText('Access Key ID')).toHaveAttribute('readonly');
        expect(screen.getByLabelText('Secret Access Key')).toHaveValue('••••••••••••••••');
        expect(screen.getByLabelText('Secret Access Key')).toHaveAttribute('readonly');

        const page = document.body.innerHTML;

        expect(page).not.toContain('super-secret-value');
        expect(page).not.toContain('AKIANEWKEY1234');
    });

    it('shows validation errors next to their fields and keeps the typed secret out of the page', async () => {
        const { fake, user } = await openSettings();

        vi.spyOn(fake.api.r2, 'save').mockResolvedValueOnce({
            ok: false,
            error: 'Please fix the highlighted fields.',
            fieldErrors: {
                endpoint: 'Endpoint must start with https://.',
                secretAccessKey: 'The secret access key is invalid.',
            },
        });

        await user.click(screen.getByRole('button', { name: 'Change Secret Access Key' }));
        await user.type(screen.getByLabelText('Secret Access Key'), 'typed-secret');
        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));

        expect(await screen.findByText('Endpoint must start with https://.')).toBeInTheDocument();
        expect(screen.getByText('The secret access key is invalid.')).toBeInTheDocument();
        expect(screen.getByText('Please fix the highlighted fields.')).toBeInTheDocument();
        expect(screen.getByLabelText('Endpoint')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('Bucket')).toHaveAttribute('aria-invalid', 'false');
        expect(document.body.textContent).not.toContain('typed-secret');
    });

    it('clears a field error when that field is edited', async () => {
        const { fake, user } = await openSettings();

        vi.spyOn(fake.api.r2, 'save').mockResolvedValueOnce({
            ok: false,
            error: 'Please fix the highlighted fields.',
            fieldErrors: { bucket: 'Enter the bucket name.' },
        });

        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));
        expect(await screen.findByText('Enter the bucket name.')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Bucket'), 'x');
        expect(screen.queryByText('Enter the bucket name.')).not.toBeInTheDocument();
    });

    it('shows a save failure that has no field', async () => {
        const { fake, user } = await openSettings();

        vi.spyOn(fake.api.r2, 'save').mockRejectedValueOnce(new Error('boom'));

        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));

        expect(await screen.findByText('Could not save the R2 settings.')).toBeInTheDocument();
    });

    it('tests the saved connection and reports success', async () => {
        const { fake, user } = await openSettings();
        const test = vi.spyOn(fake.api.r2, 'test');

        await user.click(screen.getByRole('button', { name: 'Test connection' }));

        expect(test).toHaveBeenCalledTimes(1);
        expect(await screen.findByText('R2 connection OK.')).toBeInTheDocument();
    });

    it('reports the failure text of a connection test', async () => {
        const { fake, user } = await openSettings();

        vi.spyOn(fake.api.r2, 'test').mockResolvedValueOnce({ ok: false, error: 'Access Denied' });

        await user.click(screen.getByRole('button', { name: 'Test connection' }));

        expect(await screen.findByText(/Access Denied/)).toBeInTheDocument();
    });

    it('shows a busy label and disables both buttons while testing', async () => {
        const { fake, user } = await openSettings();
        let finish: (value: { ok: true }) => void = () => undefined;

        vi.spyOn(fake.api.r2, 'test').mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );

        await user.click(screen.getByRole('button', { name: 'Test connection' }));

        expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Save R2 settings' })).toBeDisabled();

        finish({ ok: true });

        expect(await screen.findByText('R2 connection OK.')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled(),
        );
    });

    it('disables the test while the form has unsaved changes and says why', async () => {
        const { user } = await openSettings();

        expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();

        await user.type(screen.getByLabelText('Bucket'), '2');

        expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
        expect(
            screen.getByText(/the test uses the saved settings, not the values/i),
        ).toBeInTheDocument();
    });

    it('treats a typed secret as an unsaved change', async () => {
        const { user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Change Secret Access Key' }));
        await user.type(screen.getByLabelText('Secret Access Key'), 'abc');

        expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    });

    it('disables saving while videos are being processed, and explains why', async () => {
        const { fake, user } = await openSettings();
        const save = vi.spyOn(fake.api.r2, 'save');

        push(() => fake.emitSummary(makeSummary({ running: 1 })));

        expect(screen.getByRole('button', { name: 'Save R2 settings' })).toBeDisabled();
        expect(
            screen.getByText('The settings cannot be saved while videos are being processed.'),
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save R2 settings' }));
        expect(save).not.toHaveBeenCalled();
    });
});
