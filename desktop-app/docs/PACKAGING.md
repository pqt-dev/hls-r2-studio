# Packaging the Windows installer

The installer is a single NSIS `.exe` (per-user, no admin prompt) that contains the app, Electron,
`ffmpeg.exe`, `ffprobe.exe` and the legal notices. The target machine needs nothing else.

## IMPORTANT: where things are validated

The installer build and all Windows-specific checks happen ONLY on Windows (a developer machine or
the GitHub Actions `windows-latest` runner). The packaging configuration (`electron-builder.yml`,
icon, `extraResources`, NSIS options) was NOT executed on macOS/Linux during development, so any
configuration problem will surface for the first time in CI. The workflow therefore runs
`electron-builder --win --dir` before the NSIS build and always uploads a listing of
`release/win-unpacked`, so a failed run still shows what was packed.

## Build locally on Windows

Prerequisites: Node.js 24 and npm. Nothing else (no ffmpeg, no Wine).

```
cd desktop-app
npm ci --ignore-scripts
npm run dist:win
node scripts/verify-dist.mjs
```

`npm run dist:win` first runs `predist:win` (`fetch:ffmpeg` then `gen:notices`), then builds the
app and runs `electron-builder --win nsis --x64`. Output: `release/HLS-R2-Studio-Setup-<version>.exe`;
`verify-dist.mjs` checks the files and writes `release/SHA256SUMS.txt`.
`npm run pack` produces only the unpacked app (`release/win-unpacked`).

### Install scripts are disabled (`.npmrc`)

`desktop-app/.npmrc` sets `ignore-scripts=true` (a nested `package.json` does not inherit the repo-root
`.npmrc`), so a compromised dependency cannot run code at install time. Electron's own download script is
skipped too. `build`, `typecheck`, `lint`, `test`, `pack` and `dist:win` do not need the Electron binary
(electron-builder downloads its own copy). Local development with `npm run dev` needs it once:
`npx install-electron` (Electron 45 exposes the `install-electron` bin).

`.npmrc` also sets `replace-registry-host=always`: `package-lock.json` stores `resolved` URLs on
`https://registry.npmjs.org/`, and this setting makes npm fetch from the registry configured on the machine
(a developer proxy or mirror) instead of whatever host was baked into the lockfile. The integrity hashes in
the lockfile still apply, so the content is verified either way.

## Build in CI

Workflow: `.github/workflows/desktop-app-windows.yml`.

- Pull requests touching `desktop-app/**`: checks only (typecheck, lint, tests); no installer.
- `workflow_dispatch` and tags `desktop-v*`: checks, `electron-builder --win --dir`, unpacked-tree
  listing artifact (uploaded even on failure), NSIS installer, `verify-dist.mjs`, artifact upload
  (installer + `SHA256SUMS.txt`).
- Tag pushes additionally create a DRAFT GitHub Release with those files (`gh release create`,
  `contents: write` only on that job). Publish the draft manually after the verification checklist.
- The integration tests run on real Windows against the real bundled ffmpeg
  (`FFMPEG_PATH`/`FFPROBE_PATH` point to `resources/bin`).
- No secrets are used and nothing is signed.
- All actions are pinned by full commit SHA (with a `# vX.Y.Z` comment); `.github/dependabot.yml` opens weekly
  grouped PRs for the actions and for the `desktop-app` npm dependencies. `actions/checkout` runs with
  `persist-credentials: false`. Dependencies are installed with `npm ci --ignore-scripts`.
- Build artifacts are named `hls-r2-studio-windows-<commit sha>` and kept for 14 days.
- On tag pushes the workflow fails unless the tag equals `desktop-v<version in desktop-app/package.json>`.

### Release procedure

1. Bump `version` in `desktop-app/package.json` and commit it.
2. `git tag desktop-vX.Y.Z` (X.Y.Z must equal that version) and `git push origin desktop-vX.Y.Z`.
3. Wait for the workflow; review the DRAFT GitHub Release (installer + `SHA256SUMS.txt`).
4. Run the manual verification checklist below on a clean Windows VM.
5. Publish the draft release.

