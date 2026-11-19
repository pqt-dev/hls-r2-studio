import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { R2FieldName, R2SaveInput, R2Status } from '../../../shared/ipc';
import { Banner } from '../components/Banner';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { SectionCard } from '../components/SectionCard';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';

type Load =
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; status: R2Status };

type FieldErrors = Partial<Record<R2FieldName, string>>;

interface Form {
    endpoint: string;
    bucket: string;
    url: string;
    /** Write-only: typed by the user, sent once, cleared after a save, never read back. */
    accessKeyId: string;
    secretAccessKey: string;
}

const EMPTY_SECRETS = { accessKeyId: '', secretAccessKey: '' } as const;

function formOf(status: R2Status): Form {
    return {
        endpoint: status.endpoint ?? '',
        bucket: status.bucket ?? '',
        url: status.url ?? '',
        ...EMPTY_SECRETS,
    };
}

/** True when the form differs from what is saved (the key and secret count when typed). */
function isDirty(form: Form, status: R2Status): boolean {
    const saved = formOf(status);

    return (
        form.endpoint.trim() !== saved.endpoint ||
        form.bucket.trim() !== saved.bucket ||
        form.url.trim() !== saved.url ||
        form.accessKeyId.trim() !== '' ||
        form.secretAccessKey.trim() !== ''
    );
}

function keyPlaceholder(status: R2Status): string {
    return status.accessKeyLast4 === null
        ? ''
        : `Saved (ends with ${status.accessKeyLast4}) - leave blank to keep`;
}

function secretPlaceholder(status: R2Status): string {
    return status.hasSecret ? 'Saved - leave blank to keep' : '';
}

