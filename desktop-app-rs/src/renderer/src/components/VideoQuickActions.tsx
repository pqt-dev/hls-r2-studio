import { useRef, useState, type ReactNode } from 'react';
import { LinkIcon, OpenExternalIcon, ShortcodeIcon } from './icons';
import { useApp } from '../state/AppProvider';
import { useToast } from '../state/Toasts';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** Quick actions of a ready video: Rust builds the text and copies/opens, never the renderer. */
export type QuickAction = 'shortcode' | 'embed-url' | 'open';

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
                else
                    toast.show(
                        'success',
                        action === 'shortcode' ? 'Shortcode copied.' : 'Embed URL copied.',
                    );
            })
            .catch(() => toast.show('error', GENERIC_ERROR))
            .finally(() => {
                busy.current.delete(id);
                setBusyIds(new Set(busy.current));
            });
    }

    return { busyIds, run };
}

/** The one quick action kept on a card footer: copy the shortcode (the rest live in the kebab menu). */
export function QuickShortcodeButton({
    title,
    busy,
    onQuick,
}: {
    title: string;
    busy: boolean;
    onQuick: (action: QuickAction) => void;
}) {
    return (
        <button
            type="button"
            className="btn btn-sm btn-text video-quick video-quick-ghost"
            aria-label={`Copy shortcode for ${title}`}
            title="Copy shortcode"
            aria-busy={busy}
            disabled={busy}
            onClick={() => onQuick('shortcode')}
        >
            <ShortcodeIcon />
        </button>
    );
}

/** The three icon buttons (copy shortcode, copy embed URL, open) of one ready video. */
export function QuickActionButtons({
    title,
    busy,
    onQuick,
    variant = 'accent',
}: {
    /** `ghost`: quiet transparent icon buttons for dense rows (Home). */
    variant?: 'accent' | 'ghost';
    title: string;
    /** A quick action of this video is in flight: its buttons are disabled. */
    busy: boolean;
    onQuick: (action: QuickAction) => void;
}) {
    const button = (action: QuickAction, label: string, icon: ReactNode) => (
        <button
            type="button"
            className={
                variant === 'ghost'
                    ? 'btn btn-sm btn-text video-quick video-quick-ghost'
                    : 'btn btn-sm btn-accent-share video-quick'
            }
            aria-label={`${label} for ${title}`}
            title={label}
            aria-busy={busy}
            disabled={busy}
            onClick={() => onQuick(action)}
        >
            {icon}
        </button>
    );

    return (
        <div className="video-actions" role="group" aria-label={`Quick actions for ${title}`}>
            {button('shortcode', 'Copy shortcode', <ShortcodeIcon />)}
            {button('embed-url', 'Copy embed URL', <LinkIcon />)}
            {button('open', 'Open in browser', <OpenExternalIcon />)}
        </div>
    );
}
