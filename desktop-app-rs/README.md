# HLS R2 Studio desktop app (Tauri 2)

Tauri 2 port of `../desktop-app` (Electron). The React renderer in `src/renderer` and the shared
types in `src/shared` are copies of the Electron app's; the only renderer change is
`src/renderer/src/tauriApi.ts`, which installs `window.hlsApi` on top of Tauri `invoke`/`listen`
(the command/event name mapping table is at the top of that file).

## Layout

- `src/renderer`, `src/shared` - React UI and shared DTOs (copied from `desktop-app`).
- `src-tauri/src/dto.rs` - serde mirrors of the DTOs in `src/shared/ipc.ts`.
- `src-tauri/src/store/` - atomic, debounced JSON store (`json_store.rs`), the `store.json` document and its validation (`app_store.rs`, `model.rs`), history cap (`history.rs`).
- `src-tauri/src/logger/` - redaction rules (`redact.rs`) and the rotating file logger (`file_logger.rs`).
- `src-tauri/src/settings/` - `SettingsService` (temp folder / parallel jobs rules) and the pure path rules (`path_rules.rs`).
- `src-tauri/src/secure/` - `Secret` (zeroized, redacted `Debug`), the encryption backend (DPAPI on Windows, `dpapi.rs`) and the `TokenVault`.
- `src-tauri/src/api/` - site API client (`site_client.rs`, reqwest + rustls/ring), `SiteApiError`, the `/api/app/config` parser and R2 location rules.
- `src-tauri/src/config/` - `ConfigService` (site config in memory only, stale-result protection).
- `src-tauri/src/auth/` - `AuthService` state machine (sign-in, sign-out, startup restore, 401, offline, races).
- `src-tauri/src/ipc/` - one Tauri command per IPC channel (22 channels, all registered in `ipc/mod.rs`), payload validation (`validate.rs`) and the sender guard applied to every command (`guard.rs`).
- `src-tauri/src/ffmpeg/` - the ffmpeg layer (port of `desktop-app/src/main/ffmpeg`): `args.rs` (ffmpeg/ffprobe argument builders and timeouts), `binaries.rs` (where the executables are), `kill_tree.rs` (process-tree kill), `probe_parse.rs` / `progress.rs` (ffprobe output and `-progress pipe:1` parsers), `runner.rs` (async spawn with timeout, cancellation, streamed output, stderr tail), `errors.rs` (typed pipeline failure reused by the later pipeline milestone), `self_check.rs` (startup check feeding `diagnostics_get`), `file_names.rs` (job temp file names).
- `src-tauri/src/pipeline/` - the job pipeline (port of `desktop-app/src/main/pipeline`; driven by the job queue (M6)):
  - M4a: pure helpers `slug.rs` (+ `ascii_table.rs`, generated from Laravel `Str::ascii`, checked against `tests/fixtures/slug-golden.json`), `public_id.rs`, `prefix.rs`, `file_names.rs`, `progress_model.rs`, `pool.rs`, `thumbnail_plan.rs`, `storyboard_plan.rs`; `register.rs` (payload, validation, error mapping, `RegisterClient`; the HTTP call is `SiteClient::register`); `deps.rs` (traits for the process runner, filesystem, clock, object store, sleeper, free space); `steps/` (`probe`, `transcode`, `thumbnail`, `storyboard`, `score`, `cleanup`, `image_size`, `env`, `fs_util`).
  - M5: `run.rs` (`run_pipeline`, `retry_register`, `register_with_retry`, `PipelineDeps`, `PipelineHooks`), `resume.rs` (`resume_upload`), `steps/upload.rs` (upload step + network-wait policy), `upload/` (`plan.rs`, `classify_error.rs`), `s3/` (`sigv4.rs`, `client.rs` = the R2 client, `xml.rs`), `job_dir.rs` (job temp dir creation and safe removal), `fault.rs` (failure -> `PipelineError` mapping); test doubles in `testing/` (`fakes.rs`, `fake_s3_server.rs`).