/** The "R2 storage" card of the Settings screen: view, edit and test the site's R2 config. */
export function R2SettingsCard() {
    const { api, summary } = useApp();
    const toast = useToast();
    const ids = {
        endpoint: useId(),
        bucket: useId(),
        url: useId(),
        key: useId(),
        secret: useId(),
        help: useId(),
    };
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    const [form, setForm] = useState<Form>({
        endpoint: '',
        bucket: '',
        url: '',
        ...EMPTY_SECRETS,
    });
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [formError, setFormError] = useState<FeedbackMessage | null>(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    const fetchStatus = useCallback(async (): Promise<void> => {
        setLoad({ kind: 'loading' });

        try {
            const result = await api.r2.get();

            if (!mounted.current) return;

            if (result.ok) {
                setLoad({ kind: 'ready', status: result.status });
                setForm(formOf(result.status));
            } else {
                setLoad({ kind: 'error', message: result.error });
            }
        } catch {
            if (mounted.current) {
                setLoad({ kind: 'error', message: 'Could not load the R2 settings.' });
            }
        }
    }, [api]);

    useEffect(() => {
        void fetchStatus();
    }, [fetchStatus]);

    const busyJobs = summary.running > 0;

    function change(field: keyof Form, value: string): void {
        setForm((current) => ({ ...current, [field]: value }));
        setFieldErrors((current) => ({ ...current, [field]: undefined }));
        setFormError(null);
    }

    async function save(event: FormEvent): Promise<void> {
        event.preventDefault();
        setSaving(true);
        setFieldErrors({});
        setFormError(null);

        const input: R2SaveInput = {
            endpoint: form.endpoint.trim(),
            bucket: form.bucket.trim(),
            url: form.url.trim(),
        };

        // Blank = keep the stored value: the field is left out of the request.
        if (form.accessKeyId.trim() !== '') input.accessKeyId = form.accessKeyId.trim();
        if (form.secretAccessKey.trim() !== '') input.secretAccessKey = form.secretAccessKey.trim();

        try {
            const result = await api.r2.save(input);

            if (!mounted.current) return;

            if (result.ok) {
                // The typed key and secret are dropped from the state as soon as they are saved.
                setLoad({ kind: 'ready', status: result.status });
                setForm(formOf(result.status));
                toast.show('success', 'R2 settings saved.');
            } else {
                setFieldErrors(result.fieldErrors ?? {});
                setFormError({ kind: 'error', text: result.error });
            }
        } catch {
            if (mounted.current) {
                setFormError({ kind: 'error', text: 'Could not save the R2 settings.' });
            }
        } finally {
            if (mounted.current) setSaving(false);
        }
    }

    async function testConnection(): Promise<void> {
        setTesting(true);

        try {
            const result = await api.r2.test();

            if (!mounted.current) return;

            if (result.ok) toast.show('success', 'R2 connection OK.');
            else toast.show('error', result.error);
        } catch {
            if (mounted.current) toast.show('error', 'Could not test the R2 connection.');
        } finally {
            if (mounted.current) setTesting(false);
        }
    }

    if (load.kind !== 'ready') {
        return (
            <SectionCard title="R2 storage" level={3}>
                {load.kind === 'loading' ? (
                    <p className="muted" role="status" aria-busy="true">
                        {'Loading…'}
                    </p>
                ) : (
                    <div className="home-error">
                        <p role="alert">{load.message}</p>
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void fetchStatus()}
                        >
                            Retry
                        </button>
                    </div>
                )}
            </SectionCard>
        );
    }

    const { status } = load;
    const dirty = isDirty(form, status);
    const working = saving || testing;
    const fieldError = (field: R2FieldName): FeedbackMessage | null => {
        const text = fieldErrors[field];

        return text === undefined ? null : { kind: 'error', text };
    };

    return (
        <SectionCard title="R2 storage" level={3}>
            {!status.configured && (
                <Banner tone="warning" title="R2 storage is not set up.">
                    Videos cannot be uploaded until the settings below are saved.
                </Banner>
            )}

            <form onSubmit={(event) => void save(event)} autoComplete="off" noValidate>
                <div className="field">
                    <label htmlFor={ids.endpoint}>Endpoint</label>
                    <input
                        id={ids.endpoint}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.endpoint}
                        aria-invalid={fieldErrors.endpoint !== undefined}
                        onChange={(event) => change('endpoint', event.target.value)}
                    />
                    <Feedback message={fieldError('endpoint')} />
                </div>

                <div className="field">
                    <label htmlFor={ids.bucket}>Bucket</label>
                    <input
                        id={ids.bucket}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.bucket}
                        aria-invalid={fieldErrors.bucket !== undefined}
                        onChange={(event) => change('bucket', event.target.value)}
                    />
                    <Feedback message={fieldError('bucket')} />
                </div>

                <div className="field">
                    <label htmlFor={ids.url}>Public URL</label>
                    <input
                        id={ids.url}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.url}
                        aria-invalid={fieldErrors.url !== undefined}
                        onChange={(event) => change('url', event.target.value)}
                    />
                    <Feedback message={fieldError('url')} />
                </div>

                <div className="field">
                    <label htmlFor={ids.key}>Access Key ID</label>
                    <input
                        id={ids.key}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.accessKeyId}
                        placeholder={keyPlaceholder(status)}
                        aria-invalid={fieldErrors.accessKeyId !== undefined}
                        onChange={(event) => change('accessKeyId', event.target.value)}
                    />
                    <Feedback message={fieldError('accessKeyId')} />
                </div>

                <div className="field">
                    <label htmlFor={ids.secret}>Secret Access Key</label>
                    <input
                        id={ids.secret}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={form.secretAccessKey}
                        placeholder={secretPlaceholder(status)}
                        aria-invalid={fieldErrors.secretAccessKey !== undefined}
                        onChange={(event) => change('secretAccessKey', event.target.value)}
                    />
                    <Feedback message={fieldError('secretAccessKey')} />
                </div>

                <div className="row row-wrap">
                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={working || busyJobs}
                        aria-busy={saving}
                    >
                        {saving ? 'Saving…' : 'Save R2 settings'}
                    </button>
                    <button
                        type="button"
                        className="btn"
                        disabled={working || dirty || !status.configured}
                        aria-busy={testing}
                        aria-describedby={ids.help}
                        onClick={() => void testConnection()}
                    >
                        {testing ? 'Testing…' : 'Test connection'}
                    </button>
                </div>
                <p id={ids.help} className="help">
                    {busyJobs
                        ? 'The settings cannot be saved while videos are being processed.'
                        : dirty
                          ? 'Save your changes first: the test uses the saved settings, not the values in this form.'
                          : 'The test uses the saved settings. Leave the key and secret blank to keep the saved ones.'}
                </p>
                <Feedback message={formError} />
            </form>
        </SectionCard>
    );
}
