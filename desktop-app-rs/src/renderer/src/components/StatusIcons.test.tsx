import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_ICON, type StatusKind } from '../lib/jobState';
import { ToastProvider, useToast } from '../state/Toasts';
import { Banner } from './Banner';
import { Feedback } from './Feedback';
import { FLUENT } from './fluentIcons';
import { StatusIcon } from './icons';

const KINDS: StatusKind[] = [
    'waiting',
    'running',
    'done',
    'failed',
    'attention',
    'paused',
    'cancelled',
];

describe('icons replace glyphs', () => {
    it.each(KINDS)('the %s status has a Fluent icon', (kind) => {
        expect(Object.hasOwn(FLUENT, STATUS_ICON[kind])).toBe(true);

        const { container } = render(<StatusIcon kind={kind} />);

        expect(container.querySelector('svg.icon path')).not.toBeNull();
        expect(container).toHaveTextContent('');
    });

    it.each(['info', 'warning', 'danger'] as const)('the %s banner draws an SVG icon', (tone) => {
        const { container } = render(<Banner tone={tone} title="Heads up" />);

        expect(container.querySelector('.banner-icon svg.icon')).not.toBeNull();
        expect(container.querySelector('.banner-icon')).toHaveTextContent('');
    });

    it('inline feedback shows an icon, and the text stays the accessible message', () => {
        const { container } = render(<Feedback message={{ kind: 'success', text: 'Saved.' }} />);

        expect(container.querySelector('svg.icon')).not.toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    });

    it('toasts use SVG icons for their kind and for the close button', async () => {
        function Trigger() {
            const toast = useToast();

            return (
                <button type="button" onClick={() => toast.show('success', 'Done it.')}>
                    go
                </button>
            );
        }

        render(
            <ToastProvider>
                <Trigger />
            </ToastProvider>,
        );
        await act(async () => screen.getByRole('button', { name: 'go' }).click());

        expect(document.querySelector('.toast-icon svg.icon')).not.toBeNull();
        expect(
            screen.getByRole('button', { name: 'Dismiss notification' }).querySelector('svg.icon'),
        ).not.toBeNull();
    });
});
