import { useState } from 'react';
import { Feedback, type FeedbackMessage } from '../components/Feedback';
import { useApp } from '../state/AppProvider';

export function AboutScreen() {
    const { api, diagnostics } = useApp();
    const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

    async function open(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
        setFeedback(null);

        try {
            const result = await action();

            if (!result.ok) setFeedback({ kind: 'error', text: result.error });
        } catch {
            setFeedback({ kind: 'error', text: 'Something went wrong. Please try again.' });
        }
    }

    const ffmpeg = diagnostics?.ffmpeg;

    return (
        <div className="about">
            <section className="card" aria-labelledby="about-heading">
                <h2 id="about-heading">About HLS R2 Studio</h2>
                <dl className="facts">
                    <dt>App version</dt>
                    <dd className="num">{diagnostics?.appVersion ?? 'Unknown'}</dd>
                    <dt>Platform</dt>
                    <dd>{diagnostics?.platform ?? 'Unknown'}</dd>
                    <dt>FFmpeg version</dt>
                    <dd className="num">{ffmpeg?.version ?? 'Unknown'}</dd>
                    <dt>FFmpeg self-check</dt>
                    <dd>
                        {ffmpeg === undefined || !ffmpeg.checked ? (
                            'Checking…'
                        ) : ffmpeg.ok ? (
                            <span className="chip chip-done">
                                <span className="chip-icon" aria-hidden="true">
                                    {'✓'}
                                </span>
                                Passed
                            </span>
                        ) : (
                            <>
                                <span className="chip chip-failed">
                                    <span className="chip-icon" aria-hidden="true">
                                        {'✕'}
                                    </span>
                                    Failed
                                </span>
                                {ffmpeg.missing.length > 0 && (
                                    <>
                                        <p className="small">Missing features:</p>
                                        <ul className="plain-list">
                                            {ffmpeg.missing.map((item) => (
                                                <li key={item}>{item}</li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </>
                        )}
                    </dd>
                </dl>
                <div className="row row-wrap">
                    <button
                        type="button"
                        className="btn"
                        onClick={() => void open(() => api.app.openLogsFolder())}
                    >
                        Open logs folder
                    </button>
                    <button
                        type="button"
                        className="btn"
                        onClick={() => void open(() => api.app.openNotices())}
                    >
                        Open licenses
                    </button>
                </div>
                <Feedback message={feedback} />
            </section>

            <section className="card" aria-labelledby="gpl-heading">
                <h2 id="gpl-heading">FFmpeg license notice</h2>
                <p>
                    This app bundles FFmpeg, which is free software licensed under the GNU General
                    Public License (GPL) version 3. FFmpeg is a trademark of Fabrice Bellard,
                    originator of the FFmpeg project. The bundled build comes with no warranty.
                </p>
                <p>
                    The full license text, the build details and the location of the FFmpeg source
                    code are listed in the licenses file. Use Open licenses to read it.
                </p>
            </section>
        </div>
    );
}
