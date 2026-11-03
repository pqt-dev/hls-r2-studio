import { useState } from 'react';
import { plural } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { Banner } from './Banner';

export function ReloadConfigButton({ label = 'Reload config' }: { label?: string }) {
    const { api } = useApp();
    const toast = useToast();
    const [busy, setBusy] = useState(false);

    async function reload(): Promise<void> {
        setBusy(true);

        try {
            const state = await api.auth.reloadConfig();

            if (state.status === 'offline' || state.error !== undefined) {
                toast.show('error', state.error ?? 'Cannot reach the site.');
            } else {
                toast.show('success', 'Configuration reloaded.');
            }
        } catch {
            toast.show('error', 'Could not reload the configuration.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reload()}>
            {busy ? 'Reloading…' : label}
        </button>
    );
}

export function QueueBanners() {
    const { auth, jobs, diagnostics } = useApp();
    const needSignIn = jobs.filter((job) => job.state === 'needs_sign_in').length;
    const ffmpeg = diagnostics?.ffmpeg;

    return (
        <div className="banners">
            {ffmpeg?.checked === true && !ffmpeg.ok && (
                <Banner tone="danger" title="Video tools are not working.">
                    Videos cannot be processed until this is fixed.
                    {ffmpeg.missing.length > 0 && (
                        <>
                            {' '}
                            Missing features:
                            <ul className="banner-list">
                                {ffmpeg.missing.map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ul>
                        </>
                    )}{' '}
                    Reinstall the app or see About for details.
                </Banner>
            )}
            {auth.status === 'offline' && (
                <Banner
                    tone="warning"
                    title="Cannot reach the site."
                    action={<ReloadConfigButton />}
                >
                    Videos wait in the queue until the connection is back.
                </Banner>
            )}
            {auth.status === 'signed_in' && auth.r2Configured === false && (
                <Banner tone="warning" title="R2 storage is not set up on the site.">
                    Ask an admin to set up R2 in the site dashboard (Settings -&gt; Storage).
                </Banner>
            )}
            {needSignIn > 0 && (
                <Banner
                    tone="warning"
                    title={`Sign in again to finish ${plural(needSignIn, 'video')}.`}
                >
                    These videos are already uploaded and will be registered after you sign in.
                </Banner>
            )}
        </div>
    );
}
