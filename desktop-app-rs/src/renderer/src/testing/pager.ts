import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/** Waits until the (first) pager shows the given current page in its input. */
export const waitForPage = (page: number) =>
    waitFor(() =>
        expect(screen.getAllByRole('textbox', { name: 'Current page' })[0]).toHaveValue(
            String(page),
        ),
    );
