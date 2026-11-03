# HLS R2 Studio Desktop

Windows desktop app that turns local videos into HLS (ffmpeg), uploads them to Cloudflare R2
and registers them on the HLS R2 Studio site. It lives inside the Laravel monorepo but is a
fully separate Node project (own `package.json`, own lockfile). See
`../docs/DESKTOP-APP-SPEC.vi.md` for the spec.

## Prerequisites

- Node.js 24 LTS (what CI uses; 22.12 or newer 22.x also satisfies the toolchain `engines`) and npm
- No ffmpeg needed for development of pure logic; the real binaries are bundled at packaging time

## Commands

Run everything from `desktop-app/`.

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm install`        | Install dependencies                                  |
| `npm run dev`        | Start Electron with the Vite dev server (HMR)         |
| `npm run build`      | Build main, preload and renderer into `out/`          |
| `npm run typecheck`  | Type-check node (main/preload/shared) and web code    |
| `npm run lint`       | ESLint (flat config, typescript-eslint)               |
| `npm run format`     | Prettier                                              |
| `npm test`           | Vitest, single run (unit + integration)               |
| `npm run smoke`      | Real pipeline on one file (see "Pipeline smoke test") |
| `npm run test:watch` | Vitest watch mode                                     |
| `npm run pack`       | Build + unpacked app via electron-builder (`--dir`)   |
| `npm run dist:win`   | Build + NSIS x64 installer via electron-builder       |

Note: `.npmrc` sets `ignore-scripts=true`, so `npm install` does NOT download Electron's binary
(not needed for `build`, `typecheck`, `lint`, `test`, `pack`). Before `npm run dev`, run
`npx install-electron` once (Electron's `install-electron` bin).

## Folder layout

```
desktop-app/
  electron.vite.config.ts   electron-vite config (main, preload, renderer)
  electron-builder.yml      NSIS installer config
  resources/bin/            ffmpeg.exe / ffprobe.exe go here at packaging time (git-ignored)
  src/
    main/                   Node side
      api/                  site API client (fetch, https only, no redirects) + URL rules
      auth/                 sign-in state machine (login, logout, restore, 401 handling)
      config/               site config held in RAM only (R2 secret never leaves main)
      queue/                job queue, state machine, persistence, recovery
      settings/             site URL, temp folder, parallel jobs
      lifecycle/            close/quit confirmation flow
      pipeline/ ffmpeg/     processing pipeline and ffmpeg runner
      store/                JSON store (atomic writes, schemaVersion, migrate)
      secure/               safeStorage wrapper + TokenVault
      logger/               rotating file log with redaction
      security/             navigation and openExternal helpers
      ipc/                  IPC handlers and payload validation
    preload/                typed contextBridge API
    renderer/               React UI (no Node access)
    shared/                 IPC channel names, shared types, CSP builder
```

Pure logic stays free of Electron imports (Electron-dependent pieces are injected through small
interfaces), so it is testable with plain Vitest.

## Tests

`npm test` runs Vitest in a Node environment on `src/**/*.test.ts`. No Electron or GUI is
started.

`*.integration.test.ts` files run the real pipeline (real ffmpeg/ffprobe, real filesystem, the
real AWS SDK) against an in-process fake S3 server and a fake register client. They are
automatically skipped, with a console message, when ffmpeg/ffprobe are not found through
`resolveBinaries` (set `FFMPEG_PATH` / `FFPROBE_PATH`, or put them on `PATH`). The first run
generates short test videos with ffmpeg `lavfi`; the whole suite takes about 30 s.

## Pipeline smoke test

`npm run smoke -- <video file>` bundles `scripts/pipeline-smoke.ts` (not part of the Electron
bundle) and runs the real pipeline once (bundle written to the git-ignored `.smoke-out/`); the site register call is faked and its payload printed.

- Fake S3 (no credentials): `SMOKE_FAKE_S3=1 npm run smoke -- "C:\videos\clip.mp4"`
- Real R2 / S3: set `SMOKE_R2_ENDPOINT`, `SMOKE_R2_BUCKET`, `SMOKE_R2_ACCESS_KEY_ID`,
  `SMOKE_R2_SECRET_ACCESS_KEY` (uploaded objects stay in the bucket on success).
- Optional: `SMOKE_RESOLUTION` (480|720|1080), `SMOKE_SEGMENT_SECONDS`, `SMOKE_FPS`,
  `SMOKE_TMP_ROOT`, `FFMPEG_PATH`, `FFPROBE_PATH`. Ctrl+C cancels the job (and cleans up).

## ffmpeg and packaging

`ffmpeg.exe` and `ffprobe.exe` are not committed. They are downloaded (pinned version, SHA-256
checked) into `resources/bin/` at packaging time (step B6) and copied by electron-builder to
`resources/bin` inside the installed app. Windows installers are produced on Windows or in
Windows CI; do not expect `npm run dist:win` to work on macOS or Linux.

## Main process architecture (B4)

```
index.ts (wiring, the only place that builds everything)
  store (JSON) ── tokenVault (safeStorage) ── logger
  siteClient ──► authService ──► configService (AppConfig in RAM)
      │  onUnauthorized (any 401) ─► authService.handleUnauthorized()
      └─ register() is the pipeline's RegisterClient
  jobQueue ──► runPipeline / retryRegister / deleteR2Prefix (pipeline/)
  settingsService ── ipc/handlers ── ipc/register (sender guard) ── preload ── renderer
