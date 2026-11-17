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
