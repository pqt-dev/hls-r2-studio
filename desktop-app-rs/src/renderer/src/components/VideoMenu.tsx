import { useRef } from 'react';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { CheckboxIcon, InfoIcon, LinkIcon, OpenExternalIcon, TrashIcon } from './icons';
import type { QuickAction } from './VideoQuickActions';

/**
 * Kebab menu of one video card. A ready video offers Copy direct URL and Open in browser first;
 * then Details (opens the detail page, where renaming and the thumbnail are managed) and Delete (the
 * caller asks for confirmation first). Select (first) starts multi-select with this video picked.
 * Select and Delete are optional: the caller omits them where they do not apply (Home). Built on
 * the shared ActionMenu.
 */
export function VideoMenu({
    title,
    busy,
    disabled = false,
    ready,
    onQuick,
    onOpen,
    onDelete,
    onSelect,
}: {
    title: string;
    busy: boolean;
    /** The row is inert (being deleted): the trigger is disabled. */
    disabled?: boolean;
    /** Only a ready video has a direct URL to copy or open. */
    ready: boolean;
    onQuick: (action: QuickAction) => void;
    onOpen: (opener: HTMLButtonElement) => void;
    /** Without it there is no Delete item (Home). */
    onDelete?: () => void;
    /** Enters the Library's select mode with this video picked; without it there is no Select item. */
    onSelect?: () => void;
}) {
    const trigger = useRef<HTMLButtonElement>(null);
    const items: ActionMenuItem[] = [
        ...(onSelect === undefined
            ? []
            : [
                  {
                      key: 'select',
                      label: 'Select',
                      icon: <CheckboxIcon state="none" />,
                      onSelect,
                  },
              ]),
        ...(ready
            ? [
                  {
                      key: 'embed-url',
                      label: 'Copy direct URL',
                      ariaLabel: `Copy direct URL for ${title}`,
                      icon: <LinkIcon />,
                      onSelect: () => onQuick('embed-url'),
                  },
                  {
                      key: 'open',
                      label: 'Open in browser',
                      ariaLabel: `Open in browser for ${title}`,
                      icon: <OpenExternalIcon />,
                      onSelect: () => onQuick('open'),
                  },
              ]
            : []),
        {
            key: 'details',
            label: 'Details',
            icon: <InfoIcon />,
            onSelect: () => {
                if (trigger.current !== null) onOpen(trigger.current);
            },
        },
        ...(onDelete === undefined
            ? []
            : [
                  {
                      key: 'delete',
                      label: 'Delete',
                      icon: <TrashIcon />,
                      danger: true,
                      onSelect: onDelete,
                  },
              ]),
    ];

    return (
        <ActionMenu
            label={`More actions for ${title}`}
            disabled={busy || disabled}
            triggerRef={trigger}
            items={items}
        />
    );
}
