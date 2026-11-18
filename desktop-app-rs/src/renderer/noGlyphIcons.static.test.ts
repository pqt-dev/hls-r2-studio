import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Icons are Fluent SVGs: no text or unicode glyph may stand in for an icon in the UI sources. */
const ROOT = resolve(__dirname);

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);

        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const files = walk(ROOT).filter(
    (path) =>
        /\.(tsx?|css)$/.test(path) &&
        !/\.test\.tsx?$/.test(path) &&
        !path.includes(join('src', 'testing')) &&
        !path.endsWith('fluentIcons.ts'),
);

// Check, cross, arrows, triangles, circles, bullets, stars, warning/info signs, multiplication sign.
const GLYPHS = /[←-⇿••■-◿☀-➿⬀-⯿×⋮⋯‖]/u;
// Emoji (pictographs, symbols, flags).
const EMOJI = /[\u{1f000}-\u{1faff}]/u;

describe('renderer sources use SVG icons, not glyphs', () => {
    it('scans the UI files', () => {
        expect(files.some((file) => file.endsWith('Toasts.tsx'))).toBe(true);
        expect(files.some((file) => file.endsWith('jobState.ts'))).toBe(true);
    });

    it('has no glyph-as-icon characters or emoji', () => {
        for (const file of files) {
            const text = readFileSync(file, 'utf8');

            expect(GLYPHS.test(text), file).toBe(false);
            expect(EMOJI.test(text), file).toBe(false);
        }
    });
});