```

Modules (all Electron-free except `index.ts`, `window.ts`, `ipc/register.ts`,
`ipc/electronAdapters.ts`, `ipc/senderGuard.ts` (types only) and `preload/index.ts`):

| Module                                                 | Role                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `api/siteUrl.ts`                                       | Normalizes the site URL to an origin; https only (`http://localhost` in dev builds)                  |
| `api/siteClient.ts`                                    | `login`, `logout`, `getConfig`, `register`; 30 s timeout, `redirect: 'manual'`, typed `SiteApiError` |
| `auth/authService.ts`                                  | `AuthState` machine, token in `TokenVault`, restore at startup, 401 handling, site switch            |
| `config/configService.ts`                              | Latest `AppConfig` in RAM; the renderer only sees `{ r2Configured, transcode }`                      |
| `queue/jobQueue.ts`                                    | Job state machine, scheduling, throttled events, retry/cancel/recovery                               |
| `queue/jobDto.ts`, `jobStates.ts`, `fileValidation.ts` | DTO mapping, state groups, path validation                                                           |
| `settings/settingsService.ts`                          | Validated settings changes                                                                           |
| `ipc/*`                                                | Typed handlers (one validator per payload), push events, sender guard, Electron adapters             |
| `lifecycle/quitCoordinator.ts`                         | Confirm close/quit while jobs run, abort, flush the store, quit                                      |

Data flow of one job: `jobs:add-files` / `jobs:add-paths` -> `queue.addFiles` (validates, stats,
dedupes, smallest first) -> run loop (`maxConcurrent` 1..2; waits while signed out, offline, no
config or ffmpeg check failed) -> `runPipeline` hooks (`onStage`, `onProgress`, `onPrefix`) ->
state saved to the store on transitions only (never per progress tick) -> `jobs:updated` snapshots
(progress throttled to 4 per second per job, stage changes immediately) -> `done` stores
`{ id, public_id, embed_url }` and caps the history at 200 done jobs.

### IPC channels

Every payload is validated in main (`ipc/validate.ts`) and calls from any frame other than the top
frame of the app window are rejected. Action channels return `{ ok: true } | { ok: false, error }`
with a safe English message; invalid payload shapes are rejected as errors.

| Channel                   | Direction      | Payload                                                                       | Result                |
| ------------------------- | -------------- | ----------------------------------------------------------------------------- | --------------------- |
| `app:get-version`         | invoke         | none                                                                          | `string`              |
| `app:open-logs-folder`    | invoke         | none                                                                          | `ActionResult`        |
| `app:open-notices`        | invoke         | none (opens `LICENSES/THIRD-PARTY-NOTICES.txt`)                               | `ActionResult`        |
| `diagnostics:get`         | invoke         | none                                                                          | `DiagnosticsDto`      |
| `auth:get-state`          | invoke         | none                                                                          | `AuthState`           |
| `auth:login`              | invoke         | `{ siteUrl, username, password, staySignedIn? }` (default `true`)             | `AuthState`           |
| `auth:logout`             | invoke         | none                                                                          | `AuthState`           |
| `auth:reload-config`      | invoke         | none                                                                          | `AuthState`           |
| `settings:get`            | invoke         | none                                                                          | `SettingsDto`         |
| `settings:set`            | invoke         | `{ siteUrl?, tmpRoot?, maxConcurrent? }`                                      | `SettingsResult`      |
| `settings:pick-directory` | invoke         | none (main opens the native folder dialog)                                    | `PickDirectoryResult` |
| `jobs:list`               | invoke         | none                                                                          | `JobDto[]`            |
| `jobs:add-files`          | invoke         | none (main opens the file dialog)                                             | `AddFilesResult`      |
| `jobs:add-paths`          | invoke         | `{ paths: string[] }` (drag and drop; preload uses `webUtils.getPathForFile`) | `AddFilesResult`      |
| `jobs:cancel`             | invoke         | `{ id }`                                                                      | `ActionResult`        |
| `jobs:retry`              | invoke         | `{ id }`                                                                      | `ActionResult`        |
| `jobs:retry-register`     | invoke         | `{ id }`                                                                      | `ActionResult`        |
| `jobs:remove`             | invoke         | `{ id }`                                                                      | `ActionResult`        |
| `jobs:clear-finished`     | invoke         | none                                                                          | `ActionResult`        |
| `jobs:open-embed`         | invoke         | `{ id }` (https and same host as the site only)                               | `ActionResult`        |
| `jobs:copy`               | invoke         | `{ id, kind: 'embed-url' \| 'shortcode' }`                                    | `ActionResult`        |
| `auth:changed`            | main -> window | `AuthState`                                                                   |                       |
| `jobs:updated`            | main -> window | `JobDto[]` (full snapshot)                                                    |                       |
| `queue:summary`           | main -> window | `QueueSummary`                                                                |                       |

