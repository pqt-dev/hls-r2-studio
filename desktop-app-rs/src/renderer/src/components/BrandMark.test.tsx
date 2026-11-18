import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './icons';

describe('BrandMark', () => {
    it('is decorative and shows a gear (a tool), not a play triangle', () => {
        const { container } = render(<BrandMark />);
        const svg = container.querySelector('svg.brand-mark') as SVGElement;

        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg).toHaveAttribute('focusable', 'false');

        const gear = svg.querySelector('path.brand-gear') as SVGPathElement;
        const d = gear.getAttribute('d') ?? '';

        // 8 teeth x 4 corners = 32 vertices (1 move + 31 lines), plus a round centre hole (arcs).
        expect(gear).toHaveAttribute('fill-rule', 'evenodd');
        expect(d.match(/L/g)).toHaveLength(31);
        expect(d.match(/A/g)).toHaveLength(2);
        // The old mark was a play triangle ("M11 8.5v11l9-5.5z"); nothing like it remains.
        expect(container.innerHTML).not.toContain('M11 8.5');
        expect(svg.querySelectorAll('path')).toHaveLength(1);
        expect(svg.querySelectorAll('rect.brand-bar')).toHaveLength(0);
    });

    it('sizes itself in rem through a custom property', () => {
        const { container } = render(
            <>
                <BrandMark size={2.25} />
                <BrandMark />
            </>,
        );
        const [first, second] = Array.from(
            container.querySelectorAll<SVGElement>('svg.brand-mark'),
        );

        expect(first!.style.getPropertyValue('--brand-size')).toBe('2.25rem');
        expect(second!.style.getPropertyValue('--brand-size')).toBe('1.75rem');
        // No url() reference: the strict CSP checks forbid it in the sources.
        expect(container.innerHTML).not.toContain('url(');
    });
});
