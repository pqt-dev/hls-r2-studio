import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AboutIcon, BrandMark, LibraryIcon, QueueIcon, SettingsIcon } from '../components/icons';
import { siteHost } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { AboutScreen } from './AboutScreen';
import { LibraryScreen } from './LibraryScreen';
import { QueueScreen } from './QueueScreen';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'queue' | 'library' | 'settings' | 'about';

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: ReactNode }> = [
    { id: 'queue', label: 'Queue', icon: <QueueIcon /> },
    { id: 'library', label: 'Library', icon: <LibraryIcon /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
    { id: 'about', label: 'About', icon: <AboutIcon /> },
];

export function MainScreen() {
    const { auth, settings, summary } = useApp();
    const [tab, setTab] = useState<Tab>('queue');
    const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

    const host = siteHost(auth.siteUrl ?? settings?.siteUrl);
    const active = summary.running + summary.waiting;
    const current = TABS.find((item) => item.id === tab);

    function onKeyDown(event: KeyboardEvent): void {
        const index = TABS.findIndex((item) => item.id === tab);
        let next: number;

        if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
            next = (index + 1) % TABS.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
            next = (index - 1 + TABS.length) % TABS.length;
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
            <div className="sidebar">
                <div className="sidebar-brand">
                    <BrandMark />
                    <p className="wordmark">HLS R2 Studio</p>
                </div>

                <div
                    className="nav"
                    role="tablist"
                    aria-label="Sections"
                    aria-orientation="vertical"
                    onKeyDown={onKeyDown}
                >
                    {TABS.map((item) => (
                        <button
                            key={item.id}
                            ref={(node) => {
                                refs.current[item.id] = node;
                            }}
                            id={`tab-${item.id}`}
                            type="button"
                            role="tab"
                            className={item.id === 'about' ? 'tab tab-secondary' : 'tab'}
                            aria-selected={tab === item.id}
                            aria-controls={`panel-${item.id}`}
                            tabIndex={tab === item.id ? 0 : -1}
                            onClick={() => setTab(item.id)}
                        >
                            {item.icon}
                            <span className="tab-label">{item.label}</span>
                            {item.id === 'queue' && active > 0 && (
                                <span className="tab-count num">{active}</span>
                            )}
                        </button>
                    ))}
                </div>

                <div
                    className="sidebar-footer"
                    role="group"
                    aria-label="Account"
                    title={auth.siteUrl}
                >
                    <span className="avatar" aria-hidden="true">
                        {(auth.username ?? '?').slice(0, 1).toUpperCase()}
                    </span>
                    <p className="account">
                        {auth.username !== undefined && (
                            <strong className="account-name" title={auth.username}>
                                {auth.username}
                            </strong>
                        )}
                        {host !== '' && (
                            <span className="account-site" title={host}>
                                {host}
                            </span>
                        )}
                    </p>
                </div>
            </div>

            <div className="workspace">
                <header className="topbar">
                    <p className="topbar-brand">HLS R2 Studio</p>
                    <p className="page-title">{current?.label}</p>
                    <div className="topbar-status">
                        {active > 0 && (
                            <span className="chip chip-running num" aria-hidden="true">
                                {active} active
                            </span>
                        )}
                        {auth.status === 'offline' && (
                            <span className="chip chip-attention">Offline</span>
                        )}
                    </div>
                </header>

                <main
                    className="panel"
                    id={`panel-${tab}`}
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                >
                    <div className="panel-inner">
                        {tab === 'queue' && <QueueScreen />}
                        {tab === 'library' && <LibraryScreen />}
                        {tab === 'settings' && <SettingsScreen />}
                        {tab === 'about' && <AboutScreen />}
                    </div>
                </main>
            </div>
        </div>
    );
}
