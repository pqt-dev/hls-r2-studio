import { useRef, useState, type KeyboardEvent } from 'react';
import { siteHost } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { AboutScreen } from './AboutScreen';
import { QueueScreen } from './QueueScreen';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'queue' | 'settings' | 'about';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'queue', label: 'Queue' },
    { id: 'settings', label: 'Settings' },
    { id: 'about', label: 'About' },
];

export function MainScreen() {
    const { auth, settings, summary } = useApp();
    const [tab, setTab] = useState<Tab>('queue');
    const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

    const host = siteHost(auth.siteUrl ?? settings?.siteUrl);

    function onKeyDown(event: KeyboardEvent): void {
        const index = TABS.findIndex((item) => item.id === tab);
        let next: number;

        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = TABS.length - 1;
        else return;

        event.preventDefault();

        const target = TABS[next];

        if (target !== undefined) {
            setTab(target.id);
            refs.current[target.id]?.focus();
        }
    }

    return (
        <div className="shell">
            <header className="topbar">
                <p className="wordmark">HLS R2 Studio</p>
                <p className="account" title={auth.siteUrl}>
                    {auth.username !== undefined && <strong>{auth.username}</strong>}
                    {auth.username !== undefined && host !== '' && (
                        <span aria-hidden="true"> {'·'} </span>
                    )}
                    {host !== '' && <span>{host}</span>}
                    {auth.status === 'offline' && (
                        <span className="chip chip-attention">Offline</span>
                    )}
                </p>
            </header>

            <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onKeyDown}>
                {TABS.map((item) => (
                    <button
                        key={item.id}
                        ref={(node) => {
                            refs.current[item.id] = node;
                        }}
                        id={`tab-${item.id}`}
                        type="button"
                        role="tab"
                        className="tab"
                        aria-selected={tab === item.id}
                        aria-controls={`panel-${item.id}`}
                        tabIndex={tab === item.id ? 0 : -1}
                        onClick={() => setTab(item.id)}
                    >
                        {item.label}
                        {item.id === 'queue' && summary.running + summary.waiting > 0 && (
                            <span className="tab-count num">
                                {summary.running + summary.waiting}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            <main
                className="panel"
                id={`panel-${tab}`}
                role="tabpanel"
                aria-labelledby={`tab-${tab}`}
            >
                {tab === 'queue' && <QueueScreen />}
                {tab === 'settings' && <SettingsScreen />}
                {tab === 'about' && <AboutScreen />}
            </main>
        </div>
    );
}
