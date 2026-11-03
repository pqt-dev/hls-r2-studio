#!/usr/bin/env node
// Post-build verification for `npm run dist:win`.
//   - release/*.exe installer exists and is plausibly large (> 80 MB)
//   - release/win-unpacked (when present) contains the bundled ffmpeg/ffprobe and the notices
//   - the bundled ffmpeg.exe / ffprobe.exe match the SHA-256 pinned in ffmpeg.lock.json
//   - app.asar does not contain smoke output, tests, source maps, scripts/ or node_modules/electron/
//   - writes release/SHA256SUMS.txt for the installer(s)
// Use `--unpacked-only` to check just the unpacked tree (after `electron-builder --win --dir`).
import asar from '@electron/asar';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(APP_DIR, 'release');
const UNPACKED = path.join(RELEASE_DIR, 'win-unpacked');
const MIN_INSTALLER_BYTES = 80 * 1024 * 1024;
const REQUIRED_IN_UNPACKED = [
    'resources/bin/ffmpeg.exe',
    'resources/bin/ffprobe.exe',
    'resources/LICENSES/THIRD-PARTY-NOTICES.txt',
    'resources/LICENSES/ffmpeg/LICENSE-GPL-3.0.txt',
    'resources/app.asar',
    // electron-builder renames Electron's LICENSE to LICENSE.electron.txt and leaves
    // LICENSES.chromium.html next to the executable (app-builder-lib ElectronFramework.js,
    // retainElectronLicenseFiles: on win/linux the destination is the app output dir itself).
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
];
const BINARIES = ['ffmpeg.exe', 'ffprobe.exe'];

const errors = [];

async function sha256(file) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

/** Pinned SHA-256 of the bundled binaries must match what ended up in the package. */
async function checkBundledBinaries() {
    const lock = JSON.parse(await readFile(path.join(APP_DIR, 'ffmpeg.lock.json'), 'utf8'));
    for (const name of BINARIES) {
        const pinned = lock.files.find((f) => f.dest === name)?.sha256;
        if (!pinned) {
            errors.push(`ffmpeg.lock.json has no sha256 for ${name}`);
            continue;
        }
        const full = path.join(UNPACKED, 'resources', 'bin', name);
        if (!existsSync(full)) continue; // already reported as missing
        const actual = await sha256(full);
        if (actual !== pinned) {
            errors.push(`${name} in the package does not match ffmpeg.lock.json (got ${actual})`);
        }
    }
}

/** Entries that must never be shipped inside app.asar. */
function forbiddenAsarReason(entry) {
    if (/(^|\/)out\/smoke(\/|$)/.test(entry) || /(^|\/)\.smoke-out(\/|$)/.test(entry)) {
        return 'smoke output';
    }
    if (entry.startsWith('node_modules/electron/')) return 'node_modules/electron/';
    // Third-party packages legitimately contain test-like files and maps; only the app's own
    // files (outside node_modules) are held to the stricter rules.
    if (entry.startsWith('node_modules/')) return null;
    if (/\.test\.[^/]+$/.test(entry)) return 'test file';
    if (/\.map$/.test(entry)) return 'source map';
    if (entry.startsWith('scripts/')) return 'scripts/';
    return null;
}

function checkAsarContents() {
    const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
    if (!existsSync(asarPath)) return; // already reported as missing
    const entries = asar
        .listPackage(asarPath, { isPack: false })
        .map((e) => e.replace(/\\/g, '/').replace(/^\//, ''));
    for (const entry of entries) {
        const reason = forbiddenAsarReason(entry);
        if (reason) errors.push(`app.asar contains a forbidden entry (${reason}): ${entry}`);
    }
}

async function checkUnpacked() {
    if (!existsSync(UNPACKED)) return false;
    for (const rel of REQUIRED_IN_UNPACKED) {
        const full = path.join(UNPACKED, rel);
        if (!existsSync(full)) errors.push(`missing in release/win-unpacked: ${rel}`);
        else if ((await stat(full)).size === 0)
            errors.push(`empty file in release/win-unpacked: ${rel}`);
    }
    await checkBundledBinaries();
    checkAsarContents();
    return true;
}

async function main() {
    const unpackedOnly = process.argv.includes('--unpacked-only');
    if (!existsSync(RELEASE_DIR)) {
        console.error('verify-dist: release/ does not exist; run the build first');
        process.exit(1);
    }
    const checkedUnpacked = await checkUnpacked();
    if (!checkedUnpacked) {
        console.warn('verify-dist: release/win-unpacked not found; skipping unpacked checks');
    }
    if (!unpackedOnly) {
        const installers = (await readdir(RELEASE_DIR)).filter((n) =>
            /^HLS-R2-Studio-Setup-.+\.exe$/.test(n),
        );
        if (installers.length === 0)
            errors.push('no release/HLS-R2-Studio-Setup-*.exe installer found');
        const lines = [];
        for (const name of installers) {
            const full = path.join(RELEASE_DIR, name);
            const { size } = await stat(full);
            if (size < MIN_INSTALLER_BYTES) {
                errors.push(`${name} is only ${size} bytes (< 80 MB): ffmpeg is probably missing`);
            }
            lines.push(`${await sha256(full)}  ${name}`);
        }
        if (lines.length > 0) {
            await writeFile(path.join(RELEASE_DIR, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
            console.log(`verify-dist: wrote release/SHA256SUMS.txt\n${lines.join('\n')}`);
        }
    }
    if (errors.length > 0) {
        for (const e of errors) console.error(`verify-dist: ${e}`);
        process.exit(1);
    }
    console.log('verify-dist: OK');
}

main().catch((e) => {
    console.error(`verify-dist: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
