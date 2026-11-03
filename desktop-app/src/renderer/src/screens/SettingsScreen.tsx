import { useId, useState } from 'react';
import type { SettingsPatch } from '../../../shared/ipc';
import { ConfirmDialog } from '../components/Dialog';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { ReloadConfigButton } from '../components/QueueBanners';
import { plural, siteHost } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';

type Section = 'site' | 'tmp' | 'parallel';
type Confirm = 'site' | 'signout' | null;

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

    const [urlDraft, setUrlDraft] = useState(settings?.siteUrl ?? '');
    const [feedback, setFeedback] = useState<Record<Section, FeedbackMessage | null>>({
        site: null,
        tmp: null,
        parallel: null,
    });
    const [saving, setSaving] = useState<Section | null>(null);
    const [confirm, setConfirm] = useState<Confirm>(null);
    const [signingOut, setSigningOut] = useState(false);

    if (settings === null) return <p className="muted">Settings are not available.</p>;

    const busyJobs = summary.running > 0;
    const siteChanged = urlDraft.trim() !== '' && urlDraft.trim() !== settings.siteUrl;

    async function save(section: Section, patch: SettingsPatch, success: string): Promise<void> {
        setSaving(section);
        setFeedback((all) => ({ ...all, [section]: null }));

        try {
            const result = await api.settings.set(patch);

            if (result.ok) {
                applySettings(result.settings);
                setUrlDraft(result.settings.siteUrl);
                setFeedback((all) => ({ ...all, [section]: { kind: 'success', text: success } }));
            } else {
                setFeedback((all) => ({
                    ...all,
                    [section]: { kind: 'error', text: result.error },
                }));
            }
        } catch {
            setFeedback((all) => ({
                ...all,
                [section]: { kind: 'error', text: 'Could not save the setting.' },
            }));
        } finally {
            setSaving(null);
        }
    }

    function changeSite(): void {
        const next = urlDraft.trim();

        // A different host invalidates the session: warn before it happens.
        if (siteHost(next) !== siteHost(settings?.siteUrl)) setConfirm('site');
        else void save('site', { siteUrl: next }, 'Site URL saved.');
    }

    async function chooseFolder(): Promise<void> {
        setFeedback((all) => ({ ...all, tmp: null }));

        try {
            const picked = await api.settings.pickDirectory();

            if (picked.canceled) return;

            await save('tmp', { tmpRoot: picked.path }, 'Temporary folder saved.');
        } catch {
            setFeedback((all) => ({
                ...all,
                tmp: { kind: 'error', text: 'Could not open the folder dialog.' },
            }));
        }
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
            <section className="card" aria-labelledby={`${ids.url}-h`}>
                <h2 id={`${ids.url}-h`}>Site</h2>
                <div className="field">
                    <label htmlFor={ids.url}>Site URL</label>
                    <div className="row">
                        <input
                            id={ids.url}
                            type="url"
                            autoComplete="off"
                            spellCheck={false}
                            value={urlDraft}
                            disabled={busyJobs || saving === 'site'}
                            aria-describedby={ids.urlHelp}
                            onChange={(event) => setUrlDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && siteChanged && !busyJobs) {
                                    event.preventDefault();
                                    changeSite();
                                }
                            }}
                        />
                        <button
                            type="button"
                            className="btn"
                            disabled={!siteChanged || busyJobs || saving === 'site'}
                            onClick={changeSite}
                        >
                            Change site
                        </button>
                    </div>
                    <p id={ids.urlHelp} className="help">
                        {busyJobs
                            ? 'The site cannot be changed while videos are being processed.'
                            : 'Changing to a different site signs you out.'}
                    </p>
                    <Feedback message={feedback.site} />
                </div>
            </section>

            <section className="card" aria-labelledby={`${ids.tmp}-h`}>
                <h2 id={`${ids.tmp}-h`}>Processing</h2>
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
                            className="btn"
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
                    <Feedback message={feedback.tmp} />
                </div>

                <div className="field">
                    <label htmlFor={ids.parallel}>Parallel jobs</label>
                    <select
                        id={ids.parallel}
                        value={settings.maxConcurrent}
                        disabled={saving === 'parallel'}
                        aria-describedby={ids.parallelHelp}
                        onChange={(event) =>
                            void save(
                                'parallel',
                                { maxConcurrent: Number(event.target.value) },
                                'Parallel jobs saved.',
                            )
                        }
                    >
                        <option value={1}>1 (recommended)</option>
                        <option value={2}>2</option>
                    </select>
                    <p id={ids.parallelHelp} className="help">
                        Two jobs at once can finish a batch sooner but use much more CPU and disk,
                        so the computer may feel slower.
                    </p>
                    <Feedback message={feedback.parallel} />
                </div>
            </section>

            <section className="card" aria-labelledby="account-heading">
                <h2 id="account-heading">Account</h2>
                <p className="muted">
                    {auth.username !== undefined
                        ? `Signed in as ${auth.username} on ${siteHost(auth.siteUrl ?? settings.siteUrl)}.`
                        : 'Signed in.'}
                </p>
                <div className="row row-wrap">
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
            </section>

            {confirm === 'site' && (
                <ConfirmDialog
                    title="Change the site?"
                    message="Changing to a different site signs you out. You will need to sign in again on the new site."
                    confirmLabel="Change site and sign out"
                    cancelLabel="Keep current site"
                    danger
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        setConfirm(null);
                        void save('site', { siteUrl: urlDraft.trim() }, 'Site URL saved.');
                    }}
                />
            )}
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