Recommendation: create a GitHub tag ruleset for `desktop-v*` (repository Settings > Rules > Rulesets > New
ruleset > New tag ruleset; target `desktop-v*`; restrict creations/updates/deletions to maintainers and block
force pushes), so only trusted people can trigger a release build.

### Build provenance (not enabled)

Build provenance attestations (`actions/attest-build-provenance`) are only available for public repositories
or GitHub Enterprise Cloud. They can be added to the build job if this repository becomes public.

## How ffmpeg is pinned

`ffmpeg.lock.json` pins the build: gyan.dev "essentials" 9.0.2 (Windows x64, static, GPL v3)
as mirrored on GitHub releases, the archive SHA-256, and the SHA-256 of every extracted file.
`scripts/fetch-ffmpeg.mjs`:

1. verifies the archive SHA-256 BEFORE opening it (hard fail on mismatch);
2. extracts only `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `LICENSE`, `README.txt` (using `yauzl`, no
   shell-out), rejecting entry names with `..`, absolute paths, drive letters or backslashes;
3. verifies each extracted file against the lock, then moves it into place;
4. writes to `resources/bin/` (binaries) and `LICENSES/ffmpeg/` (license + build info);
5. skips everything when the installed files already match the lock (`--force` to redo);
6. deletes any partial `*.tmp` / `*.part` file when it fails.

`FFMPEG_CACHE_DIR` sets the archive cache (default `~/.cache/hls-r2-studio-ffmpeg`). Downloaded
binaries are never executed by the scripts. The app's startup self-check (ffmpeg encoders/filters)
is the runtime safety net.

Note: GitHub release assets of this repository are not marked immutable, which is why the SHA-256 pin
(and the publisher's published checksum at gyan.dev) is the integrity guarantee, not the URL.

### Bump procedure

1. Pick a release version from https://www.gyan.dev/ffmpeg/builds/ (prefer numbered releases that match an
   ffmpeg.org source tarball over git snapshots).
2. `node scripts/fetch-ffmpeg.mjs --bump <version>` prints a lock proposal (nothing is written).
3. Cross-check the printed archive `sha256` with the checksum published by gyan.dev
   (`https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256` for the latest release) and
   with the GitHub release asset digest.
4. Update `ffmpeg.lock.json` (`version`, `url`, `sha256`, `archiveRoot`, `sourceUrl`, `sourceCommit`
   from the build's `README.txt`, file hashes).
5. Read the new `README.txt` configuration: it must still list libx264, the aac encoder, the hls muxer,
   and the filters scale, thumbnail, signalstats, edgedetect, hstack, tile, crop, fps, movie.
6. Run `npm run fetch:ffmpeg` and `npm test` with `FFMPEG_PATH`/`FFPROBE_PATH` set (or let CI do it).

## Licenses

- FFmpeg here is a GPL v3 build, used as a separate executable (not linked). Obligations: ship the GPL
  text and the notices, and keep the source-code offer. `npm run gen:notices` writes
  `LICENSES/THIRD-PARTY-NOTICES.txt` (npm packages incl. the React libraries bundled by Vite, Electron/
  Chromium pointers, FFmpeg section with the source offer `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`).
  The installer includes `LICENSES/` under the app resources; electron-builder also ships Electron's
  license as `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable. Never remove these from the installer.
- `gen:notices` uses `license-checker-rseidelsohn` and FAILS on unknown licenses or licenses outside an
  allow-list of permissive ones (MIT, ISC, BSD, Apache-2.0, 0BSD, ...), and on licenses that license-checker only
  guessed from a file (trailing `*`) unless the package is in the reviewed list in the script. Resolve by
  review, not by silently extending the lists.
