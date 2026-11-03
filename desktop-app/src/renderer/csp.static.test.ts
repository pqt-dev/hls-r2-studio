import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The strict production CSP forbids inline styles and remote resources: guard the sources. */
const ROOT = resolve(__dirname);

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);

        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const files = walk(ROOT).filter(
    (path) =>
        /\.(tsx?|css|html)$/.test(path) &&
        !/\.test\.tsx?$/.test(path) &&
        !path.includes(`${join('src', 'testing')}`) &&
        !path.endsWith('env.d.ts'),
);

// A placeholder shown as plain text (nothing is ever loaded from it).
const ALLOWED = ['https://your-site.example.com'];

function read(path: string): string {
    let text = readFileSync(path, 'utf8');

    for (const allowed of ALLOWED) text = text.split(allowed).join('');

    return text;
}

describe('renderer sources respect the strict CSP', () => {
    it('scans the expected files', () => {
        expect(files.some((file) => file.endsWith('index.html'))).toBe(true);
        expect(files.some((file) => file.endsWith('App.tsx'))).toBe(true);
        expect(files.some((file) => file.endsWith('styles.css'))).toBe(true);
    });

    it('has no inline style attributes or <style> elements', () => {
        for (const file of files) {
            const text = read(file);

            expect(text, file).not.toMatch(/\bstyle\s*=/);
            expect(text, file).not.toMatch(/<style[\s>]/i);
            expect(text, file).not.toMatch(/dangerouslySetInnerHTML/);
        }
    });

    it('references no external URLs, fonts or CDNs', () => {
        for (const file of files) {
            const text = read(file);

            expect(text, file).not.toMatch(/https?:\/\/[A-Za-z0-9]/);
            expect(text, file).not.toMatch(/@import|url\(/);
            expect(text, file).not.toMatch(/<(link|img|iframe)[^>]+(src|href)=/i);
        }
    });

    it('does not import Electron or Node modules in the renderer', () => {
        for (const file of files.filter((path) => /\.tsx?$/.test(path))) {
            expect(read(file), file).not.toMatch(/from 'electron'|from 'node:|require\(/);
        }
    });
});
