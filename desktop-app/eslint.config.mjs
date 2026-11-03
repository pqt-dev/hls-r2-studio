import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: [
            'src/main/**/*.ts',
            'src/preload/**/*.ts',
            'src/shared/**/*.ts',
            '*.ts',
            '*.mjs',
            'scripts/**/*.mjs',
        ],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['src/renderer/**/*.{ts,tsx}'],
        languageOptions: { globals: globals.browser },
    },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },
);
