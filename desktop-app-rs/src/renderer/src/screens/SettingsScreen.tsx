import { useId, useState } from 'react';
import type { SettingsPatch } from '../../../shared/ipc';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { SectionCard } from '../components/SectionCard';
import { SelectBox } from '../components/SelectBox';
import { useApp } from '../state/AppProvider';
import { R2SettingsCard } from './R2SettingsCard';
import { useToast } from '../state/Toasts';

export function SettingsScreen() {
    const { api, settings, summary, applySettings } = useApp();
    const toast = useToast();
    const ids = {
        tmp: useId(),
        tmpHelp: useId(),
        parallel: useId(),
        parallelHelp: useId(),
    };

    const [tmpFeedback, setTmpFeedback] = useState<FeedbackMessage | null>(null);
    const [saving, setSaving] = useState<'tmp' | 'parallel' | null>(null);

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
                ? { kind: 'success', text: 'Working folder saved.' }
                : { kind: 'error', text: error },
        );
    }

    async function saveParallel(value: number): Promise<void> {
        const error = await save('parallel', { maxConcurrent: value });

        if (error === null) toast.show('success', 'Setting saved.');
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

    return (
        <div className="settings">
            <div className="settings-columns">
                <SectionCard title="Video processing" level={3}>
                    <div className="form-grid">
                        <div className="field field-span">
                            <label htmlFor={ids.tmp}>Working folder</label>
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
                                    : 'Videos are converted here before upload. Choose a drive with plenty of free space.'}
                            </p>
                            <Feedback message={tmpFeedback} />
                        </div>

                        <div className="field">
                            <label htmlFor={ids.parallel}>Videos processed at once</label>
                            <SelectBox
                                id={ids.parallel}
                                value={settings.maxConcurrent}
                                disabled={saving === 'parallel'}
                                aria-describedby={ids.parallelHelp}
                                onChange={(event) => void saveParallel(Number(event.target.value))}
                            >
                                <option value={1}>One at a time (recommended)</option>
                                <option value={2}>Two at a time</option>
                            </SelectBox>
                            <p id={ids.parallelHelp} className="help">
                                Two at a time finishes a batch faster but uses more CPU, memory and
                                disk.
                            </p>
                        </div>
                    </div>
                </SectionCard>

                <R2SettingsCard />
            </div>
        </div>
    );
}
