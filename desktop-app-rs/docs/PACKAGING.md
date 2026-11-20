# Packaging the Windows installer (Tauri app)

The installer is a single unsigned NSIS `.exe` built by `tauri build --bundles nsis`. It contains the app,
`ffmpeg.exe`, `ffprobe.exe` and the legal notices. The WebView2 runtime is not bundled: the installer uses
`webviewInstallMode: downloadBootstrapper` (silent), so it downloads WebView2 only when it is missing
(`src-tauri/tauri.conf.json`).

## IMPORTANT: where things are validated

The installer build and all Windows-specific checks happen ONLY on Windows (a developer machine or the
GitHub Actions `windows-latest` runner). Nothing here was run on macOS/Linux, and `README.md` states that the
installer, the install layout and the smoke test are not verified on a real Windows machine: only a
workflow run proves them. Items that nobody has confirmed on Windows are marked `TODO: verify`.

## Build locally on Windows

Prerequisites: Node.js 24 and npm (the CI uses Node 24), the Rust toolchain (`rust-toolchain.toml` pins the
stable channel with clippy and rustfmt) and the MSVC build tools. There is NO script that downloads ffmpeg:
the download is implemented inline in the CI workflow (see "How ffmpeg is pinned").

TODO: verify the exact local prerequisites (MSVC build tools / Windows SDK) on a clean Windows machine.

```
cd desktop-app-rs
npm ci --ignore-scripts
```

Then prepare the files the bundle needs (the bundle config lists them, see below):

1. `src-tauri/resources/bin/ffmpeg.exe` and `ffprobe.exe` (git-ignored). They must be the build pinned in
   `ffmpeg.lock.json`; take them from the pinned archive and verify the SHA-256 of the archive and of each
   file against the lock, as the workflow does.
2. `LICENSES/THIRD-PARTY-NOTICES.txt` (git-ignored), generated with `node scripts/gen-notices.mjs`
   (needs `cargo` on PATH and `npm ci` already run).
3. `LICENSES/ffmpeg/*` and `LICENSES/fluent-system-icons/*` are committed in the repository.

Then build (PowerShell: `$env:HLS_SITE_URL = "https://admin.example.com"` first):

```
HLS_SITE_URL=https://admin.example.com npx tauri build --bundles nsis --config src-tauri/tauri.bundle.conf.json
```

`HLS_SITE_URL` is the https URL of the HLS site this installer talks to. It is baked into the app at build
time. `src-tauri/build.rs` makes a release build fail when it is missing or not a valid https URL. Use your
real site instead of `admin.example.com`; never commit the real value.

`tauri build` runs `npm run build:web` first (`beforeBuildCommand`). Output:
`src-tauri/target/release/bundle/nsis/HLS R2 Studio_<version>_x64-setup.exe`.

`bundle.resources` (ffmpeg, notices, licenses) lives in `src-tauri/tauri.bundle.conf.json`, merged only
through `--config`. It is kept out of `tauri.conf.json` so that `cargo check`, `cargo test` and `tauri dev`
work without the downloaded files. A plain `npm run build` therefore produces an installer WITHOUT ffmpeg and
licenses.

## Build in CI

Workflow: `.github/workflows/desktop-app-rs-build.yml` ("Desktop app Rust (Windows installer)").

- Trigger: `workflow_dispatch` only (GitHub > Actions > Run workflow). There is currently NO tag-triggered
  release workflow and no GitHub Release is created; the workflow only uploads artifacts.
- The separate workflow `.github/workflows/desktop-app-rs.yml` runs the checks (it is not an installer build).
- Prerequisite: repository variable `HLS_SITE_URL` (Settings > Secrets and variables > Actions > Variables; a
  plain variable, not a secret). The first step fails early with a clear message when it is empty or does not
  start with `https://`.
- Steps: check `HLS_SITE_URL`, `npm ci --ignore-scripts`, Rust toolchain and cache, fetch the pinned ffmpeg,
  `node scripts/gen-notices.mjs`, `npx tauri build --bundles nsis --config src-tauri/tauri.bundle.conf.json`,
  write `SHA256SUMS.txt`, smoke test (silent install into a temp folder, check the files, compare the installed
  ffmpeg hashes with the lock, run `ffmpeg.exe -version` and `ffprobe.exe -version`, silent uninstall), job
  summary, upload the installer, launch smoke test (start the app, check the window, WebView2 and `app.log`),
  screenshot, collect log, cleanup, upload the launch-smoke artifact.
- Artifacts: `hls-r2-studio-rs-windows-<commit sha>` (installer + `SHA256SUMS.txt`, kept 14 days) and
  `launch-smoke-<commit sha>` (screenshots and `app.log*`, kept 7 days, uploaded even on failure).
- No secrets are used and nothing is signed. The workflow has `contents: read` permission only.
- All actions are pinned by full commit SHA (with a `# vX.Y.Z` comment) and `actions/checkout` runs with
  `persist-credentials: false`. Dependencies are installed with `npm ci --ignore-scripts`.

### Release procedure (current reality)

There is no automated release. Until a release workflow exists:

