import { useRef, useState, type ReactNode } from 'react';
import { ImageIcon, LinkIcon, OpenExternalIcon, ShortcodeIcon } from './icons';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

const COPIED_TOASTS = {
    shortcode: 'Shortcode copied.',
    'embed-url': 'Direct URL copied.',
    'thumbnail-url': 'Thumbnail URL copied.',
} as const;

/** Quick actions of a ready video: Rust builds the text and copies/opens, never the renderer. */
export type QuickAction = 'shortcode' | 'embed-url' | 'thumbnail-url' | 'open';

/**
 * Runs the quick actions with the same toasts everywhere. `busyIds` are the videos with an
 * action in flight (the ref also blocks a double click before the re-render).
 */
export function useQuickActions(): {
    busyIds: ReadonlySet<number>;
    run: (id: number, action: QuickAction) => void;
} {
    const { api } = useApp();
    const toast = useToast();
    const busy = useRef(new Set<number>());
    const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(new Set());

    function run(id: number, action: QuickAction): void {
        if (busy.current.has(id)) return;

        busy.current.add(id);
        setBusyIds(new Set(busy.current));

        const request =
            action === 'open' ? api.videos.openEmbed(id) : api.videos.copyLink(id, action);

        request
            .then((result) => {
                if (!result.ok) toast.show('error', result.error);
                else if (action === 'open') toast.show('success', 'Opened in your browser.');
                else toast.show('success', COPIED_TOASTS[action]);
            })
            .catch(() => toast.show('error', GENERIC_ERROR))
            .finally(() => {
                busy.current.delete(id);
                setBusyIds(new Set(busy.current));
            });
    }

    return { busyIds, run };
}

const BUTTONS: Record<QuickAction, { label: string; icon: ReactNode }> = {
    shortcode: { label: 'Copy shortcode', icon: <ShortcodeIcon /> },
    'thumbnail-url': { label: 'Copy thumbnail URL', icon: <ImageIcon /> },
    'embed-url': { label: 'Copy direct URL', icon: <LinkIcon /> },
    open: { label: 'Open in browser', icon: <OpenExternalIcon /> },
};

/** Fixed display order of the cluster, whatever order the caller lists the actions in. */
const ORDER: readonly QuickAction[] = ['shortcode', 'thumbnail-url', 'embed-url', 'open'];

/**
 * One icon-only quick button (shared look: size, hit area, busy cursor). `accent` is the tonal
 * primary style of the one highlighted action of a row. Used by `VideoQuickActions` and by rows
 * that have a single quick button of their own (Queue "View in Library").
 */
export function QuickIconButton({
    label,
    ariaLabel,
    icon,
    className,
    busy = false,
    disabled = false,
    onClick,
}: {
    /** Tooltip (`title`). */
    label: string;
    ariaLabel: string;
    icon: ReactNode;
    className: string;
    busy?: boolean;
    /** The whole row is inert: the button is disabled and leaves the tab order. */
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={className}
            aria-label={ariaLabel}
            title={label}
            aria-busy={busy}
            disabled={busy || disabled}
            aria-disabled={disabled ? true : undefined}
            tabIndex={disabled ? -1 : undefined}
            onClick={onClick}
        >
            {icon}
        </button>
    );
}

/** Class of the accented (tonal primary) quick button. */
export const QUICK_ACCENT_CLASS = 'btn btn-sm btn-tonal video-quick video-quick-primary';

function buttonClass(action: QuickAction, variant: 'default' | 'ghost'): string {
    if (variant === 'ghost') return 'btn btn-sm btn-text video-quick video-quick-ghost';

    // The shortcode is the one accented action; the rest are neutral like the kebab.
    return action === 'shortcode' ? QUICK_ACCENT_CLASS : 'btn btn-sm video-quick';
}

/**
 * The shared quick actions cluster of a video row/card: icon-only buttons in a fixed order
 * (copy shortcode accented, copy thumbnail URL, copy direct URL, open in browser) followed by an
 * optional kebab `menu`. The caller decides which `actions` exist and what the menu holds; the
 * buttons only report the kind through `onQuick` (Rust builds, copies and opens, never the
 * renderer). Used by the Library and Home.
 */
export function VideoQuickActions({
    title,
    busy,
    disabled = false,
    onQuick,
    actions,
    menu,
    variant = 'default',
}: {
    /** The whole row is inert (e.g. being deleted): buttons are disabled and leave the tab order. */
    disabled?: boolean;
    title: string;
    /** A quick action of this video is in flight: its buttons are disabled. */
    busy: boolean;
    onQuick: (action: QuickAction) => void;
    actions: readonly QuickAction[];
    /** The kebab menu, rendered last inside the group. */
    menu?: ReactNode;
    /** `ghost`: quiet transparent icon buttons for dense rows (Home). */
    variant?: 'default' | 'ghost';
}) {
    return (
        <div className="video-actions" role="group" aria-label={`Quick actions for ${title}`}>
            {ORDER.filter((action) => actions.includes(action)).map((action) => (
                <QuickIconButton
                    key={action}
                    className={buttonClass(action, variant)}
                    ariaLabel={`${BUTTONS[action].label} for ${title}`}
                    label={BUTTONS[action].label}
                    icon={BUTTONS[action].icon}
                    busy={busy}
                    disabled={disabled}
                    onClick={() => onQuick(action)}
                />
            ))}
            {menu}
        </div>
    );
}
