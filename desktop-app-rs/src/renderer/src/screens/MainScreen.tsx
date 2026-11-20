import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import {
    AboutIcon,
    BrandMark,
    HomeIcon,
    LibraryIcon,
    QueueIcon,
    SettingsIcon,
    SignOutIcon,
} from '../components/icons';
import { plural } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';
import { NavigationContext, type NavigationApi, type Tab } from '../state/Navigation';
import { AboutScreen } from './AboutScreen';
import { HomeScreen } from './HomeScreen';
import { LibraryScreen } from './LibraryScreen';
import { QueueScreen } from './QueueScreen';
import { SettingsScreen } from './SettingsScreen';

const TABS: ReadonlyArray<{
    id: Tab;
    label: string;
    icon: ReactNode;
    /** Sidebar group heading shown above this tab (the first tab of a group). */
    group?: string;
}> = [
    { id: 'home', label: 'Home', icon: <HomeIcon duo />, group: 'Workspace' },
    { id: 'queue', label: 'Queue', icon: <QueueIcon duo /> },
    { id: 'library', label: 'Library', icon: <LibraryIcon duo /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon duo />, group: 'System' },
    { id: 'about', label: 'About', icon: <AboutIcon duo /> },
];

export function MainScreen() {
    const { api, auth, summary } = useApp();
    const toast = useToast();
    const [tab, setTab] = useState<Tab>('home');
    // The video the Library should open when it mounts; cleared by any tab change of the user.
    const [libraryVideoId, setLibraryVideoId] = useState<number | undefined>(undefined);
    const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
    const [confirmSignOut, setConfirmSignOut] = useState(false);
    const [signingOut, setSigningOut] = useState(false);

    const active = summary.running + summary.waiting;
    const current = TABS.find((item) => item.id === tab);

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

    function selectTab(next: Tab): void {
        setLibraryVideoId(undefined);
        setTab(next);
    }

    const navigation = useMemo<NavigationApi>(
        () => ({
            openLibraryVideo: (id) => {
                setLibraryVideoId(id);
                setTab('library');
                // The detail page takes focus itself; otherwise the selected tab does.
                if (id === undefined) refs.current.library?.focus();
            },
            openTab: (next) => {
                setLibraryVideoId(undefined);
                setTab(next);
                // The clicked button leaves the page with its screen: the selected tab takes focus.
                refs.current[next]?.focus();
            },
        }),
        [],
    );

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
            selectTab(target.id);
            refs.current[target.id]?.focus();
        }
    }

    return (
        <NavigationContext.Provider value={navigation}>
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
                        {TABS.map((item) => [
                            item.group === undefined ? null : (
                                <p
                                    key={`group-${item.id}`}
                                    className="nav-group"
                                    role="presentation"
                                >
                                    {item.group}
                                </p>
                            ),
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
                                onClick={() => selectTab(item.id)}
                            >
                                {item.icon}
                                <span className="tab-label">{item.label}</span>
                                {item.id === 'queue' && active > 0 && (
                                    <span className="tab-count num">{active}</span>
                                )}
                            </button>,
                        ])}
                    </div>

                    <div className="sidebar-footer" role="group" aria-label="Account">
                        <div className="account-card">
                            <span className="avatar" aria-hidden="true">
                                {(auth.username ?? '?').slice(0, 1).toUpperCase()}
                            </span>
                            <span className="account">
                                <strong className="account-name" title={auth.username}>
                                    {auth.username ?? 'Account'}
                                </strong>
                                <span className="account-sub">Signed in</span>
                            </span>
                            <button
                                type="button"
                                className="btn btn-sm btn-danger-quiet account-signout"
                                aria-label="Sign out"
                                title="Sign out"
                                disabled={signingOut}
                                onClick={() => {
                                    if (summary.running > 0) setConfirmSignOut(true);
                                    else void signOut();
                                }}
                            >
                                <SignOutIcon />
                                <span className="account-signout-label">Sign out</span>
                            </button>
                        </div>
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
                            {tab === 'home' && <HomeScreen />}
                            {tab === 'queue' && <QueueScreen />}
                            {tab === 'library' && <LibraryScreen initialVideoId={libraryVideoId} />}
                            {tab === 'settings' && <SettingsScreen />}
                            {tab === 'about' && <AboutScreen />}
                        </div>
                    </main>
                </div>
            </div>

            {confirmSignOut && (
                <ConfirmDialog
                    title="Sign out now?"
                    message={`${plural(summary.running, 'video is', 'videos are')} still being processed. They may need you to sign in again before they can finish.`}
                    confirmLabel="Sign out"
                    cancelLabel="Stay signed in"
                    danger
                    onCancel={() => setConfirmSignOut(false)}
                    onConfirm={() => {
                        setConfirmSignOut(false);
                        void signOut();
                    }}
                />
            )}
        </NavigationContext.Provider>
    );
}
