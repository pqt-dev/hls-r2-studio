# Desktop app API (`/api/app`)

**English** | [Tiếng Việt](DESKTOP-APP-API.vi.md)

JSON API used by the desktop app. Source of truth for the contract: `routes/api.php` and `app/Http/Controllers/Api/App/*`. The original design lives in `docs/DESKTOP-APP-SPEC.vi.md` (section 3.5); this file is the full endpoint reference, including the management endpoints added later.

## Conventions

- **Auth**: every endpoint except `POST /api/app/login` needs `Authorization: Bearer <token>` (Laravel Sanctum token from login). Cookies and sessions are never used. Missing or revoked token: `401 {"message": "Unauthenticated."}`.
- **Format**: request and response are JSON (send `Accept: application/json`). Every response carries `Cache-Control: no-store`.
- **Authorization model**: the site has one admin dataset. Videos have no owner, so any valid token can do exactly what the web admin can do with videos. Not exposed: R2 settings, password change, app-token management, reports, activity-log writes, web login.
- **Throttle**: all authenticated endpoints share `throttle:app-api` (60 requests/minute per token). Over the limit: `429` with `Retry-After`. `POST /videos/{video}/image` adds `throttle:20,1` (20/minute), like the web admin.
- **`{video}`**: the numeric video `id` (not `public_id`). Non-numeric values do not match any route (404).
- **Errors**:
    - `404 {"error": "not_found"}`: unknown video or unknown route.
    - `422`: standard Laravel validation body `{"message": "...", "errors": {"field": ["..."]}}`.
    - Business errors: `{"error": "<code>", "message": "<text>"}` (`message` may be absent on older endpoints).
    - `429`: throttled. `5xx`: generic message only; stack traces, SDK errors and credentials are never returned.
- Timestamps are ISO 8601 strings (UTC offset included). All user-facing messages are English.

## Endpoint table

| Method and path                                | Name                           | Purpose                                      | Extra throttle |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------- | -------------- |
| `POST /api/app/login`                          | `api.app.login`                | Get a token (no auth, `throttle:app-login`)  | 5/min per IP+user |
| `POST /api/app/logout`                         | `api.app.logout`               | Revoke the current token                     |                |
| `GET /api/app/config`                          | `api.app.config`               | R2 + transcode config                        |                |
| `GET /api/app/videos`                          | `api.app.videos.index`         | Paginated list                               |                |
| `POST /api/app/videos`                         | `api.app.videos.store`         | Register an uploaded video                   |                |
| `GET /api/app/videos/status`                   | `api.app.videos.status`        | Poll statuses of several videos              |                |
| `DELETE /api/app/videos/bulk-destroy`          | `api.app.videos.bulk-destroy`  | Delete several videos                        |                |
| `GET /api/app/videos/{video}`                  | `api.app.videos.show`          | Video detail                                 |                |
| `PUT /api/app/videos/{video}`                  | `api.app.videos.update`        | Rename                                       |                |
| `DELETE /api/app/videos/{video}`               | `api.app.videos.destroy`       | Delete one video                             |                |
| `GET /api/app/videos/{video}/status-log`       | `api.app.videos.status-log`    | Status history                               |                |
| `POST /api/app/videos/{video}/image`           | `api.app.videos.image.store`   | Upload custom thumbnail                      | 20/min         |
| `DELETE /api/app/videos/{video}/image`         | `api.app.videos.image.destroy` | Remove custom thumbnail                      |                |
| `GET /api/app/overview`                        | `api.app.overview`             | Dashboard numbers                            |                |
| `GET /api/app/logs`                            | `api.app.logs.index`           | Logs page data                               |                |

Login, logout, config, list and register are described in `docs/DESKTOP-APP-SPEC.vi.md` section 3.5; the list endpoint is `GET /videos?page=&per_page=(1..50, default 24)&q=` returning `{"data": [...], "meta": {"page","per_page","total","last_page"}}`. The sections below cover the management endpoints.

## GET /api/app/videos/{video}

Auth: bearer. 200:

```json
{
    "id": 12,
    "public_id": "abcdefghij12",
    "title": "My clip",
    "original_filename": "my clip.mp4",
    "original_size_bytes": 1234,
    "status": "ready",
    "stage": "ready",
    "progress": 100,
    "error": null,
    "duration": 12.5,
    "output_width": 1280,
    "output_height": 720,
    "output_fps": 30,
    "output_bitrate_kbps": 2500,
    "output_codec": "h264",
    "embed_url": "https://site.example/embed/abcdefghij12",
    "playlist_url": "https://cdn.example.com/2026/11/03/clip-abcdefghij12/playlist.m3u8",
    "thumbnail_url": "https://cdn.example.com/.../thumbnail.jpg",
    "has_custom_image": true,
    "custom_image_url": "https://cdn.example.com/.../custom-clip-abcdefghij12.jpg?v=1793700000",
    "storyboards": {
        "3x3": { "url": "https://cdn.example.com/.../storyboard_3x3.jpg", "columns": 3, "count": 9 },
        "5x5": { "url": "https://cdn.example.com/.../storyboard_5x5.jpg", "columns": 5, "count": 25 }
    },
    "embed_storyboard": { "url": "https://cdn.example.com/.../storyboard_5x5.jpg", "number": 25, "column": 5, "width": 160, "height": 160 },
    "created_at": "2026-11-03T10:00:00+00:00",
    "updated_at": "2026-11-03T10:05:00+00:00"
}
```

