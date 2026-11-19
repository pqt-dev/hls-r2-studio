# Desktop app (Tauri Rust + React)

## Rust / renderer responsibilities

Responsibilities between Rust (`src-tauri`) and the renderer (`src/renderer`) are strictly separated.

- The renderer asks, Rust provides. The renderer asks for data ("give me X") and does not know or care how Rust obtains it.
- Rust decides the source: reuse data already fetched when the screen initialised (e.g. the `videos_get` response) or its in-memory cache first; call the site API only when the data is missing. Everything a screen needs must already be available when the screen initialises.
- The renderer never builds URLs or paths and never receives secrets (tokens, credentials, R2 base URL/endpoint, bucket name).
- Copy-to-clipboard and open-external actions go through validated Rust commands that take ids and kinds, never arbitrary text or URLs from the renderer.
- Example: the renderer asks for the R2 path of a video -> Rust returns it (from data it already has from the detail screen's init fetch or its cache, or by calling the site API itself when missing); the renderer never builds it.
- New fields: add them together in the Rust DTO, `src/shared/ipc.ts`, the fakeApi in `src/renderer/src/testing/`, and the tests (Rust and renderer).
- Error and UI text stays in English.
