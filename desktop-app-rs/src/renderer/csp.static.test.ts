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
            // `url(#id)` is a same-document reference (SVG paint server), not a resource load.
            expect(text, file).not.toMatch(/@import|url\((?!#)/);
            // The only allowed <link> target is the inline PNG data-URI favicon.
            expect(text, file).not.toMatch(/<link[^>]+(src|href)=(?!["']data:image\/png;base64,)/i);
            // An <iframe> may only load a URL held in a variable (the site embed page, checked
            // against the signed-in site host), never a literal.
            expect(text, file).not.toMatch(/<iframe[^>]+src=["']/i);
            // An <img> may only load a URL held in a variable (CDN thumbnails), never a literal.
            expect(text, file).not.toMatch(/<img[^>]+src=["']/i);
        }
    });

    it('does not import Electron or Node modules in the renderer', () => {
        for (const file of files.filter((path) => /\.tsx?$/.test(path))) {
            expect(read(file), file).not.toMatch(/from 'electron'|from 'node:|require\(/);
        }
    });

    it('allows https only for images in the Tauri CSP', () => {
        const conf = JSON.parse(
            readFileSync(resolve(ROOT, '../../src-tauri/tauri.conf.json'), 'utf8'),
        ) as { app: { security: { csp: string; devCsp: string } } };

        for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
            expect(csp).toContain("img-src 'self' data: https:;");
            expect(csp.replace("img-src 'self' data: https:", '')).not.toContain('https:');
        }
    });

    it('frames nothing in the static Tauri CSP (the site origin is added at startup)', () => {
        const conf = JSON.parse(
            readFileSync(resolve(ROOT, '../../src-tauri/tauri.conf.json'), 'utf8'),
        ) as { app: { security: { csp: string; devCsp: string } } };

        for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
            expect(csp.match(/frame-src [^;]*/g)).toEqual(["frame-src 'none'"]);
            expect(csp).not.toContain('*');
        }
    });

    it('only frames an https URL held in a variable, and only after the user asks', () => {
        const source = readFileSync(resolve(ROOT, 'src/screens/VideoDetailPage.tsx'), 'utf8');

        expect(source).toContain('src={video.embedUrl}');
        expect(source).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
        expect(source).toContain('referrerPolicy="no-referrer"');
    });
});
