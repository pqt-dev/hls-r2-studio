import type { ReactNode } from 'react';

/** Small hand-written 20px icons, drawn with currentColor so they follow the theme. */
function Icon({ children }: { children: ReactNode }) {
    return (
        <svg
            className="icon"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {children}
        </svg>
    );
}

export function HomeIcon() {
    return (
        <Icon>
            <path d="M3.5 9.5 10 4l6.5 5.5" />
            <path d="M5 8.5V16h10V8.5M8.5 16v-4h3v4" />
        </Icon>
    );
}

export function QueueIcon() {
    return (
        <Icon>
            <path d="M4 5.5h12M4 10h12M4 14.5h7" />
        </Icon>
    );
}

export function LibraryIcon() {
    return (
        <Icon>
            <rect x="3" y="4" width="14" height="12" rx="2" />
            <path d="M8.5 7.5v5l4-2.5z" />
        </Icon>
    );
}

/** A page with text lines: the site's processing logs. */
export function LogsIcon() {
    return (
        <Icon>
            <path d="M5.5 3.5h6l3.5 3.5v9a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" />
            <path d="M11.5 3.5V7H15M7.5 10.5h5M7.5 13.5h5" />
        </Icon>
    );
}

export function SettingsIcon() {
    return (
        <Icon>
            <path d="M3.5 6h8M15.5 6h1M3.5 14h1M8.5 14h8" />
            <circle cx="13.5" cy="6" r="2" />
            <circle cx="6.5" cy="14" r="2" />
        </Icon>
    );
}

export function AboutIcon() {
    return (
        <Icon>
            <circle cx="10" cy="10" r="7" />
            <path d="M10 9v4.5M10 6.6v.1" />
        </Icon>
    );
}

export function SearchIcon() {
    return (
        <Icon>
            <circle cx="9" cy="9" r="5" />
            <path d="m13 13 3.5 3.5" />
        </Icon>
    );
}

export function GridViewIcon() {
    return (
        <Icon>
            <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" />
            <rect x="11" y="3.5" width="5.5" height="5.5" rx="1" />
            <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" />
            <rect x="11" y="11" width="5.5" height="5.5" rx="1" />
        </Icon>
    );
}

export function ListViewIcon() {
    return (
        <Icon>
            <path d="M3.5 5.5h1M3.5 10h1M3.5 14.5h1M7.5 5.5h9M7.5 10h9M7.5 14.5h9" />
        </Icon>
    );
}

/** Two chain links: copy the embed URL. */
export function LinkIcon() {
    return (
        <Icon>
            <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8" />
            <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8" />
        </Icon>
    );
}

/** Square brackets: copy the `[shortcode]`. */
export function ShortcodeIcon() {
    return (
        <Icon>
            <path d="M7.5 4.5h-2v11h2M12.5 4.5h2v11h-2" />
            <path d="M9 10h2" />
        </Icon>
    );
}

/** A list with a play triangle: copy the playlist URL. */
export function PlaylistIcon() {
    return (
        <Icon>
            <path d="M3.5 5.5h9M3.5 9.5h6M3.5 13.5h4" />
            <path d="M12.5 11v5l4-2.5z" />
        </Icon>
    );
}

/** A box with an arrow leaving it: open outside the app. */
export function OpenExternalIcon() {
    return (
        <Icon>
            <path d="M8 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5V12" />
            <path d="M11.5 3.5h5v5M16.5 3.5 9.5 10.5" />
        </Icon>
    );
}

export function PencilIcon() {
    return (
        <Icon>
            <path d="m12.5 4.5 3 3L7 16H4v-3z" />
            <path d="m11 6 3 3" />
        </Icon>
    );
}

export function TrashIcon() {
    return (
        <Icon>
            <path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 9.5h7.6l.7-9.5M8.5 9v4M11.5 9v4" />
        </Icon>
    );
}

/** Placeholder brand mark: a rounded tile with a play triangle. */
export function BrandMark({ size = 28 }: { size?: number }) {
    return (
        <svg
            className="brand-mark"
            width={size}
            height={size}
            viewBox="0 0 28 28"
            aria-hidden="true"
            focusable="false"
        >
            <rect width="28" height="28" rx="8" fill="var(--primary)" />
            <path d="M11 8.5v11l9-5.5z" fill="var(--on-primary)" />
        </svg>
    );
}
