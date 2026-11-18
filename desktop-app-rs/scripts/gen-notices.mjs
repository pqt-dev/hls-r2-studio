#!/usr/bin/env node
// Generates LICENSES/THIRD-PARTY-NOTICES.txt (a build artifact, git-ignored). The Tauri bundle
// installs it at <install dir>\LICENSES\THIRD-PARTY-NOTICES.txt, where `app_open_notices` looks
// (see src-tauri/src/ipc/notices.rs and src-tauri/tauri.bundle.conf.json).
//
// Sources:
//   1. Rust crates compiled into the app: `cargo metadata` (Windows target, normal dependencies
//      reachable from the app crate; dev/build-only crates are not shipped).
//   2. npm packages bundled by Vite into dist/ (a fixed list, see BUNDLED_NPM_PACKAGES).
//   3. The pinned FFmpeg build (ffmpeg.lock.json), GPL v3.
//
// The script FAILS (exit 1, nothing written) when a Rust crate declares no license at all or a
// bundled npm package has no license. A crate that declares a license but ships no license file
// is listed with its SPDX expression only and reported on stderr.
//
// Usage: node scripts/gen-notices.mjs   (needs `cargo` on PATH and `npm ci` already run)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = path.join(APP_DIR, 'src-tauri');
const OUT_FILE = path.join(APP_DIR, 'LICENSES', 'THIRD-PARTY-NOTICES.txt');
const CARGO_TARGET = 'x86_64-pc-windows-msvc';

/**
 * npm packages whose code Vite bundles into dist/ (everything the renderer imports at run time:
 * react, react-dom (+ its scheduler) and the Tauri JS API). Test-only packages are not shipped.
 */
const BUNDLED_NPM_PACKAGES = ['react', 'react-dom', 'scheduler', '@tauri-apps/api'];

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|UNLICENSE|NOTICE)([-._].*)?$/i;

function fail(message) {
    console.error(`gen-notices: ${message}`);
    process.exit(1);
}

/** Text of every license/notice file directly inside `dir` (sorted by name). */
async function readLicenseFiles(dir) {
    if (!dir || !existsSync(dir)) return [];
    const names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && LICENSE_FILE_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    const files = [];
    for (const name of names) {
        const text = (await readFile(path.join(dir, name), 'utf8')).trim();
        if (text) files.push({ name, text });
    }
    return files;
}

