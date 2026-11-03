#!/usr/bin/env node
// Fetches the pinned Windows x64 static GPL ffmpeg build described by ffmpeg.lock.json.
//
//   node scripts/fetch-ffmpeg.mjs            download (or reuse cache), verify, extract
//   node scripts/fetch-ffmpeg.mjs --force    re-extract even if resources/bin is up to date
//   node scripts/fetch-ffmpeg.mjs --bump <version>
//                                            download another version and print a lock
//                                            proposal to stdout (does NOT write anything;
//                                            cross-check the archive hash with the publisher)
//
// Env: FFMPEG_CACHE_DIR  directory used to cache the downloaded archive.
//
// Safety rules: the archive SHA-256 is verified BEFORE the archive is opened; only the
// whitelisted entries from the lock are written; entry names with traversal or absolute
// paths are rejected; nothing downloaded is ever executed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(APP_DIR, 'ffmpeg.lock.json');
const BIN_DIR = path.join(APP_DIR, 'resources', 'bin');
const LICENSE_DIR = path.join(APP_DIR, 'LICENSES', 'ffmpeg');

/** Partial files (`*.tmp`, `*.part`) that must not survive a failure. */
const pendingFiles = new Set();

function fail(message) {
    for (const f of pendingFiles) rmSync(f, { force: true });
    console.error(`fetch-ffmpeg: ${message}`);
    process.exit(1);
}

async function sha256File(file) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

async function readLock() {
    const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
    for (const key of ['version', 'url', 'sha256', 'archiveRoot', 'files']) {
        if (!lock[key]) fail(`ffmpeg.lock.json is missing "${key}"`);
    }
    if (!/^[0-9a-f]{64}$/.test(lock.sha256)) fail('ffmpeg.lock.json: sha256 is malformed');
    if (!lock.url.startsWith('https://')) fail('ffmpeg.lock.json: url must be https');
    return lock;
}

/** Maps archive entry name -> { dest, sha256 } for every whitelisted file. */
function buildWhitelist(lock) {
    const map = new Map();
    for (const f of lock.files) {
        const dest = path.join(f.kind === 'binary' ? BIN_DIR : LICENSE_DIR, f.dest);
        if (path.basename(f.dest) !== f.dest)
            fail(`lock dest must be a plain file name: ${f.dest}`);
        map.set(`${lock.archiveRoot}/${f.entry}`, { dest, sha256: f.sha256 });
    }
    return map;
}

async function isUpToDate(whitelist) {
    for (const { dest, sha256 } of whitelist.values()) {
        if (!existsSync(dest)) return false;
        if ((await sha256File(dest)) !== sha256) return false;
    }
    return true;
}

async function download(url, target) {
    console.log(`fetch-ffmpeg: downloading ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status}`);
    const part = `${target}.part`;
    pendingFiles.add(part);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    await rename(part, target);
    pendingFiles.delete(part);
}

async function ensureVerifiedArchive(url, expectedSha, cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    const archive = path.join(cacheDir, `${expectedSha}.zip`);
    if (existsSync(archive)) {
        if ((await sha256File(archive)) === expectedSha) {
            console.log(`fetch-ffmpeg: using cached archive ${archive}`);
            return archive;
        }
        console.warn('fetch-ffmpeg: cached archive is corrupt, re-downloading');
        await rm(archive, { force: true });
    }
    await download(url, archive);
    const actual = await sha256File(archive);
    if (actual !== expectedSha) {
        await rm(archive, { force: true });
        fail(`SHA-256 mismatch for ${url}\n  expected ${expectedSha}\n  actual   ${actual}`);
    }
    console.log('fetch-ffmpeg: archive SHA-256 verified');
    return archive;
}

/** True when a zip entry name could escape the extraction root or is not a plain relative path. */
function isUnsafeEntryName(name) {
    if (
        name.includes('\\') ||
        name.includes('\0') ||
        name.startsWith('/') ||
        /^[A-Za-z]:/.test(name)
    ) {
        return true;
    }
    return name.split('/').includes('..');
}

