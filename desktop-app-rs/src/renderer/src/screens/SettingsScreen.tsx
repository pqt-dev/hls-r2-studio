import { useId, useState } from 'react';
import type { SettingsPatch } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { ReloadConfigButton } from '../components/QueueBanners';
import { SectionCard } from '../components/SectionCard';
import { CopyIcon } from '../components/icons';
import { SelectBox } from '../components/SelectBox';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { R2SettingsCard } from './R2SettingsCard';
import { useToast } from '../state/Toasts';

type Confirm = 'signout' | null;

export function SettingsScreen() {
    const { api, auth, settings, summary, applySettings } = useApp();
    const toast = useToast();
    const ids = {
        url: useId(),
        urlHelp: useId(),
        tmp: useId(),
        tmpHelp: useId(),
        parallel: useId(),
        parallelHelp: useId(),
    };

    const [tmpFeedback, setTmpFeedback] = useState<FeedbackMessage | null>(null);
    const [saving, setSaving] = useState<'tmp' | 'parallel' | null>(null);
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [signingOut, setSigningOut] = useState(false);

    if (settings === null) return <p className="muted">Settings are not available.</p>;

    const busyJobs = summary.running > 0;

    /** Saves a patch. Returns the failure text, or null on success. */
    async function save(section: 'tmp' | 'parallel', patch: SettingsPatch): Promise<string | null> {
        setSaving(section);

        try {
            const result = await api.settings.set(patch);

            if (result.ok) {
                applySettings(result.settings);

                return null;
            }

            return result.error;
        } catch {
            return 'Could not save the setting.';
        } finally {
            setSaving(null);
        }
    }

    async function saveTmpRoot(path: string): Promise<void> {
        const error = await save('tmp', { tmpRoot: path });

        setTmpFeedback(
            error === null
                ? { kind: 'success', text: 'Temporary folder saved.' }
                : { kind: 'error', text: error },
        );
    }

    async function saveParallel(value: number): Promise<void> {
        const error = await save('parallel', { maxConcurrent: value });

        if (error === null) toast.show('success', 'Parallel jobs saved.');
        else toast.show('error', error);
    }

    async function chooseFolder(): Promise<void> {
        setTmpFeedback(null);

        try {
            const picked = await api.settings.pickDirectory();

            if (picked.canceled) return;

            await saveTmpRoot(picked.path);
        } catch {
            setTmpFeedback({ kind: 'error', text: 'Could not open the folder dialog.' });
        }
    }

    async function copySiteUrl(url: string): Promise<void> {
        const ok = await copyText(url);

        if (ok) toast.show('success', 'Link copied.');
        else toast.show('error', 'Could not copy the link.');
    }

    async function signOut(): Promise<void> {
        setSigningOut(true);

        try {
            await api.auth.logout();
        } catch {
            toast.show('error', 'Could not sign out. Please try again.');
        } finally {
            setSigningOut(false);
        }
    }

    return (
        <div className="settings">
            <SectionCard title="Account" level={3}>
                <div className="field">
                    <label htmlFor={ids.url}>Embed site URL</label>
                    <div className="row">
                        <input
                            id={ids.url}
                            type="text"
                            readOnly
                            value={settings.siteUrl}
                            aria-describedby={ids.urlHelp}
                        />
                        <button
                            type="button"
                            className="btn btn-sm embed-copy"
                            aria-label="Copy site URL"
                            title="Copy site URL"
                            onClick={() => void copySiteUrl(settings.siteUrl)}
                        >
                            <CopyIcon />
                        </button>
                    </div>
                    <p id={ids.urlHelp} className="help">
                        Embed links and players are served from this site. It is fixed when the app
                        is built.
                    </p>
                </div>
                <div className="row row-wrap">
                    <span className="muted">
                        {auth.username !== undefined ? `Signed in as ${auth.username}` : 'Signed in'}
                    </span>
                    <ReloadConfigButton />
                    <button
                        type="button"
                        className="btn btn-danger-quiet"
                        disabled={signingOut}
                        onClick={() => {
                            if (summary.running > 0) setConfirm('signout');
                            else void signOut();
                        }}
                    >
                        Sign out
                    </button>
                </div>
                <p className="muted">
                    Fetch the latest settings from the site, for example after an admin changes
                    storage.
                </p>
            </SectionCard>

            <SectionCard title="Processing" level={3}>
                <div className="field">
                    <label htmlFor={ids.tmp}>Temporary folder</label>
                    <div className="row">
                        <input
                            id={ids.tmp}
                            type="text"
                            readOnly
                            value={settings.tmpRoot}
                            aria-describedby={ids.tmpHelp}
                        />
                        <button
                            type="button"
                            className="btn btn-accent-edit"
                            disabled={busyJobs || saving === 'tmp'}
                            onClick={() => void chooseFolder()}
                        >
                            {'Choose folder…'}
                        </button>
                    </div>
                    <p id={ids.tmpHelp} className="help">
                        {busyJobs
                            ? 'The folder cannot be changed while videos are being processed.'
                            : 'Videos are converted here before upload. Pick a drive with plenty of free space.'}
                    </p>
                    <Feedback message={tmpFeedback} />
                </div>

                <div className="field">
                    <label htmlFor={ids.parallel}>Parallel jobs</label>
                    <SelectBox
                        id={ids.parallel}
                        value={settings.maxConcurrent}
                        disabled={saving === 'parallel'}
                        aria-describedby={ids.parallelHelp}
                        onChange={(event) => void saveParallel(Number(event.target.value))}
                    >
                        <option value={1}>1 (recommended)</option>
                        <option value={2}>2</option>
                    </SelectBox>
                    <p id={ids.parallelHelp} className="help">
                        Two jobs finish a batch sooner but use much more CPU and disk.
                    </p>
                </div>
            </SectionCard>

            <R2SettingsCard />

            {confirm === 'signout' && (
                <ConfirmDialog
                    title="Sign out now?"
                    message={`${plural(summary.running, 'video is', 'videos are')} still being processed. They may need you to sign in again before they can finish.`}
                    confirmLabel="Sign out"
                    cancelLabel="Stay signed in"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        setConfirm(null);
                        void signOut();
                    }}
                />
            )}
        </div>
    );
}