- `status`: `pending`, `processing`, `ready` or `failed`. `stage`/`progress` follow the transcode pipeline (videos registered by the desktop app are created with `ready` and `100`).
- `error` is `null` unless `status` is `failed`; then `{"message": "...", "detail": "...", "failed_at": "..."}`. `detail` is already sanitized server-side (paths replaced, control characters removed, length capped).
- `embed_storyboard` is the grid the embed player uses (largest generated one) or `null`.
- URL fields are `null` when the file does not exist or R2 is not configured. Never returned: R2 credentials, bucket/endpoint, internal object keys, `upload_id`.
- Errors: 404 `not_found`.

## PUT /api/app/videos/{video}

Body: `{"title": "required string, max 255"}`. Other fields are ignored. 200: the detail object above. Errors: 404, 422 (`title`).

## GET /api/app/videos/status?ids=1,2,3

Polling. `ids` is required: comma-separated positive integers (junk and duplicates dropped, at most **50** distinct ids are read, the rest ignored). 200:

```json
{ "data": [ { "id": 1, "status": "processing", "stage": "transcoding", "progress": 42 } ] }
```

Unknown ids are omitted; no valid id gives `{"data": []}`. Errors: 422 (`ids` missing).

## GET /api/app/videos/{video}/status-log

Server-side status history, oldest first (client-origin activity-log lines are excluded). 200:

```json
{ "data": [ { "status": "processing", "stage": "transcoding", "progress": 50, "created_at": "2026-11-03T10:01:00+00:00" } ] }
```

Errors: 404.

## DELETE /api/app/videos/{video}

Deletes the record and, when the site setting "delete from R2 on destroy" is on, the video's R2 folder. The outcome is in `status` and the HTTP code is 200 in all three cases (same as the web admin's JSON):

| `status`  | When                                                         |
| --------- | ------------------------------------------------------------ |
| `deleted` | Done (message says whether R2 files were kept)               |
| `skipped` | Video is `pending` or `processing`; nothing changed          |
| `failed`  | R2 cleanup failed; the record was kept so you can retry      |

```json
{ "status": "deleted", "message": "Video has been deleted." }
```

Errors: 404.

## DELETE /api/app/videos/bulk-destroy

Body: `{"selected_ids": [1, 2, 3]}`: 1 to **100** ids, each an integer that exists. 200:

```json
{ "deleted": 2, "failed": 0, "skipped": 1, "message": "Deleted 2 videos (1 skipped: still processing)." }
```

Videos still processing are skipped; per-video failures are counted. Errors: 422 (`selected_ids`, `selected_ids.N` for unknown ids, more than 100 ids).

## POST /api/app/videos/{video}/image

`multipart/form-data` with `image`: required file, `jpg|jpeg|png|webp`, at most 5 MB (5120 KB). The type is verified from the file content (MIME sniffing), not only the extension. There is no dimension limit (same as the web admin). Stored on R2 at `<video folder>/custom-<folder name>.<ext>`; replacing with another extension removes the old object. Throttle: 20/min.

200: `{"label": "Custom image", "url": "https://cdn.example.com/.../custom-....jpg?v=1793700000"}`

Errors: 404; 422 validation (`image`); 422 `{"error": "no_storage_folder", "message": ...}` (video has no R2 folder yet); 500 `{"error": "image_store_failed", "message": ...}`; 429.

## DELETE /api/app/videos/{video}/image

200 `{"ok": true}`. Errors: 404 `not_found` (video) or 404 `{"error": "no_custom_image", ...}`; 500 `{"error": "image_delete_failed", ...}` (the record keeps the path so the delete can be retried).

## GET /api/app/overview

The numbers of the web overview dashboard. 200:

```json
{
    "videos": { "total": 5, "ready": 2, "processing": 2, "failed": 1 },
    "system": {
        "cpu_percent": 12, "cpu_cores": 4, "load_avg_1min": 0.5,
        "ram_percent": 40, "ram_used_gb": 3.1, "ram_total_gb": 8,
        "disk_percent": 55, "disk_used_gb": 20.5, "disk_total_gb": 40
    }
}
```

`processing` counts `pending` and `processing`. CPU and RAM values are `null` when the server cannot report them (non-Linux hosts).

## GET /api/app/logs

The web Logs page as JSON. Item shape (`LogItem`): `id, public_id, title, original_filename, status, stage, progress, error_message, error_detail, failed_at, created_at, updated_at`.

- Without `type`: web-page summary, 200:
  `{"counts": {"total","success","error","processing"}, "success": [LogItem x10 newest], "error": [LogItem x10 newest failures], "processing": [LogItem x25 oldest first]}`.
- With `type=success|error|processing` (plus optional `page`, `per_page` 1..50 default 24): paginated like the video list, 200:
  `{"counts": {...}, "data": [LogItem], "meta": {"page","per_page","total","last_page"}}`.

Errors: 422 (`type`, `page`, `per_page`).

## Deploy notes

No migration is needed for these endpoints.