1. Bump the version and commit it. Currently `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` all say `0.1.0`; keep them equal. TODO: verify which of them the installer file
   name takes its version from.
2. Run the workflow manually on the commit to release (Actions > Run workflow).
3. Download the `hls-r2-studio-rs-windows-<commit sha>` artifact and check the installer with
   `Get-FileHash -Algorithm SHA256 "<installer>"` against `SHA256SUMS.txt`.
4. Run the manual verification checklist below on a clean Windows VM.
5. Distribute the installer manually. There is no auto-update (see `README.md`: "no auto-update").

### Build provenance (not enabled)

Build provenance attestations (`actions/attest-build-provenance`) are only available for public repositories
or GitHub Enterprise Cloud. TODO: verify this statement before relying on it (it was carried over from the
former Electron packaging notes and is not implemented in the Tauri workflow).

## How ffmpeg is pinned

`ffmpeg.lock.json` pins the build: gyan.dev "essentials" 9.0.2 (Windows x64, static, GPL v3) as mirrored on
GitHub releases (`url`), the archive SHA-256 (`sha256`), the `archiveRoot` folder, the source tarball
(`sourceUrl`), the source commit (`sourceCommit`), and the SHA-256 of every extracted file (`files`).

The CI step "Fetch pinned ffmpeg (SHA-256 verified)" (inline PowerShell in the workflow; there is no
`fetch-ffmpeg` script in `desktop-app-rs/scripts/`):

1. requires the lock `url` to be https and `sha256` to be well formed;
2. downloads the archive into `.ffmpeg-cache/` (git-ignored; cached by the hash of `ffmpeg.lock.json`) and
   verifies its SHA-256 BEFORE opening it (a mismatch deletes it and fails the build);
3. extracts ONLY the `binary` entries (`ffmpeg.exe`, `ffprobe.exe`) into `src-tauri/resources/bin/`
   (git-ignored), rejecting lock `dest` names that are not plain file names, and verifies each extracted file
   against the lock before moving it into place;
4. checks that the committed license files in `LICENSES/ffmpeg/` (`LICENSE-GPL-3.0.txt`,
   `README-gyan-build.txt`) match the `license` hashes of the lock.

Nothing downloaded is executed during the fetch. The packaged app resolves the executables at
`<resource_dir>/bin/ffmpeg.exe` and `ffprobe.exe` and never uses PATH or env variables there; at startup it
runs a self check (required: libx264, aac, hls, scale, thumbnail, signalstats, edgedetect, hstack, tile, crop,
fps, movie) that is the runtime safety net (`README.md`, "ffmpeg binaries").

### Bump procedure

There is no `--bump` helper in the Tauri app. Manual procedure:

1. Pick a release version from https://www.gyan.dev/ffmpeg/builds/ (prefer numbered releases that match an
   ffmpeg.org source tarball over git snapshots).
2. Compute the archive SHA-256 yourself and cross-check it with the checksum published by gyan.dev and with
   the GitHub release asset digest.