function rustCrates() {
    const json = execFileSync(
        'cargo',
        ['metadata', '--format-version', '1', '--locked', '--filter-platform', CARGO_TARGET],
        { cwd: TAURI_DIR, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const meta = JSON.parse(json);
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const root = meta.resolve.root;
    if (!root) fail('cargo metadata returned no root package');

    // Walk normal (non dev, non build) dependencies from the app crate.
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length > 0) {
        const node = nodes.get(stack.pop());
        for (const dep of node?.deps ?? []) {
            if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
            if (seen.has(dep.pkg)) continue;
            seen.add(dep.pkg);
            stack.push(dep.pkg);
        }
    }
    seen.delete(root);
    return [...seen].map((id) => byId.get(id)).filter((p) => p && p.source !== null);
}

async function collectRust() {
    const entries = [];
    const problems = [];
    const sorted = rustCrates().sort(
        (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
    for (const pkg of sorted) {
        const dir = path.dirname(pkg.manifest_path);
        const license = pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : null);
        if (!license) {
            problems.push(`${pkg.name}@${pkg.version}: no license declared`);
            continue;
        }
        entries.push({
            id: `${pkg.name}@${pkg.version}`,
            license,
            repository: pkg.repository ?? pkg.homepage ?? '-',
            files: await readLicenseFiles(dir),
        });
    }
    return { entries, problems };
}

async function collectNpm() {
    const entries = [];
    const problems = [];
    for (const name of BUNDLED_NPM_PACKAGES) {
        const dir = path.join(APP_DIR, 'node_modules', ...name.split('/'));
        if (!existsSync(path.join(dir, 'package.json'))) {
            problems.push(`${name}: not installed (run npm ci first)`);
            continue;
        }
        const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
        const files = await readLicenseFiles(dir);
        if (!pkg.license) problems.push(`${name}@${pkg.version}: no license declared`);
        if (files.length === 0) problems.push(`${name}@${pkg.version}: no license file found`);
        entries.push({
            id: `${name}@${pkg.version}`,
            license: pkg.license ?? 'UNKNOWN',
            repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '-'),
            files,
        });
    }
    return { entries, problems };
}

/** Groups entries by identical license text (all files of an entry joined) so each text prints once. */
function groupByText(entries) {
    const groups = new Map();
    for (const e of entries) {
        const text = e.files.map((f) => f.text).join('\n\n');
        if (!text) continue;
        const key = createHash('sha256').update(text).digest('hex');
        if (!groups.has(key)) groups.set(key, { text, members: [] });
        groups.get(key).members.push(e);
    }
    return [...groups.values()];
}

function printEntries(out, rule, title, entries) {
    out.push(rule, `${title} (${entries.length})`, rule, '');
    for (const e of entries) out.push(`${e.id}  [${e.license}]  ${e.repository}`);
    out.push('');
    const groups = groupByText(entries);
    groups.forEach((g, i) => {
        out.push('-'.repeat(78), `License text ${i + 1}/${groups.length}, applies to:`);
        for (const m of g.members) out.push(`  ${m.id}`);
        out.push('-'.repeat(78), '', g.text, '');
    });
    const without = entries.filter((e) => e.files.length === 0);
    if (without.length > 0) {
        out.push(
            'The following packages declare the license shown above but ship no license file;',
            'their license is identified by the SPDX expression only:',
        );
        for (const e of without) out.push(`  ${e.id}  [${e.license}]`);
        out.push('');
    }
}

async function main() {
    const rust = await collectRust();
    const npm = await collectNpm();
    const problems = [...rust.problems, ...npm.problems];
    if (problems.length > 0) {
        console.error('gen-notices: license problems found, refusing to generate notices:');
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    for (const e of [...rust.entries, ...npm.entries]) {
        if (e.files.length === 0) console.warn(`gen-notices: warning: no license file for ${e.id}`);
    }

    const lock = JSON.parse(await readFile(path.join(APP_DIR, 'ffmpeg.lock.json'), 'utf8'));
    const rule = '='.repeat(78);
    const out = [
        'THIRD-PARTY NOTICES - HLS R2 Studio (desktop app)',
        '',
        'This application includes the components listed below.',
        '',
        rule,
        '1. Microsoft Edge WebView2',
        rule,
        '',
        'The user interface is rendered by the Microsoft Edge WebView2 runtime, which is NOT part of',
        'this package: it is provided by Windows (or installed by the installer from Microsoft) and',
        'is licensed by Microsoft under its own terms.',
        '',
        rule,
        '2. FFmpeg (GPL v3)',
        rule,
        '',
        `This application bundles FFmpeg ${lock.version} (ffmpeg.exe and ffprobe.exe) in the "bin" folder`,
        `next to the application executable. The build is a ${lock.variant},`,
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
        '"LICENSES" folder next to the application executable), together with the build information',
        'file LICENSES/ffmpeg/README-gyan-build.txt (version and configuration).',
        '',
        'Source code offer: the complete corresponding source code of this FFmpeg version is',
        `available at ${lock.sourceUrl}`,
        `(build commit: ${lock.sourceCommit}).`,
        'The external libraries linked into the build (for example x264) are listed in the build',
        'information file and on the publisher page above. On request, the maintainers of this',
        'application will also provide the source for at least three years after distribution.',
        '',
    ];

    printEntries(out, rule, '3. Rust crates', rust.entries);
    printEntries(out, rule, '4. npm packages bundled in the user interface', npm.entries);

    // Icon artwork copied into the UI source (not an npm dependency): see LICENSES/fluent-system-icons.
    const fluentDir = path.join(APP_DIR, 'LICENSES', 'fluent-system-icons');
    const fluentLicense = (await readFile(path.join(fluentDir, 'LICENSE-MIT.txt'), 'utf8')).trim();
    out.push(
        rule,
        '5. Fluent System Icons (MIT)',
        rule,
        '',
        'The icons in the user interface are taken from Microsoft Fluent System Icons',
        '(https://github.com/microsoft/fluentui-system-icons, npm package @fluentui/svg-icons@1.1.345).',
        '',
        fluentLicense,
        '',
    );

    await mkdir(path.dirname(OUT_FILE), { recursive: true });
    await writeFile(OUT_FILE, out.join('\n'));
    console.log(
        `gen-notices: wrote ${path.relative(APP_DIR, OUT_FILE)} ` +
            `(${rust.entries.length} Rust crates, ${npm.entries.length} npm packages)`,
    );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
