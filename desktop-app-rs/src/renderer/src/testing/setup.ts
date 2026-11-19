import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
    cleanup();
    // UI preferences live in localStorage: every test starts from the defaults.
    window.localStorage.clear();
});
