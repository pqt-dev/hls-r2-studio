import {
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { MoreIcon } from './icons';

export interface ActionMenuItem {
    key: string;
    label: string;
    /** Accessible name when it should be more specific than the visible label. */
    ariaLabel?: string;
    icon?: ReactNode;
    danger?: boolean;
    disabled?: boolean;
    /** Id of an element that explains why the item is disabled. */
    describedBy?: string;
    title?: string;
    onSelect: () => void;
}

/**
 * Overflow (kebab) menu with a keyboard-friendly list: ArrowUp/Down move, Escape closes and returns
 * the focus to the trigger. Shares its look with the card menu (`.video-menu*` classes).
 */
export function ActionMenu({
    label,
    items,
    disabled,
    triggerRef,
}: {
    label: string;
    items: ActionMenuItem[];
    disabled?: boolean;
    triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
    const [open, setOpen] = useState(false);
    const [up, setUp] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const ownTrigger = useRef<HTMLButtonElement>(null);
    const trigger = triggerRef ?? ownTrigger;
    const menuId = useId();

    useEffect(() => {
        if (!open) return;

        function onPointerDown(event: PointerEvent): void {
            if (event.target instanceof Node && !root.current?.contains(event.target)) {
                setOpen(false);
            }
        }

        document.addEventListener('pointerdown', onPointerDown, true);

        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [open]);

    // Opens upward when the list would run past the bottom of the scrolling panel (or the window),
    // so the last rows of a long list never cut it off. The sticky footer height is left free.
    useLayoutEffect(() => {
        if (!open) {
            setUp(false);

            return;
        }

        const list = root.current?.querySelector<HTMLElement>('[role="menu"]');
        const button = trigger.current;

        if (list === null || list === undefined || button === null) return;

        const panel = root.current?.closest<HTMLElement>('.panel');
        const bottom = Math.min(
            window.innerHeight,
            panel?.getBoundingClientRect().bottom ?? window.innerHeight,
        );
        const need = list.getBoundingClientRect().height + 8;
        const below = bottom - 48 - button.getBoundingClientRect().bottom;
        const above =
            button.getBoundingClientRect().top - (panel?.getBoundingClientRect().top ?? 0);

        setUp(need > below && above > below);
    }, [open, trigger]);

    // The first item takes the focus when the menu opens.
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [open]);

    function onKeyDown(event: KeyboardEvent): void {
        if (!open) return;

        const nodes = Array.from(
            root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
        );
        const index = nodes.indexOf(document.activeElement as HTMLElement);

        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();

            const step = event.key === 'ArrowDown' ? 1 : -1;

            nodes[(index + step + nodes.length) % nodes.length]?.focus();
        } else if (event.key === 'Tab') {
            setOpen(false);
        }
    }

    return (
        <div ref={root} className="video-menu" onKeyDown={onKeyDown}>
            <button
                ref={trigger}
                type="button"
                className="btn btn-sm video-quick"
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
            >
                <MoreIcon />
            </button>
            {open && (
                <div
                    id={menuId}
                    role="menu"
                    className={`video-menu-list${up ? ' is-up' : ''}`}
                    aria-label={label}
                >
                    {items.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            role="menuitem"
                            className={`video-menu-item${item.danger === true ? ' video-menu-danger' : ''}`}
                            title={item.title}
                            aria-label={item.ariaLabel}
                            aria-disabled={item.disabled === true ? true : undefined}
                            aria-describedby={item.describedBy}
                            onClick={() => {
                                if (item.disabled === true) return;

                                setOpen(false);
                                trigger.current?.focus();
                                item.onSelect();
                            }}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