The preload exposes `window.hlsApi` (`app`, `auth`, `settings`, `jobs`; see `RendererApi` in
`src/shared/ipc.ts`). `on...` subscriptions return an unsubscribe function.

### Job states

```
                      addFiles                         (stays here while signed out / no config)
                         |                                      |
                         v                                      |
   +------------------ waiting <----------- retry (new public_id, old partial R2 prefix removed)
   | cancel               | start (slot free)                      ^
   v                      v                                        |
cancelled <--- transcoding -> thumbnail -> storyboard -> uploading -> registering --> done
   ^   ^            |            |             |            |            |
   |   | cancel     +------------+-------------+------------+            |
   |   +------------ (any running state) -------------------+            |
   |                          | error (ffmpeg, disk, upload, ...)        |
   |                          v                                          |
   |                       failed ----- retry -----> waiting             |
   |                                                                     |
   |                  network / 5xx / 429 / non-definitive 4xx --> register_failed
   |                  401 ------------------------------------> needs_sign_in
   |                                                                     |
   +-- cancel (files stay on R2) -- register_failed / needs_sign_in <----+
                                      | retry-register (no re-upload) -> registering
                                      | sign-in again: needs_sign_in is retried automatically

app closed while a job ran -> `interrupted` at next start (temp dir removed); retry -> waiting
final states (removable): done, failed, cancelled, interrupted
```

Notes: a cancelled register retry returns to `register_failed`/`needs_sign_in` (files stay on R2).
Retry of a job that failed or was cancelled while uploading removes the old partial R2 prefix first
(best effort). An interrupted job (app closed while it was running) never has its R2 files deleted
on retry, because it may already be registered on the site; its prefix is only logged as possibly
orphaned.

## Known limitations

- Cancelling a job in `register_failed` / `needs_sign_in` keeps its uploaded objects on R2 (the
  site may already have registered the video), so this case can leave orphaned R2 objects.
- Retry of an `interrupted` job (the app was closed or crashed while it ran) NEVER deletes the
  old R2 prefix: the saved step can lag behind a register request that did reach the site. The
  prefix is only written to the log ("may be orphaned"), so such a job can leave unreferenced R2
  objects that have to be removed by hand.
- Jobs are bound to the site they were uploaded for. After switching sites, `needs_sign_in` /
  `register_failed` jobs stay as they are (with a message naming the original host) until you
  sign in to that site again or cancel them; nothing is registered or deleted on another site.
  Changing the site URL in Settings is refused while such jobs exist.
- Only the server error codes `playlist_not_found` and `public_id_conflict` are treated as a
  definitive rejection (the R2 files are then deleted). Any other HTTP 409/422 keeps the files
  and the payload so the user can retry.
- File names are capped at 100 characters in the R2 prefix (the server columns are
  `varchar(255)`); longer names still work but the stored folder name is shortened.
- ffmpeg/ffprobe children are killed through the process tree when the app stops them, but a hard
  crash of the main process can leave an orphaned ffmpeg running until it finishes (Windows Job
  Objects are not used yet).
- The temp folder cannot be a UNC/network or device path; source files are read with an ffmpeg
  demuxer allow-list (mp4/mov/mkv/webm/avi only).

## Security notes

- Secrets (API token, R2 credentials) stay in main: they are never logged, stored in the JSON
  store or sent to the renderer. The site client never follows redirects, so the Bearer token
  cannot reach another host; changing the site URL signs out first.
- Renderer: `contextIsolation`, `sandbox`, no Node integration, strict CSP, no navigation or new
  windows. Only the main process talks to the network.
- API token is encrypted with Electron `safeStorage` and never written in plain text. Logs redact
  tokens, secrets, Authorization headers and the user's home directory.
