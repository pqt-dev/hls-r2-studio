import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './icons';

describe('BrandMark', () => {
    it('is decorative: a gradient tile, a film frame and two segment blocks', () => {
        const { container } = render(<BrandMark />);
        const svg = container.querySelector('svg.brand-mark') as SVGElement;

        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg).toHaveAttribute('focusable', 'false');
        expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
        expect(svg.querySelectorAll('rect.brand-tile')).toHaveLength(1);
        expect(svg.querySelectorAll('linearGradient')).toHaveLength(1);
        // One film frame (play triangle cut out) and two filled segment blocks, no strokes.
        expect(svg.querySelectorAll('path.brand-ink')).toHaveLength(1);
        expect(svg.querySelectorAll('rect.brand-ink')).toHaveLength(2);
        expect(svg.querySelector('path.brand-ink')).toHaveAttribute('fill-rule', 'evenodd');
        expect(svg.querySelector('[stroke]')).toBeNull();
        expect(svg.querySelector('text')).toBeNull();
    });

    it('fills the tile with its own gradient', () => {
        const { container } = render(<BrandMark />);
        const gradient = container.querySelector('linearGradient') as Element;
        const tile = container.querySelector('rect.brand-tile') as Element;

        expect(tile.getAttribute('fill')).toBe(`url(#${gradient.id})`);
    });

    it('uses unique gradient ids across instances', () => {
        const { container } = render(
            <>
                <BrandMark />
                <BrandMark />
            </>,
        );
        const gradients = Array.from(container.querySelectorAll('linearGradient'));
        const tiles = Array.from(container.querySelectorAll('rect.brand-tile'));

        expect(gradients).toHaveLength(2);
        expect(gradients[0]!.id).not.toBe(gradients[1]!.id);
        expect(tiles[0]!.getAttribute('fill')).toBe(`url(#${gradients[0]!.id})`);
        expect(tiles[1]!.getAttribute('fill')).toBe(`url(#${gradients[1]!.id})`);
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
    });
});