3. Update `ffmpeg.lock.json`: `version`, `url`, `sha256`, `archiveRoot`, `sourceUrl`, `sourceCommit` (from the
   build's `README.txt`), and the SHA-256 of `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `LICENSE` and `README.txt`.
4. Replace `LICENSES/ffmpeg/LICENSE-GPL-3.0.txt` and `LICENSES/ffmpeg/README-gyan-build.txt` with the new
   `LICENSE` and `README.txt` (the CI compares them with the lock hashes).
5. Read the new `README.txt` configuration: it must still list libx264, the aac encoder, the hls muxer and
   the filters scale, thumbnail, signalstats, edgedetect, hstack, tile, crop, fps, movie.
6. Run the build workflow; its smoke test checks the installed hashes against the lock.

TODO: verify whether the app's own version string (for example in the About screen) hard-codes the ffmpeg
version and needs updating on a bump.

## Licenses

- FFmpeg here is a GPL v3 build, used as a separate executable (not linked). The installer ships the GPL text
  and the gyan.dev build README under `LICENSES\ffmpeg\`, and `THIRD-PARTY-NOTICES.txt` carries the source
  offer (`README.md`). Never remove these from the installer.
- `scripts/gen-notices.mjs` generates `LICENSES/THIRD-PARTY-NOTICES.txt` from: the Rust crates compiled into
  the app (`cargo metadata`, target `x86_64-pc-windows-msvc`, normal dependencies only), the npm packages
  Vite bundles into `dist/` (`react`, `react-dom`, `scheduler`, `@tauri-apps/api`) and the pinned FFmpeg build.
  It FAILS (exit 1, nothing written) when a Rust crate declares no license at all or a bundled npm package
  has no license. A crate that declares a license but ships no license file is listed by its SPDX expression
  and reported on stderr. Resolve by review, not by silently bypassing the check.
- `LICENSES/THIRD-PARTY-NOTICES.txt` is a generated build artifact and is git-ignored; `LICENSES/ffmpeg/*` and
  `LICENSES/fluent-system-icons/*` are committed.
- The bundle config copies these into the install folder: `LICENSES\THIRD-PARTY-NOTICES.txt`,
  `LICENSES\ffmpeg\*`, `LICENSES\fluent-system-icons\*`. The app opens the notices file through
  `app_open_notices`.
- TODO: verify that the UI (About screen or equivalent) shows the notices and the ffmpeg version.

## GPL obligations when distributing outside the organization

The bundled gyan.dev "essentials" ffmpeg build statically links GPL/LGPL libraries (libx264, libx265, libvpx,
libmp3lame, ...). The complete corresponding source is the FFmpeg source AND the source of those libraries
plus the build scripts. If the installer is ever distributed outside the owning organization, attach those
source archives to each GitHub Release (or provide a working contact address and keep the sources available
for 3 years) BEFORE publishing. The notices file only carries the FFmpeg source link and a contact offer,
which is not enough for external distribution. Tracked in `TODO.md`.

## Unsigned installer and SmartScreen

The installer is not code-signed (decision, `README.md` "Known limits"). Windows SmartScreen shows "Windows
protected your PC". Users click "More info" then "Run anyway". Browsers may also warn on download. Signing
would require a code-signing certificate and signing configuration in the Tauri bundle and CI secrets. Not
implemented.

## Installer wizard (NSIS)

Configured in `src-tauri/tauri.conf.json` (`bundle.windows.nsis`): `installMode: currentUser` (per user, no
administrator prompt), `languages: ["English"]`, `displayLanguageSelector: false`. According to `README.md`
the wizard has: welcome, install folder (changeable), Start Menu folder, install, finish; default folder
`%LOCALAPPDATA%\HLS R2 Studio`; a Start Menu shortcut is created; uninstall through "Installed apps" or
`uninstall.exe` in the install folder.

Installed layout (on Windows Tauri's resource directory is the executable folder): `hls-r2-studio.exe`,
`bin\ffmpeg.exe`, `bin\ffprobe.exe`, `LICENSES\THIRD-PARTY-NOTICES.txt`, `LICENSES\ffmpeg\*`,
`LICENSES\fluent-system-icons\*`, `uninstall.exe`. The CI smoke test checks the executable, `uninstall.exe`,
the ffmpeg and ffprobe binaries and the notices and ffmpeg license files after a silent install.

TODO: verify on Windows: the exact pages of the wizard, whether a Desktop shortcut is created, and the
default install folder.

## App icon

The master is `src-tauri/icons/source/logo.png` (1024x1024, Windows 11 style rounded-square tile). To
regenerate: run `npx tauri icon src-tauri/icons/source/logo.png` from `desktop-app-rs`, then delete the extra
output it creates (`Square*Logo.png`, `StoreLogo.png`, `android/`, `ios/`; only `32x32.png`, `128x128.png`,
`128x128@2x.png`, `64x64.png`, `icon.png`, `icon.icns` and `icon.ico` are kept). The generator's `icon.ico` has
no 20 and 40 px entries, so rebuild it with PNG entries for 16, 20, 24, 32, 40, 48, 64 and 256 (downscale each
from the master; the 16 to 24 px entries may use a slightly bolder symbol). Also refresh
`src/renderer/src/assets/logo.png` (128x128 copy of the master, used by `BrandMark`).

## Upgrade in place

TODO: verify on Windows. Expected: installing a newer `HLS R2 Studio_<version>_x64-setup.exe` over an
existing per-user install keeps user data, which lives in `%APPDATA%\HLS R2 Studio` (store, logs, token), and
reuses the install folder. Not confirmed for the Tauri NSIS template; no CI step tests an upgrade. No
auto-update exists; distribute new installers manually.

## Manual Windows verification checklist (every release)

On a clean Windows VM without Node.js or ffmpeg:

1. Check the installer hash against `SHA256SUMS.txt`.
2. Run the installer: SmartScreen "Run anyway", no admin prompt. Go through the wizard; the Start Menu
   shortcut exists. Check the default folder, and re-install choosing another folder (the app runs from it).
3. Launch the app; the main window titled `HLS R2 Studio` appears and the startup ffmpeg self-check passes
   (`app.log` in `%APPDATA%\HLS R2 Studio\logs` contains `App starting` and `ffmpeg self-check passed`).
4. Sign in with username and password (the site issues the token). The site is the built-in `HLS_SITE_URL`.
5. Process one real video (landscape and ideally portrait); output uploads to R2 and registers on the site.
6. The third-party notices open and the ffmpeg version shown is 9.0.2 (or the version in `ffmpeg.lock.json`).
7. `bin\ffmpeg.exe`, `bin\ffprobe.exe` and `LICENSES\THIRD-PARTY-NOTICES.txt` exist in the install folder, and
   the ffmpeg/ffprobe hashes equal `ffmpeg.lock.json` (the CI smoke test checks this too).
8. Install the next version over this one: the install folder, settings and sign-in survive (see "Upgrade in
   place", unverified).
9. Uninstall: the application files and shortcuts are removed. Check whether user data in
   `%APPDATA%\HLS R2 Studio` remains and note the outcome in the release notes.
