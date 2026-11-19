import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './icons';

describe('BrandMark', () => {
    it('is decorative: an image with empty alt, hidden from assistive tech', () => {
        const { container } = render(<BrandMark />);
        const img = container.querySelector('img.brand-mark') as HTMLImageElement;

        expect(img).not.toBeNull();
        expect(img).toHaveAttribute('alt', '');
        expect(img).toHaveAttribute('aria-hidden', 'true');
        expect(img.getAttribute('src')).toBeTruthy();
        expect(container.querySelector('svg')).toBeNull();
        expect(container.textContent).toBe('');
    });

    it('sizes itself in rem through a custom property', () => {
        const { container } = render(
            <>
                <BrandMark size={2.25} />
                <BrandMark />
            </>,
        );
        const [first, second] = Array.from(
            container.querySelectorAll<HTMLImageElement>('img.brand-mark'),
        );

        expect(first!.style.getPropertyValue('--brand-size')).toBe('2.25rem');
        expect(second!.style.getPropertyValue('--brand-size')).toBe('1.75rem');
    });

    it('renders several instances independently', () => {
        const { container } = render(
            <>
                <BrandMark />
                <BrandMark />
            </>,
        );

        expect(container.querySelectorAll('img.brand-mark')).toHaveLength(2);
    });
});
