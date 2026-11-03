import { useId, useState, type FormEvent } from 'react';
import { useApp } from '../state/AppProvider';

const URL_ERROR = 'Enter the site address starting with https://';

/** The main process stays authoritative; this only catches obvious typos early. */
function looksLikeSiteUrl(value: string): boolean {
    return /^https:\/\/\S+$/i.test(value) || /^http:\/\/localhost(:\d+)?(\/\S*)?$/i.test(value);
}

export function LoginScreen() {
    const { api, auth, settings } = useApp();
    const ids = { url: useId(), user: useId(), pass: useId(), error: useId() };

    const [siteUrl, setSiteUrl] = useState(settings?.siteUrl ?? '');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [staySignedIn, setStaySignedIn] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const restoring = auth.status === 'signing_in' && !submitting;
    const busy = submitting || restoring;
    const shownError = error ?? (busy ? null : (auth.error ?? null));

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();

        if (busy) return;

        const url = siteUrl.trim();

        if (!looksLikeSiteUrl(url)) {
            setError(URL_ERROR);

            return;
        }

        if (username.trim() === '' || password === '') {
            setError('Enter your username and password.');

            return;
        }

        setError(null);
        setSubmitting(true);

        try {
            const result = await api.auth.login(url, username.trim(), password, staySignedIn);

            if (result.status !== 'signed_in' && result.status !== 'offline') {
                setError(result.error ?? 'Sign-in failed. Please try again.');
            }
        } catch {
            setError('Sign-in failed. Please try again.');
        } finally {
            // Never keep the password around after an attempt.
            setPassword('');
            setSubmitting(false);
        }
    }

    return (
        <main className="login">
            <form className="card login-card" onSubmit={(event) => void submit(event)} noValidate>
                <p className="wordmark">HLS R2 Studio</p>
                <h1 className="login-title">Sign in</h1>
                <p className="muted">Use the account you have on your HLS site.</p>

                <div className="field">
                    <label htmlFor={ids.url}>Site URL</label>
                    <input
                        id={ids.url}
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://your-site.example.com"
                        value={siteUrl}
                        disabled={busy}
                        aria-describedby={shownError === null ? undefined : ids.error}
                        onChange={(event) => setSiteUrl(event.target.value)}
                    />
                </div>
                <div className="field">
                    <label htmlFor={ids.user}>Username</label>
                    <input
                        id={ids.user}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={username}
                        disabled={busy}
                        onChange={(event) => setUsername(event.target.value)}
                    />
                </div>
                <div className="field">
                    <label htmlFor={ids.pass}>Password</label>
                    <input
                        id={ids.pass}
                        type="password"
                        autoComplete="off"
                        value={password}
                        disabled={busy}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                </div>

                <label className="check">
                    <input
                        type="checkbox"
                        checked={staySignedIn}
                        disabled={busy}
                        onChange={(event) => setStaySignedIn(event.target.checked)}
                    />
                    <span>Stay signed in</span>
                </label>

                <div id={ids.error} className="form-error" role="alert">
                    {shownError}
                </div>

                <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </main>
    );
}