- `src-tauri/src/queue/` - the job queue (M6, port of `desktop-app/src/main/queue`): `job_queue.rs` (`JobQueue`), `backend.rs` (side-effect seams `QueueBackend` / `QueueContext` and their real implementations over the M5 pipeline), `job_dto.rs` (`JobRecord` -> `JobDto`, no paths/payloads/secrets), `file_validation.rs`, `states.rs`; fakes and tests in `testing.rs`, `tests.rs` (port of `jobQueue.test.ts`), `concurrency_tests.rs`, `smoke_tests.rs`.
- `src-tauri/src/lifecycle/` - `quit.rs` (`QuitCoordinator`, port of `quitCoordinator.ts`), `app_deps.rs` (its Tauri implementation), `startup.rs` (fatal startup error box + non-zero exit).
- `src-tauri/src/desktop.rs` - OS integration used by `jobs_open_embed` / `jobs_copy` / `app_open_notices` (https-only URL checks, `ShellExecuteW` on Windows, clipboard through `arboard`).
- `src-tauri/src/window.rs` - main window (1100x720, min 760x520, hidden until loaded, navigation locked, no new windows).
- `src-tauri/tauri.conf.json` - CSP (explained in `src-tauri/src/lib.rs`); `src-tauri/capabilities/` - minimal permissions.

## Commands

```sh
npm install
npm run dev          # tauri dev (starts Vite on :5173)
HLS_SITE_URL=https://admin.example.com npm run build   # tauri build; fails without an https HLS_SITE_URL
npm run typecheck    # tsc for the node and web projects
npm test             # vitest (renderer + IPC shim)
npm run test:rust    # cargo test
```

Rust needs `~/.cargo/bin` on PATH (`rust-toolchain.toml` pins the stable channel with clippy and rustfmt).
`dev`, `cargo test` and `cargo check` do not need `HLS_SITE_URL`; a release build (what `tauri build` runs) does.

## Data folder

The app reads and writes the same folder as the Electron app, `<appData>/HLS R2 Studio`
(`%APPDATA%\HLS R2 Studio` on Windows), so an existing Electron install's `store.json` loads
unchanged (same file name, `schemaVersion` 1, same validation and defaults). Logs go to
`<that folder>/logs/app.log` (rotated, secrets redacted). Note this differs from Tauri's own
`app_data_dir()` (`<appData>/com.hlsr2studio.desktop`, the bundle identifier). The Electron and
Tauri apps must not run at the same time on one folder.

## Sign-in token

The site API token is kept by `TokenVault`:

- Windows: encrypted with DPAPI (current user, no UI, app-specific entropy) and stored as
  `<data folder>/token.dpapi` when "Stay signed in" is on; memory only otherwise.
- Other platforms: no OS encryption backend yet, so the token is memory only (sign in on every
  start). Nothing is ever written unencrypted.

The Electron app's `token.bin` is NOT read: Electron's `safeStorage` on Windows is AES-GCM with a
key kept in Electron's `Local State`, not plain DPAPI. The file is left untouched (it is neither
read nor deleted), so after switching from the Electron app users sign in once. The token, the
password and the R2 credentials are `Secret`s: wiped from memory on drop, redacted in `Debug`,
never logged and never part of a DTO.

## ffmpeg binaries

