#!/usr/bin/env node
// Generates LICENSES/THIRD-PARTY-NOTICES.txt (a build artifact, git-ignored).
//
// Sources: the production npm dependency tree, the renderer libraries that Vite bundles into
// out/ (React, which live in devDependencies), Electron/Chromium (shipped by electron-builder
// next to the app as LICENSE.electron.txt and LICENSES.chromium.html), and the pinned FFmpeg build.
//
// The script FAILS (exit 1, nothing written) when any bundled package has an unknown license
// or a license outside the allow-list below, and prints the offending packages.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as checker from 'license-checker-rseidelsohn';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(APP_DIR, 'LICENSES', 'THIRD-PARTY-NOTICES.txt');

/** devDependencies whose code is bundled into out/ by Vite and therefore shipped. */
const BUNDLED_DEV_PACKAGES = ['react', 'react-dom', 'scheduler'];

/** Permissive licenses that can be redistributed in a closed internal app with notices. */
const ALLOWED = new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'BlueOak-1.0.0',
    'CC0-1.0',
    'Unlicense',
    'Python-2.0',
    'CC-BY-4.0',
]);

/**
 * Packages whose license-checker result carries a trailing `*` (license guessed from a file, not
 * declared in package.json) that were reviewed by hand. Key: "name@version", value: justification.
 * Keep this list empty unless a person has actually read the package's license.
 */
const REVIEWED_GUESSED_LICENSES = new Map([]);

function initChecker(options) {
    return new Promise((resolve, reject) => {
        checker.init({ start: APP_DIR, excludePrivatePackages: true, ...options }, (err, json) =>
            err ? reject(err) : resolve(json),
        );
    });
}

/** Evaluates a simple SPDX expression (OR / AND / parentheses) against the allow-list. */
function isAllowed(expression) {
    const tokens = String(expression)
        .replace(/[()]/g, ' ')
        .split(/\s+(OR|AND)\s+/i)
        .map((t) => t.trim())
        .filter(Boolean);
    const ors = [[]];
    for (const t of tokens) {
        if (/^OR$/i.test(t)) ors.push([]);
        else if (!/^AND$/i.test(t)) ors[ors.length - 1].push(t.replace(/\*$/, ''));
    }
    return ors.some((all) => all.length > 0 && all.every((l) => ALLOWED.has(l)));
}

async function readNoticeFiles(dir) {
    if (!dir || !existsSync(dir)) return '';
    const names = (await readdir(dir)).filter((n) => /^NOTICE(\.|$)/i.test(n));
    const parts = [];
    for (const n of names) parts.push((await readFile(path.join(dir, n), 'utf8')).trim());
    return parts.join('\n\n');
}

async function collectPackages() {
    const prod = await initChecker({ production: true });
    const all = await initChecker({});
    const result = { ...prod };
    for (const [id, info] of Object.entries(all)) {
        const name = id.slice(0, id.lastIndexOf('@'));
        if (BUNDLED_DEV_PACKAGES.includes(name) && !result[id]) result[id] = info;
    }
    return result;
}

