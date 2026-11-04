import { useId, useState, type FormEvent } from 'react';
import { siteHost } from '../lib/format';
import { useApp } from '../state/AppProvider';

export function LoginScreen() {
    const { api, auth, settings } = useApp();
    const ids = { user: useId(), pass: useId(), error: useId() };

    // The site is fixed when the app is built: it is shown, never asked for.
    const host = siteHost(auth.siteUrl ?? settings?.siteUrl);
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

        if (username.trim() === '' || password === '') {
            setError('Enter your username and password.');

            return;
        }

        setError(null);
        setSubmitting(true);

        try {
            const result = await api.auth.login(username.trim(), password, staySignedIn);

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
                {host !== '' && (
                    <p className="muted small">
                        Signing in to <strong>{host}</strong>
                    </p>
                )}

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
