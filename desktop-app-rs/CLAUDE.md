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

## Shared UI components

- Before adding UI, check `src/renderer/src/components` for an existing shared component and reuse it.
- Anything used by two or more screens (Upload button, quick actions cluster, status chips, row surface, group header, chips, thumbnails) must be extracted into a shared component or CSS class. Do not build a per-screen copy.
- Screens must not restyle shared pieces locally: change the shared component or class instead (a screen may only add layout around it).
- Current shared pieces:
    - `UploadVideosButton` (`variant` create/primary, `navigate`, `disabled`; uses `useUploadVideos`): Home hero, Library pager row, Queue drop zone.
    - `.btn-control` (size modifier: control height, padding, body font; on `UploadVideosButton` and on any button sharing a row with it, e.g. Home hero "Open Library"): buttons in one row must share one height.
    - Content width: list/grid screens (Library, Home, Queue, Logs) use the full width, form screens (Settings, About) are capped (45rem).
    - `RefreshButton` (`busy`, `onClick`, `size` control/sm, `className`): icon-only Refresh (spinning icon, `aria-busy`, name never changes); Library toolbar, Home overview, video detail header. Explicit Refresh on Home and Library is quiet (data stays on screen; skeletons only for the first load and query changes).
    - `StatTile` (`icon`, `value` (null = loading dash), `label`, `tone` primary/success/warning/danger, `onClick`, `actionLabel`, `alert`): tonal-circle statistic; Home overview strip. `SectionCard` also takes `description` and `size="lg"` (Home overview header).
    - `VideoQuickActions` (`actions`, `menu`, `variant` default/ghost; plus `useQuickActions` for video ids): Library rows, Queue finished rows, Home recent rows (same cluster as the Library: shortcode, thumbnail URL, then the `VideoMenu`). Fixed order: shortcode, thumbnail URL, direct URL, open, then the menu.
    - `StatusCountChips` (dot + count: running blue, waiting amber, done green, failed red, attention; optional `onSelect` makes them buttons): Queue footer, Home Queue status.
    - `JobProgress` (`fileName`, `progress`; native `<progress>` + percent, `.job-progress`): Queue rows, Home running jobs. `JobStateChip` (`job`; icon + stage label colored by status kind): Queue rows, Home attention list.
    - Relative times: `formatRelativeTime(iso, now)` and `formatDateTime(iso)` in `lib/format.ts` (inject `now`; wrap in `<time dateTime title={formatDateTime(iso)}>`): Queue rows, Home recent rows and hero activity line.
    - `.row-surface` (+ `.row-surface-flat`) CSS class: card look, full-row hover, picked/focus states of Library, Queue and Home recent rows.
    - `.row-surface.is-deleting` (+ `.is-leaving` fade, `.deleting-pill`): generic pending-delete state (danger tint, muted media, struck title, inert controls, "Deleting…" pill); Library today, reusable for Queue remove.
    - `GroupHeader` (title, optional count, optional toggle and right-aligned action, optional `headingLevel`): Queue groups, Logs sections.
    - `MediaTile` (thumbnail or neutral media icon) and `Thumbnail`: video visuals.
    - `PerPageSelect` (`value`, `options`, `onChange`; label "Per page", aria-label "Items per page"): Library toolbar, Queue Finished pager row. Pair it with `Pagination` in a `.pager-row`.
    - `EmptyState` (`icon`, `title`, `description`, `action`, `compact`): Queue, Library, Logs and Home placeholders.
    - `SectionCard` (`title`, `level`, `action`, children; the `.card` surface): Settings, About and Home cards. `GroupHeader` with `headingLevel` is the section heading of Logs.
    - `DropZone` + `useFileDrop`: the Queue upload card (sticky `.queue-sticky` band); the drag state comes from the whole Queue.
    - `lib/preferences.ts` (`readPreference`, `writePreference`, `PREF_KEYS`): persisted UI preferences. View mode and page sizes live in `localStorage` through this helper (validated against the allowed options, safe when storage fails); data and secrets stay in Rust.
    - `TierChip`, `OrientationChip`: media chips. `ActionMenu`, `VideoMenu` (Select and Delete are optional: Home omits them): kebab menus. `Dialog`, `Banner`, `Pagination`, `SelectBox`, `ImageZoom`, `DetailsDialog`: shared dialogs and controls.