async function main() {
    const packages = await collectPackages();
    const problems = [];
    const entries = [];
    for (const [id, info] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
        const license = Array.isArray(info.licenses) ? info.licenses.join(' AND ') : info.licenses;
        if (!license || !isAllowed(license)) problems.push(`${id}: ${license ?? 'UNKNOWN'}`);
        else if (String(license).includes('*') && !REVIEWED_GUESSED_LICENSES.has(id)) {
            problems.push(`${id}: ${license} (license guessed from a file, needs manual review)`);
        }
        const text =
            info.licenseFile && existsSync(info.licenseFile)
                ? (await readFile(info.licenseFile, 'utf8')).trim()
                : '';
        if (!text) problems.push(`${id}: no license file found in the package`);
        entries.push({
            id,
            license,
            repository: info.repository ?? '-',
            text,
            notice: await readNoticeFiles(info.path),
        });
    }
    if (problems.length > 0) {
        console.error('gen-notices: license problems found, refusing to generate notices:');
        for (const p of problems) console.error(`  - ${p}`);
        console.error(
            'Review each package; extend ALLOWED in scripts/gen-notices.mjs only after legal review.',
        );
        process.exit(1);
    }

    const electronVersion = JSON.parse(
        await readFile(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
    const lock = JSON.parse(await readFile(path.join(APP_DIR, 'ffmpeg.lock.json'), 'utf8'));

    const out = [];
    const rule = '='.repeat(78);
    out.push(
        'THIRD-PARTY NOTICES - HLS R2 Studio (desktop app)',
        '',
        'This application includes the components listed below.',
        '',
    );

    out.push(rule, '1. Electron and Chromium', rule, '');
    out.push(
        `Electron ${electronVersion} (MIT License, https://www.electronjs.org/) is bundled with this app.`,
        'The Electron license is installed next to the application executable in the file',
        '"LICENSE.electron.txt", and the licenses of Chromium and all libraries it contains are',
        'in the file "LICENSES.chromium.html" in the same folder.',
        '',
    );

    out.push(rule, '2. FFmpeg (GPL v3)', rule, '');
    out.push(
        `This application bundles FFmpeg ${lock.version} (ffmpeg.exe and ffprobe.exe) in the "bin" folder`,
        'of its resources. The build is a ' + lock.variant + ',',
        'licensed under the GNU General Public License version 3 (GPL-3.0).',
        '',
        `Binary source : ${lock.url}`,
        `Publisher page: ${lock.publisherPage} (lists the exact configure flags of the build)`,
        '',
        'FFmpeg runs as a separate executable process that the application starts with command line',
        'arguments. It is NOT linked into the application, and the application itself is not a',
        'derivative work of FFmpeg.',
        '',
        'The full GPL v3 license text is in LICENSES/ffmpeg/LICENSE-GPL-3.0.txt (installed in the',
        '"LICENSES" folder of the application resources), together with the build information',
        'file LICENSES/ffmpeg/README-gyan-build.txt (version and configuration).',
        '',
        'Source code offer: the complete corresponding source code of this FFmpeg version is',
        `available at ${lock.sourceUrl}`,
        `(build commit: ${lock.sourceCommit}).`,
        'The external libraries linked into the build (for example x264) are listed in the build',
        'information file and on the publisher page above. On request, the maintainers of this',
        'application will also provide the source for at least three years after distribution.',
        '',
    );

    // Group packages by identical license text so each text is printed once.
    const groups = new Map();
    for (const e of entries) {
        const key = createHash('sha256').update(e.text).digest('hex');
        if (!groups.has(key)) groups.set(key, { text: e.text, members: [] });
        groups.get(key).members.push(e);
    }
    out.push(rule, `3. npm packages (${entries.length})`, rule, '');
    for (const e of entries) out.push(`${e.id}  [${e.license}]  ${e.repository}`);
    out.push('');
    let n = 0;
    for (const g of groups.values()) {
        n += 1;
        out.push('-'.repeat(78), `License text ${n}/${groups.size}, applies to:`);
        for (const m of g.members) out.push(`  ${m.id}`);
        out.push('-'.repeat(78), '', g.text, '');
    }
    const notices = entries.filter((e) => e.notice);
    if (notices.length > 0) {
        out.push(rule, '4. NOTICE files of packages', rule, '');
        for (const e of notices) out.push(`--- ${e.id} ---`, e.notice, '');
    }

    await mkdir(path.dirname(OUT_FILE), { recursive: true });
    await writeFile(OUT_FILE, out.join('\n'));
    console.log(
        `gen-notices: wrote ${path.relative(APP_DIR, OUT_FILE)} (${entries.length} npm packages)`,
    );
}

main().catch((e) => {
    console.error(`gen-notices: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