`ffmpeg::resolve_binaries` (same rules as the Electron app's `binaries.ts`; it takes the resource directory explicitly, so it needs no Tauri runtime):

- Packaged build (`!cfg!(debug_assertions)`): `<resource_dir>/bin/ffmpeg(.exe)` and `ffprobe(.exe)`, absolute paths; PATH and the env variables are never used. The bundling itself (`bundle.resources`, e.g. `{ "resources/bin/*": "bin/" }`) and `fetch-ffmpeg` belong to a later milestone; until then a packaged build reports ffmpeg as missing.
- Development: `FFMPEG_PATH` / `FFPROBE_PATH` (blank counts as unset), otherwise the bare names `ffmpeg` / `ffprobe` (`.exe` on Windows), resolved through PATH.

The self check (`ffmpeg -version`, `-encoders`, `-filters`, `-muxers`; required: libx264, aac, hls, scale, thumbnail, signalstats, edgedetect, hstack, tile, crop, fps, movie) runs in the background at startup. `diagnostics_get` returns `ffmpeg: { checked: false, ... }` until it has finished; missing binaries never stop the app (`ok: false`, `missing: ["ffmpeg:version", ...]`).

Process tree kill (timeout / cancel): Unix kills the process group (`SIGKILL`, the child is spawned as its own group leader). Windows puts the child in a Job Object with `KILL_ON_JOB_CLOSE`, so the whole tree also dies if the app crashes; if the job cannot be set up it falls back to `taskkill /PID <pid> /T /F`. Children never open a console window (`CREATE_NO_WINDOW`).

Tests that need a real ffmpeg (`ffmpeg/real_ffmpeg_tests.rs`, `pipeline/steps/real_ffmpeg_tests.rs`, `pipeline/real_pipeline_tests.rs`) skip themselves when `ffmpeg`/`ffprobe` are neither on PATH nor given by `FFMPEG_PATH` / `FFPROBE_PATH`.

## Pipeline, R2 upload and resume (M5)

Entry points for the job queue (M6), all async, all cancellable with a `CancellationToken`:

- `pipeline::run::run_pipeline(job, config, deps, hooks, cancel)` - checks, prefix, probe, transcode, thumbnail, storyboard, upload, register. `hooks: Arc<dyn PipelineHooks>` receives `on_stage`, `on_progress` (whole percent, never decreasing), `on_prefix`, the awaited `on_before_upload` (persist `prefix`/`tmpDir`/`registerPayload` before the first PutObject) and `on_before_register` (flush before the first register request), and `on_network_wait` / `on_network_restored`.
- `pipeline::run::retry_register(payload, deps, hooks, cancel)` - register only (`jobs_retry_register`).
- `pipeline::resume::resume_upload(input, config, deps, hooks, cancel)` - continues an `upload_interrupted` job from the kept temp dir and the stored payload (`JobRecord::register_payload_typed()`); lists R2, uploads only missing / different-size objects, the playlist last, then registers. Never runs ffmpeg.

Failures are `PipelineError`s (kinds `failed`, `cancelled`, `register_failed`, `needs_sign_in`, `upload_interrupted`; fields `registerPayload`, `prefix`, `definitive`, `code` (`resume_unavailable`), `resumable`, `tmpDir`), with the same messages and the same R2/temp-dir rules as the Electron app. Paths in the ffmpeg stderr tail are replaced by `<source>`, `<source-dir>`, `<job-dir>`, `<tmp-root>`.

**R2 client** (`pipeline/s3`): SigV4 is implemented in `sigv4.rs` on `ring` (already the rustls crypto provider) and checked against the AWS documentation test vectors; the transport is the app's reqwest + rustls/ring stack. `aws-sdk-s3` was not used (very large dependency tree; its default TLS stack is aws-lc-rs, which needs cmake/NASM on Windows), nor the `aws-sigv4` crate (pulls the aws-smithy runtime types for one function). Settings: region `auto`, path-style `https://<endpoint>/<bucket>/<key>`, https only, no redirects, no proxy, connect timeout 15 s, socket-inactivity timeout 60 s (no byte moving in either direction; a slow but moving upload is never cut, there is no total-time limit), `PutObject` with the file streamed in 64 KiB chunks, a fixed `Content-Length` and `UNSIGNED-PAYLOAD` (no `aws-chunked`, no CRC32 trailer, no `x-amz-checksum-*`), `DeleteObjects` with the required `Content-MD5`, byte-progress callback, clock-skew correction from the server `Date` header like the SDK. Upload clients make exactly one attempt per call (the upload step retries); cleanup clients (list/delete) make up to 3 on network failures. The credentials are `Secret`s: the client has no `Debug`, the `Authorization` header is marked sensitive, error texts never contain the request URL.

**Upload policy** (`steps/upload.rs`): 5 files at a time, `playlist.m3u8` strictly last; a network failure (transport error, HTTP 408/429/5xx) waits 2, 5, 10, 20, 30, then 60 s between attempts for as long as no file succeeds for 30 minutes (one budget shared by all files; any success resets it), then `upload_interrupted` (R2 objects and temp dir kept); any other failure gets 3 attempts (waits 1 s and 2 s), then `failed`.

**Temp dir safety** (`job_dir.rs`): a recursive delete only runs on `<tmp root>/<12-char public id>`: both paths absolute, no `.`/`..`, the temp root not a drive/filesystem root, the directory a direct child; a symlink/junction in its place is unlinked, never followed; both paths are canonicalized (long-path `\\?\` form on Windows) and the real directory must sit directly in the real temp root; the delete itself is `std::fs::remove_dir_all`, which removes links inside the tree without following them. Covered by tests for `..` traversal, empty/relative paths, drive roots, symlinks (Unix) and junctions / paths longer than `MAX_PATH` (Windows, `#[cfg(windows)]`, run on CI).

## Job queue and lifecycle (M6)

**Concurrency model** (`queue/job_queue.rs`): one `std::sync::Mutex` over the queue state; every check-then-act (is the job running? can it be retried?) and the store change that follows happen in ONE short critical section, and no lock is ever held across an `.await` (R2 cleanup, temp-dir removal, store flush run after the lock is released). Every run has a sequence number; pipeline hooks and the completion handler re-check that the job's current runtime still carries THEIR sequence before touching anything, so a late progress/finish after cancel, remove, sign-out or quit is ignored and cannot resurrect a removed job. Events are built and sent under an ordering lock so the renderer sees snapshots in order. The clock, ids, pipeline, store backend, auth context and dialogs are injected, so tests use fakes.

**Push events**: `auth-changed`, `jobs-updated` (`JobDto[]`) and `queue-summary` are emitted to the `main` window only; progress is throttled to 4 events/s per job, stage changes go out immediately. The queue is also driven by auth changes (`on_auth_changed`), by settings changes (`kick`) and by the end of the ffmpeg self check (`kick`).

**Quit** (`lifecycle/`): window close and `RunEvent::ExitRequested` both go through `QuitCoordinator`. While jobs run, a native dialog asks "Jobs are still running. Quit and cancel them?" (Quit / Keep working). On Quit: running jobs are cancelled (their ffmpeg trees are killed through the cancel token, the queue waits up to 15 s for the cleanup), the store is flushed, then the app exits. Paused uploads (`upload_interrupted`) are not running jobs: their temp dir and R2 objects stay, so Resume works on the next launch. A fatal startup error shows a native error box with a fixed English text and exits with code 1. A second launch is handled by `tauri-plugin-single-instance` (the existing window is shown and focused).

**Permissions** (`capabilities/default.json` stays `core:default` only; the renderer has no fs/shell/http/dialog/clipboard access):

- `tauri-plugin-dialog`: registered, no webview permission; used from Rust only (video picker, folder picker, quit confirmation).
- `tauri-plugin-single-instance`: no permission (Rust-only).
- `tauri-plugin-opener`: NOT registered; only its plain Rust functions are used on macOS/Linux. On Windows `ShellExecuteW` is called directly (never a shell command string). Only https URLs without credentials on the signed-in site's host, and the fixed notices file, can be opened.
- clipboard: `arboard` from Rust (text only), not the Tauri clipboard plugin.
- `rfd` (Windows/macOS only): the startup error box, before the app handle exists.

Notices: `app_open_notices` opens `<resources>/LICENSES/THIRD-PARTY-NOTICES.txt` (packaged) or `<desktop-app-rs>/LICENSES/...` (dev); bundling that file is part of the packaging milestone, until then the command returns "Notices file not found.".

## Milestones

- [x] M1: skeleton, stub IPC commands, window, CSP, capabilities, tests.
- [x] M2a: persistence (atomic JSON store, `store.json`), redacting file logger, real settings (`maxConcurrent` 1..2, temp folder rules), native folder dialog, open logs folder.
- [x] M2b: auth, token storage (DPAPI), site client, config service, IPC validation and sender guard.
- [x] M3: ffmpeg layer (argument builders, probe/progress parsing, binary lookup, process runner with process-tree kill, startup self check feeding `diagnostics_get`).
- [x] M4a: pipeline utilities (slug, public id, prefix, progress model, pool, planners), `register()` on the site client, and the non-upload steps (probe, transcode, thumbnail, storyboard, cleanup, image size) over traits with fakes.
- [x] M5: R2 client (SigV4 over reqwest), upload step, resumable upload, `run_pipeline` / `retry_register` / `resume_upload`, safe temp-dir lifecycle.
- [x] M6: job queue (concurrency, retry, resume, job store wiring), all 22 IPC commands real, push events, quit / startup-failure / single-instance lifecycle, file dialogs.
