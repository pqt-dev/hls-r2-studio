import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { R2FieldName, R2SaveInput, R2Status } from '../../../shared/ipc';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { SuccessIcon, WarningIcon } from '../components/icons';
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

const MASKED_KEY_PREFIX = '••••••••••••';
const MASKED_SECRET = '••••••••••••••••';

type SecretField = 'accessKeyId' | 'secretAccessKey';

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
    // A saved key/secret stays masked (and is left out of the save) until Change is clicked.
    const [editing, setEditing] = useState<Record<SecretField, boolean>>({
        accessKeyId: false,
        secretAccessKey: false,
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
                setEditing({ accessKeyId: false, secretAccessKey: false });
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

    function startEditing(field: SecretField): void {
        setEditing((current) => ({ ...current, [field]: true }));
    }

    function cancelEditing(field: SecretField): void {
        setEditing((current) => ({ ...current, [field]: false }));
        setForm((current) => ({ ...current, [field]: '' }));
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

        // A field still masked (or left blank) keeps the stored value: it is left out of the request.
        if (editing.accessKeyId && form.accessKeyId.trim() !== '') {
            input.accessKeyId = form.accessKeyId.trim();
        }

        if (editing.secretAccessKey && form.secretAccessKey.trim() !== '') {
            input.secretAccessKey = form.secretAccessKey.trim();
        }

        try {
            const result = await api.r2.save(input);

            if (!mounted.current) return;

            if (result.ok) {
                // The typed key and secret are dropped from the state as soon as they are saved.
                setLoad({ kind: 'ready', status: result.status });
                setForm(formOf(result.status));
                setEditing({ accessKeyId: false, secretAccessKey: false });
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
            <p className="r2-status">
                {status.configured ? (
                    <span className="chip chip-done">
                        <span className="chip-icon" aria-hidden="true">
                            <SuccessIcon />
                        </span>
                        Configured
                    </span>
                ) : (
                    <span className="chip chip-attention">
                        <span className="chip-icon" aria-hidden="true">
                            <WarningIcon />
                        </span>
                        Not configured
                    </span>
                )}
            </p>
            {!status.configured && (
                <p className="help">
                    Videos cannot be uploaded until the settings below are saved.
                </p>
            )}

            <form onSubmit={(event) => void save(event)} autoComplete="off" noValidate>
                <div className="form-grid">
                    <div className="field field-span">
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
                        {status.accessKeyLast4 !== null && !editing.accessKeyId ? (
                            <div className="row">
                                <input
                                    id={ids.key}
                                    type="text"
                                    readOnly
                                    autoComplete="off"
                                    value={`${MASKED_KEY_PREFIX}${status.accessKeyLast4}`}
                                />
                                <button
                                    type="button"
                                    className="btn"
                                    aria-label="Change Access Key ID"
                                    onClick={() => startEditing('accessKeyId')}
                                >
                                    Change
                                </button>
                            </div>
                        ) : (
                            <div className="row">
                                <input
                                    id={ids.key}
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    required={status.accessKeyLast4 === null}
                                    value={form.accessKeyId}
                                    aria-invalid={fieldErrors.accessKeyId !== undefined}
                                    onChange={(event) => change('accessKeyId', event.target.value)}
                                />
                                {status.accessKeyLast4 !== null && (
                                    <button
                                        type="button"
                                        className="btn"
                                        aria-label="Cancel changing Access Key ID"
                                        onClick={() => cancelEditing('accessKeyId')}
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        )}
                        <Feedback message={fieldError('accessKeyId')} />
                    </div>

                    <div className="field">
                        <label htmlFor={ids.secret}>Secret Access Key</label>
                        {status.hasSecret && !editing.secretAccessKey ? (
                            <div className="row">
                                <input
                                    id={ids.secret}
                                    type="text"
                                    readOnly
                                    autoComplete="off"
                                    value={MASKED_SECRET}
                                />
                                <button
                                    type="button"
                                    className="btn"
                                    aria-label="Change Secret Access Key"
                                    onClick={() => startEditing('secretAccessKey')}
                                >
                                    Change
                                </button>
                            </div>
                        ) : (
                            <div className="row">
                                <input
                                    id={ids.secret}
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    required={!status.hasSecret}
                                    value={form.secretAccessKey}
                                    aria-invalid={fieldErrors.secretAccessKey !== undefined}
                                    onChange={(event) =>
                                        change('secretAccessKey', event.target.value)
                                    }
                                />
                                {status.hasSecret && (
                                    <button
                                        type="button"
                                        className="btn"
                                        aria-label="Cancel changing Secret Access Key"
                                        onClick={() => cancelEditing('secretAccessKey')}
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        )}
                        <Feedback message={fieldError('secretAccessKey')} />
                    </div>
                </div>

                <div className="form-footer">
                    <p id={ids.help} className="help">
                        {busyJobs
                            ? 'The settings cannot be saved while videos are being processed.'
                            : dirty
                              ? 'Save your changes first: the test uses the saved settings, not the values in this form.'
                              : 'Test connection checks the saved settings.'}
                    </p>
                    <div className="form-actions">
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
                </div>
                <Feedback message={formError} />
            </form>
        </SectionCard>
    );
}