/** Extracts only whitelisted entries; returns Map<entryName, { dest, sha256 }> of what was written. */
function extractWhitelisted(archive, whitelist, outDirOf) {
    return new Promise((resolve, reject) => {
        yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
            if (err) return reject(err);
            const written = new Map();
            zip.on('error', reject);
            zip.on('end', () => resolve(written));
            zip.on('entry', (entry) => {
                const name = entry.fileName;
                if (isUnsafeEntryName(name)) {
                    zip.close();
                    return reject(new Error(`unsafe zip entry name rejected: ${name}`));
                }
                const wanted = whitelist.get(name);
                if (!wanted) return zip.readEntry();
                zip.openReadStream(entry, async (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    try {
                        const tmp = outDirOf(wanted.dest);
                        await mkdir(path.dirname(tmp), { recursive: true });
                        const hash = createHash('sha256');
                        stream.on('data', (chunk) => hash.update(chunk));
                        await pipeline(stream, createWriteStream(tmp));
                        written.set(name, { tmp, dest: wanted.dest, sha256: hash.digest('hex') });
                        zip.readEntry();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            zip.readEntry();
        });
    });
}

async function install(lock, whitelist, archive) {
    const tmpOf = (dest) => {
        pendingFiles.add(`${dest}.tmp`);
        return `${dest}.tmp`;
    };
    const written = await extractWhitelisted(archive, whitelist, tmpOf);
    for (const [name, { sha256 }] of whitelist) {
        const got = written.get(name);
        if (!got) fail(`archive does not contain the expected entry ${name}`);
        if (got.sha256 !== sha256) fail(`SHA-256 mismatch for extracted ${name}`);
    }
    for (const { tmp, dest } of written.values()) {
        await rename(tmp, dest);
        pendingFiles.delete(tmp);
    }
    await writeFile(path.join(BIN_DIR, 'FFMPEG-VERSION.txt'), `${lock.version}\n`);
    console.log(
        `fetch-ffmpeg: installed ffmpeg ${lock.version} into resources/bin and LICENSES/ffmpeg`,
    );
}

async function bump(version) {
    if (!/^\d+(\.\d+){1,2}$/.test(version)) fail('--bump expects a release version like 9.0.2');
    const root = `ffmpeg-${version}-essentials_build`;
    const url = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/${root}.zip`;
    const dir = path.join(os.tmpdir(), `ffmpeg-bump-${version}`);
    await mkdir(dir, { recursive: true });
    const archive = path.join(dir, `${root}.zip`);
    await download(url, archive);
    const sha = await sha256File(archive);
    const files = [
        { kind: 'binary', entry: 'bin/ffmpeg.exe', dest: 'ffmpeg.exe' },
        { kind: 'binary', entry: 'bin/ffprobe.exe', dest: 'ffprobe.exe' },
        { kind: 'license', entry: 'LICENSE', dest: 'LICENSE-GPL-3.0.txt' },
        { kind: 'license', entry: 'README.txt', dest: 'README-gyan-build.txt' },
    ];
    const wl = new Map(files.map((f) => [`${root}/${f.entry}`, { dest: path.join(dir, f.dest) }]));
    const written = await extractWhitelisted(archive, wl, (d) => d);
    for (const f of files) {
        const w = written.get(`${root}/${f.entry}`);
        if (!w) fail(`entry missing in archive: ${f.entry}`);
        f.sha256 = w.sha256;
    }
    const prev = await readLock();
    console.error(
        'Compare this archive hash with https://www.gyan.dev/ffmpeg/builds/ (release hashes)',
    );
    console.log(
        JSON.stringify({ ...prev, version, url, sha256: sha, archiveRoot: root, files }, null, 4),
    );
    await rm(dir, { recursive: true, force: true });
}

async function main() {
    const args = process.argv.slice(2);
    const bumpIdx = args.indexOf('--bump');
    if (bumpIdx !== -1) return bump(args[bumpIdx + 1] ?? '');
    const lock = await readLock();
    const whitelist = buildWhitelist(lock);
    if (!args.includes('--force') && (await isUpToDate(whitelist))) {
        console.log(`fetch-ffmpeg: ffmpeg ${lock.version} already installed and matches the lock`);
        return;
    }
    const cacheDir = process.env.FFMPEG_CACHE_DIR
        ? path.resolve(process.env.FFMPEG_CACHE_DIR)
        : path.join(os.homedir(), '.cache', 'hls-r2-studio-ffmpeg');
    const archive = await ensureVerifiedArchive(lock.url, lock.sha256, cacheDir);
    await install(lock, whitelist, archive);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