- `THIRD-PARTY-NOTICES.txt` and `LICENSES/ffmpeg/*` are generated build artifacts and are git-ignored.
- The About screen must show these notices and the ffmpeg version.

## Electron fuses

`electron-builder.yml` flips these fuses on the packaged executable (`electronFuses`):
`runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`,
`enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`, `enableCookieEncryption: true`.
They stop `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `--inspect` abuse and make Electron only load a validated
`app.asar`. The app does not use `child_process.fork` from the main process (ffmpeg is spawned as its own
executable), so `runAsNode: false` is safe.

`grantFileProtocolExtraPrivileges` is deliberately NOT set (Electron's default stays): the renderer is a Vite
build loaded via `loadFile` (`file://`) with `<script type="module" crossorigin>`, and disabling the fuse
risks a blank window. Revisit it only together with serving the renderer from a custom protocol. These
fuses were not exercised on Windows during development: see item 10 of the checklist.

## GPL obligations when distributing outside the organization

The bundled gyan.dev "essentials" ffmpeg build statically links GPL/LGPL libraries (libx264, libx265,
libvpx, libmp3lame, ...). The complete corresponding source is the FFmpeg source AND the source of those
libraries plus the build scripts. If the installer is ever distributed outside the owning organization,
attach those source archives to each GitHub Release (or provide a working contact address and keep the
sources available for 3 years) BEFORE publishing. The notices file only carries the FFmpeg source link and
a contact offer, which is not enough for external distribution. Tracked in `TODO.md`.

## Unsigned installer and SmartScreen

The installer is not code-signed (decision). Windows SmartScreen shows "Windows protected your PC".
Users click "More info" then "Run anyway". Browsers may also warn on download. Signing would require an
OV/EV code-signing certificate (EV or a cloud signing service gives immediate reputation; OV builds it
over time), then configuring electron-builder (`win.signtoolOptions` / Azure Trusted Signing) with
secrets in CI. Not implemented.

## Upgrade in place

Installing a newer `HLS-R2-Studio-Setup-<version>.exe` over an existing install upgrades it in place
(same `appId`, per-user). User data (settings, queue, logs, stored token) lives under `%APPDATA%` and is
kept (the NSIS uninstaller also keeps `%APPDATA%` user data, including the token vault and the store, by
default). There is no auto-update (`publish: null`); distribute new installers manually.

## Manual Windows verification checklist (every release)

On a clean Windows VM without Node.js or ffmpeg:

1. Check the installer hash against `SHA256SUMS.txt`.
2. Run the installer: SmartScreen "Run anyway", no admin prompt; Start Menu and Desktop shortcuts exist.
3. Launch the app; the startup ffmpeg self-check passes.
4. Sign in with the site URL, username and password (the site issues the token).
5. Process one real video (landscape and ideally portrait); output uploads to R2 and registers on the site.
6. About shows the ffmpeg version (9.0.2) and the third-party notices.
7. `resources\bin\ffmpeg.exe`, `resources\bin\ffprobe.exe`, `resources\LICENSES\THIRD-PARTY-NOTICES.txt`
   exist under the install folder (`%LOCALAPPDATA%\Programs\...`).
8. Install the next version over this one: settings and sign-in survive.
9. Uninstall: the app and shortcuts are removed; check how user data in `%APPDATA%` is handled
   (it is kept by default for oneClick installers; confirm and document the behavior of the build). The token
   vault and store under `%APPDATA%` are expected to REMAIN after uninstall; note this in the release notes.
10. First run after enabling the fuses: the app window renders (not blank) and the app does not crash on
    start with ASAR integrity validation enabled; `ELECTRON_RUN_AS_NODE=1` has no effect on the exe.
11. `resources\bin\ffmpeg.exe` / `ffprobe.exe` hashes equal `ffmpeg.lock.json` (verify-dist checks this in CI),
    and `LICENSE.electron.txt` and `LICENSES.chromium.html` sit next to the exe.
