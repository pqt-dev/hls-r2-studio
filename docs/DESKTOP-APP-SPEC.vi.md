# Spec: Desktop app (Windows) + Site dashboard

Trạng thái (cập nhật 2026-11-03): Phase A (site) ĐÃ deploy lên VPS và đang dùng thật. Phase B (app Windows) đã viết xong và test (unit + integration với fake S3/site), CHƯA build installer trên Windows (chờ lần chạy CI đầu tiên + kiểm tra thủ công). Phase C (dọn site) chưa bắt đầu. Spec này đã đồng bộ theo code thực tế; các chỗ khác bản duyệt ban đầu liệt kê ở mục 9. Đối tượng đọc: chủ dự án và dev/agent triển khai.
Quy ước: MUST = bắt buộc, SHOULD = nên làm, MAY = tuỳ chọn. Thông báo lỗi/UI text trong code luôn bằng tiếng Anh.

## 0. Mục tiêu và phạm vi

Tách quy trình băm video khỏi site:

- **App Windows** (milestone này; macOS làm sau): chọn file → transcode HLS → thumbnail + storyboard → upload R2 → đăng ký video lên site. Toàn bộ qua GUI, một file installer `.exe`, không cần cài thêm gì (ffmpeg/ffprobe đóng gói kèm).
- **Site (VPS)**: admin dashboard — danh sách video đã `ready`, sửa title, xoá video (xoá cả R2 prefix), report, settings, trang embed công khai. Không còn upload, queue, ffmpeg.
- Không đồng bộ queue/progress/trạng thái job giữa app và site (chỉ lưu local ở app). Site chỉ cần reload để thấy dữ liệu mới. Realtime làm sau (xem `TODO.md`).

## 1. Các quyết định đã chốt

| # | Quyết định |
|---|---|
| 1 | Một tài khoản admin duy nhất. `Setting` giữ dạng singleton (id=1), không thêm `user_id` ở milestone này. |
| 2 | Site và app đều phải đăng nhập. App đăng nhập bằng username/password của tài khoản site và nhận token Sanctum (thu hồi được). |
| 3 | Config R2 (access key id, secret, bucket, endpoint, public url) lưu trong DB (`settings`), `access_key_id` và `secret_access_key` mã hoá bằng cast `encrypted`. App lấy config qua API sau khi đăng nhập. |
| 4 | R2 secret trong app CHỈ giữ trong bộ nhớ (không ghi xuống đĩa, không gửi sang renderer). Token đăng nhập mã hoá bằng Electron `safeStorage` (DPAPI trên Windows); bỏ chọn "Stay signed in" hoặc không có `safeStorage` thì token chỉ nằm trong RAM của phiên. |
| 5 | Video mới có `public_id` ngẫu nhiên 12 ký tự `[a-z0-9]`; video cũ backfill `public_id = (string) id`. Embed URL: `/embed/{public_id}`. |
| 6 | Prefix R2: `{Y}/{m}/{d}/{slug}-{public_id}/` (giữ rule cũ, chỉ thay `{id}` bằng `{public_id}`). Ngày theo UTC (khớp `config('app.timezone')=UTC` hiện tại). |
| 7 | App tự sinh `public_id`, không gọi API trước khi upload. Chỉ MỘT lần gọi cuối (`register`) sau khi upload R2 thành công; site chỉ lưu video ở trạng thái `ready` → không có row treo. |
| 8 | Công nghệ app: Electron + TypeScript, đóng gói bằng electron-builder (NSIS). |
| 9 | Queue, progress, trạng thái job chỉ lưu local ở app. |
| 10 | Snippet WordPress (WPCode) phải đổi regex id thành `^[a-z0-9]{1,32}$` (id số cũ vẫn khớp). |

## 2. Kiến trúc và luồng

```
App Windows                                   Site (Laravel, VPS)                  R2
-----------                                   -------------------                  --
POST /api/app/login  -------------------------> xác thực, cấp token
GET  /api/app/config -------------------------> trả config R2 (giải mã) + transcode
sinh public_id, tính prefix
ffmpeg → HLS, thumbnail, storyboard (local)
upload từng file ------------------------------------------------------------------> PutObject
POST /api/app/videos (register) ---------------> kiểm tra playlist tồn tại trên R2 <- HEAD
                                                 tạo row status=ready, trả embed_url
```

Lỗi/Cancel giữa chừng: app tự xoá phần đã upload lên R2 (best-effort) và xoá thư mục tạm; site không biết gì. Ngoại lệ: khi đã upload xong mà register thất bại không dứt khoát (mạng, 5xx, 401...), file trên R2 được GIỮ để Retry register (chi tiết ở mục 4.4).

## 3. SITE

Triển khai theo 3 phase (xem mục 5). Mục 3.1-3.8 (Phase A) đã triển khai và deploy; mục 3.9 (Phase C) chưa làm. Phase A tương thích ngược: luồng upload cũ vẫn chạy.

### 3.1 Database

Migration mới (không sửa migration cũ):

1. `videos.public_id`: string(32), thêm nullable → backfill `UPDATE videos SET public_id = CAST(id AS CHAR)` → đặt NOT NULL + UNIQUE index.
2. `settings`: đổi `r2_access_key_id` và `r2_secret_access_key` sang `text` (ciphertext dài hơn 255). Các cột `r2_*` đã tồn tại nhưng đang không dùng.
3. Cài `laravel/sanctum` (hiện chưa có): migration `personal_access_tokens`.

### 3.2 public_id

- Sinh: 12 ký tự từ `abcdefghijklmnopqrstuvwxyz0123456789`, dùng nguồn ngẫu nhiên an toàn (`random_int`), không dùng `Str::random`/`uniqid`.
- Model `Video`: thêm `public_id` vào `$fillable`; hook `creating` tự sinh nếu rỗng (để luồng upload cũ vẫn tạo video hợp lệ ở Phase A), thử lại nếu trùng.
- Route embed: `GET /embed/{video:public_id}` (chỉ route này đổi; mọi route admin `{video}` giữ id số). Khi sinh URL phải truyền tường minh `route('embed.show', ['video' => $video->public_id])` (không dựa vào cơ chế route-key ngầm).
- Video cũ phải còn truy cập được ở `/embed/{id số}` (nhờ backfill).

### 3.3 Config R2 trong DB

- `Setting`: thêm `r2_access_key_id`, `r2_secret_access_key`, `r2_bucket`, `r2_endpoint`, `r2_url` vào `$fillable`; cast `encrypted` cho hai cột bí mật; `$hidden` cho hai cột đó.
- `Setting::r2Disk()` đọc từ DB; trong giai đoạn chuyển tiếp (đến hết Phase C) fallback về `config('filesystems.disks.r2')` (env) khi DB chưa có.
- Lệnh `php artisan r2:import-env`: copy giá trị từ env vào DB nếu DB còn trống (idempotent, không ghi đè). Sau Phase C bỏ các biến `R2_*` khỏi `.env`/`.env.example`/`config/filesystems.php`/docs.
- Validation khi lưu: `r2_endpoint` rule `url:https`, bucket/endpoint/url bắt buộc khi lưu form; bỏ trống ô secret = giữ giá trị cũ.
- Không bao giờ log hoặc flash secret; view chỉ hiển thị "đã cấu hình" + 4 ký tự cuối của access key id.
- Ghi chú vận hành: secret mã hoá bằng `APP_KEY` → PHẢI backup `APP_KEY`; đổi key cần dùng `APP_PREVIOUS_KEYS`.

### 3.4 Xác thực token (Sanctum)

- `User` dùng `HasApiTokens`. `config/sanctum.php`: `guard => []` (chỉ token, không SPA/cookie), `expiration` = 129600 phút (90 ngày). Token tạo với `expires_at = now + expiration`; app xử lý 401 bằng cách quay lại màn hình đăng nhập.
- Mọi route `/api/app/*` (trừ login) dùng middleware `auth:sanctum`. Lỗi xác thực trả JSON 401. Đăng nhập web và secret login key không bị ảnh hưởng.
- Middleware `NoStoreResponse` áp cho TOÀN BỘ nhóm `/api/app/*` (kể cả login): mọi response kèm `Cache-Control: no-store`.
- Đổi mật khẩu (`SettingsController::updatePassword`) MUST thu hồi toàn bộ token app.
- Rate limit (khai báo trong `AppServiceProvider`): `app-login` = 5 lần/phút theo key `IP|sha1(username viết thường)`; `app-api` = 60/phút theo id token (dự phòng user id, rồi IP). Lỗi đăng nhập trả message chung `Incorrect username or password.` (không lộ username có tồn tại hay không; username không tồn tại vẫn tốn thời gian băm tương đương) và log cảnh báo chỉ kèm IP (không log username).

### 3.5 API contract (`routes/api.php`, prefix `/api/app`)

Tất cả response JSON; request JSON; mọi response kèm `Cache-Control: no-store` (mục 3.4). Mã lỗi nghiệp vụ nằm ở field `error` của body.

**POST /api/app/login**
- Body: `username` (required string), `password` (required string), `device_name` (required string, max 100; app gửi hostname máy, cắt còn 100 ký tự, rỗng thì `Desktop app`).
- 200: `{ "token": "<plain token>", "user": { "username": "..." } }`. Token tạo với tên = `device_name`.
- 422: thiếu field hoặc sai thông tin (lỗi validation chuẩn của Laravel, message chung). 429: vượt rate limit (kèm `Retry-After`).

**POST /api/app/logout** (auth) → 204, thu hồi token hiện tại.

**GET /api/app/config** (auth) → 200:
```json
{
  "r2": { "access_key_id": "...", "secret_access_key": "...", "bucket": "...", "endpoint": "https://<acct>.r2.cloudflarestorage.com", "url": "https://cdn.example.com" },
  "transcode": { "resolution": "720", "segment_seconds": 6, "fps": null }
}
```
- `resolution` là chuỗi, `segment_seconds` int, `fps` int hoặc null.
- Nếu một trong 5 giá trị R2 trống: 409 `{ "error": "r2_not_configured" }` (app coi đây là trạng thái bình thường: hiện banner, job ở Waiting).
- Cũng dùng để app kiểm tra token còn hiệu lực khi khởi động. Phía app MUST từ chối config có `endpoint`/`url` không phải https (http chỉ cho localhost ở bản dev) hoặc chứa credentials trong URL, vì R2 credentials được gửi tới `endpoint`.

**POST /api/app/videos** (auth) — đăng ký video đã upload xong:
- Body (validate chặt):
  - `public_id`: `required|regex:/^[a-z0-9]{12}$/D`
  - `title`: `required|string|max:255`
  - `original_filename`: `required|string|max:255`; `original_size_bytes`: `required|integer|min:1`
  - `disk_prefix`: `required|string|max:255` và khớp `/^\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-{public_id}\/$/D` (phải kết thúc bằng `-{public_id}/` và khớp `public_id` gửi lên)
  - `playlist_path`: `max:255`, bằng `disk_prefix.'playlist.m3u8'`; `thumbnail_path`: nullable, `max:255`, bằng `disk_prefix.'thumbnail.jpg'`
  - `storyboards`: nullable object, chỉ nhận key `3x3|4x4|5x5`, mỗi mục đúng một key `{ "path": disk_prefix.'storyboard_NxN.jpg' }` (path ≤ 255)
  - `duration`: nullable numeric ≥ 0; `output_width`, `output_height`: nullable int 1..65535; `output_fps`: nullable numeric 0..999.99; `output_bitrate_kbps`: nullable int 0..4294967295; `output_codec`: nullable string max 20
  - Giới hạn 255 khớp cột `varchar(255)`; app MUST kiểm tra trước khi upload (mục 4.4).
- Hành vi (theo thứ tự):
  1. Idempotency TRƯỚC validation đầy đủ: nếu `public_id` hợp lệ (12 ký tự) và đã có video → không validate thêm, không gọi R2: cùng `disk_prefix` → 200 trả lại video hiện có (app gọi lại sau lỗi mạng không tạo trùng, kể cả khi các field khác khác đi); `disk_prefix` khác hoặc thiếu → 409 `{ "error": "public_id_conflict" }`.
  2. Validate các field ở trên (lỗi → 422 dạng validation chuẩn của Laravel).
  3. Kiểm tra `playlist_path` tồn tại trên R2 bằng `r2Disk()->exists()`. R2 lỗi (exception) → 503 `{ "error": "storage_unavailable" }` (không lộ chi tiết); không có file → 422 `{ "error": "playlist_not_found" }`.
  4. Tạo `Video` với `status=ready`, `stage=ready`, `progress=100`. Nếu đụng unique `public_id` do request song song: đọc lại, cùng `disk_prefix` → 200, khác → 409.
- 201 (hoặc 200 khi lặp): `{ "id": 123, "public_id": "ab12cd34ef56", "embed_url": "https://<site>/embed/ab12cd34ef56" }`.
- Mã `error` của endpoint này: `playlist_not_found` (422), `public_id_conflict` (409), `storage_unavailable` (503); của config: `r2_not_configured` (409).

### 3.6 Report: sửa `resolveVideoIdFromPageUrl`

`Api\ReportController::resolveVideoIdFromPageUrl` hiện yêu cầu segment cuối `ctype_digit` rồi `Video::whereKey((int))` → hỏng với id mới (report của video mới sẽ có `video_id = null`).
- Đổi: segment cuối khớp `^[a-z0-9]{1,32}$` → `Video::where('public_id', $x)->value('id')` (trả `?int` id số cho FK `reports.video_id`). Id số cũ vẫn chạy nhờ backfill.
- Phần còn lại của report (gộp theo `page_url`, `report_count`, submissions) không đổi.
- Rà các view Reports có link tới video/embed; cập nhật test của hàm này.

### 3.7 Dashboard, shortcode và WordPress

- `videos/_row.blade.php`: `$embedUrl = route('embed.show', ['video' => $video->public_id])`. `copyEmbedShortcode` lấy segment cuối của embed URL nên tự dùng `public_id` (kiểm tra lại, giữ hành vi `ratio` chỉ thêm khi khác `16 / 9`).
- Thư mục `docs/wordpress-snippets/`: đổi regex id trong `hls-embed.php`, `hls-embed.wpcode.php` từ `/^[0-9]{1,18}$/` sang `/^[a-z0-9]{1,32}$/` (và sửa comment "auto-increment integers"); `hls-migrate.wpcode.php` GIỮ NGUYÊN (công cụ chuyển đổi một lần cho iframe cũ dùng id số; mở rộng sang `[a-z0-9]` sẽ làm bộ đếm "Not matched" bắt nhầm iframe của site khác như YouTube); chỉ cập nhật các regex WP-CLI trong comment header của `hls-embed.php`. Id số cũ vẫn phải khớp.
- NHẮC TRIỂN KHAI (không được quên): sau khi deploy Phase A phải cập nhật snippet WPCode trên WordPress + purge cache (plugin cache và Cloudflare) TRƯỚC khi nhúng video có id mới.

### 3.8 Settings UI (Blade, giữ kiểu "mỗi card một form PUT")

- Card **Storage (R2)** mới: nhập các giá trị mục 3.3, route `PUT /settings/r2` (`r2_endpoint` và `r2_url` đều `url:https`). Nút "Test connection" (`POST /settings/r2/test`, throttle 10/phút) ghi rồi xoá object `_connection-test/<random>.txt`, báo thành công/lỗi chung (không lộ chi tiết SDK).
- Card **Desktop app access** mới: bảng token (tên thiết bị, ngày tạo, `last_used_at`) + nút Revoke từng token (`DELETE /settings/app-tokens/{token}`, chỉ token của chính user, id lạ → 404) + Revoke all (`DELETE /settings/app-tokens`).
- Giữ nguyên các card Transcode, Display, Embed, Password.

### 3.9 Dọn dẹp site (Phase C, chỉ làm sau khi app đã dùng ổn)

Xoá (theo khảo sát code hiện tại; rà lại bằng grep trước khi xoá):
- Routes: `/upload`, `/uploads/init`, `/uploads/{uploadId}/chunk`, `/uploads/{uploadId}/complete`, `/videos/in-progress-count`, `/videos/status`, `/videos/{video}/status-log`, `/activity-log` (GET/POST).
- `VideoController`: `create`, `initUpload`, `uploadChunk`, `completeUpload`, `status`, `inProgressCount`, `statusLog` + helper/constant liên quan upload; `ActivityLogController`.
- Jobs: `TranscodeVideoJob`, `MergeUploadChunksJob`, `Jobs/Concerns/FailsVideo`.
- Commands + scheduler: `uploads:cleanup-abandoned`, `videos:cleanup-orphaned-tmp`, `videos:cleanup-orphaned-uploads` (giữ `admin:create`).
- Support/Services: `FfmpegCommand`, `UploadAssembler`, `VideoProgress`, `VideoStatusLogger`, `ActivityLog`, `ThumbnailGenerator`, `StoryboardGenerator` (giữ `StoryboardGenerator` constants cần cho embed nếu có dùng — kiểm tra `EmbedController`), `StorageConfigurationException`.
- Model/bảng: `VideoStatusLog` + `video_status_logs` (migration drop), `Video::scopeInProgress/inProgressSnapshot` + View composer trong `AppServiceProvider`, rate limiter `upload-init`, `upload-chunk`, `activity-log`.
- Broadcasting: `Events/VideoStatusUpdated`, `config/broadcasting.php`, `config/reverb.php`, `laravel/reverb`, `resources/js/echo.js`, biến `REVERB_*`/`VITE_REVERB_*`, `BROADCAST_CONNECTION`.
- Config `config/videos.php`: các khoá upload/queue/progress/activity_log/transcode_timeout/storyboard_* (giữ `storyboard_tile_size` vì `EmbedController` đang dùng), `config/services.php` `ffmpeg.*`; `.env.example`: `QUEUE_CONNECTION`, `DB_QUEUE_RETRY_AFTER`, `FFMPEG_*`, `R2_*`.
- Blade/JS: `videos/create.blade.php`, vòng tiến trình trong `layouts/app.blade.php`, link Upload ở sidebar, `logs/index.blade.php` (trang Logs chỉ còn danh sách trùng với trang Videos → đề xuất xoá), `resources/js/in-progress-badge.js`, `video-progress.js`, phần liên quan upload trong `soft-navigation.js`.
- Overview: bỏ thẻ đếm pending/processing/failed; giữ tổng số + ready.
- Videos index: chỉ liệt kê `status='ready'`.
- Tests: xoá các test của phần bị gỡ (ChunkedUploadTest, InitUploadDiskSpaceTest, UploadRateLimitTest, UploadPageLayoutTest, UploadActivityLogMarkupTest, ActivityLogTest, CleanupAbandonedUploadsTest, CleanupOrphanedTranscodeTmpTest, CleanupOrphanedUploadsTest, MergeUploadChunksJobTest, TranscodeVideoJob*Test, InProgressBadgeTest, VideoStatusEndpointsTest, FfmpegCommandTest, VideoProgress*Test, LogsPageTest); sửa PagesRenderTest, AuthProtectedRoutesTest, DashboardOverviewTest, SettingsTranscodeTest cho khớp.
- Deploy: bỏ systemd units queue workers và reverb, bỏ scheduler entries; cập nhật `docs/DEPLOYMENT*.md`, `README*.md`. Dữ liệu cũ (video đã `ready`) giữ nguyên.
- Giữ nguyên: `storeImage`/`destroyImage` (ảnh custom), `update` (sửa title), `destroy`/`bulkDestroy` (xoá R2 prefix + row, dùng `r2Disk()` từ DB), reports, settings, embed.

### 3.10 Test cho site

- Feature test: login (thành công/sai/throttle), logout thu hồi token, config (đủ/thiếu R2, không token → 401), register (hợp lệ, idempotent, conflict, validation prefix/path, playlist không tồn tại với `Storage::fake`), `Setting` mã hoá cột trong DB (đọc raw DB phải là ciphertext), `r2:import-env`, embed theo `public_id` + id số cũ, report resolve với id mới và id cũ, migration backfill, đổi mật khẩu thu hồi token.
- Không chạy full PHPUnit khi đang test thủ công (xem ghi chú dự án về `hls_tmp`).
- Đã có (Phase A): `AppApiLoginTest`, `AppApiConfigTest`, `AppApiVideoRegisterTest` (gồm idempotent, race, giới hạn 255), `AppTokenSettingsTest`, `SettingsR2ConfigTest`, `SettingsR2Test`, `ImportR2EnvCommandTest`, `VideoPublicIdMigrationTest`, `EmbedShowTest`, `ReportApiTest`.

## 4. APP WINDOWS

### 4.1 Stack và cấu trúc

- Electron 45 + TypeScript + Vite (electron-vite); UI React 19. Repo: thư mục `desktop-app/` trong monorepo này, `package.json` + lockfile riêng, Node >= 22.12 (CI dùng Node 24). Chi tiết kiến trúc, bảng IPC và sơ đồ trạng thái job: `desktop-app/README.md`.
- Tiến trình: **main** (Node: ffmpeg, upload R2, HTTP tới site, lưu trữ) và **renderer** (UI thuần, không có Node). Giao tiếp qua `preload` (`window.hlsApi`) + IPC có kiểu (`shared/ipc.ts`).
- Module chính (main): `api` (client site, quy tắc URL), `auth` (máy trạng thái đăng nhập), `config` (giữ config trong RAM), `queue` (hàng đợi + máy trạng thái job), `settings`, `pipeline` (prefix, transcode, thumbnail, storyboard, upload, register, cleanup), `ffmpeg` (xây args, chạy process, parse progress, self-check), `store` (JSON local), `secure` (safeStorage + TokenVault), `logger`, `security` (điều hướng, openExternal, session), `ipc`, `lifecycle` (xác nhận đóng/thoát, lỗi khởi động).
- Phần logic thuần (slug, prefix, build args, parse progress, chọn thumbnail/storyboard) không import Electron (phần phụ thuộc Electron được inject qua interface nhỏ) để test bằng Vitest.

### 4.2 Installer và ffmpeg

- `electron-builder` target NSIS x64, `oneClick: true`, cài theo user (`perMachine: false`, `allowElevation: false`, không đòi quyền admin), shortcut Start Menu/Desktop. Một file `HLS-R2-Studio-Setup-<version>.exe`; người dùng không phải cài thêm runtime hay ffmpeg. `publish: null` (không auto-update).
- `ffmpeg.exe` và `ffprobe.exe` nằm ngoài `app.asar` (`extraResources` → `resources/bin/`); bản đóng gói gọi bằng đường dẫn tuyệt đối từ `process.resourcesPath`, KHÔNG dùng PATH (chỉ bản dev mới dùng `FFMPEG_PATH`/`FFPROBE_PATH` hoặc PATH).
- ffmpeg được ghim: gyan.dev "essentials" 9.0.2 (Windows x64, static, GPL v3, lấy qua mirror GitHub release). `ffmpeg.lock.json` ghim URL, SHA-256 của archive và của từng file giải nén. `scripts/fetch-ffmpeg.mjs` (chạy ở `predist:win` và CI) MUST kiểm SHA-256 archive TRƯỚC khi mở, chỉ giải nén `ffmpeg.exe`, `ffprobe.exe`, `LICENSE`, `README.txt` (chặn `..`, đường dẫn tuyệt đối, ký tự ổ đĩa/backslash), kiểm lại hash từng file, rồi xoá file tạm nếu lỗi. Không bao giờ thực thi binary tải về trong script. Quy trình nâng version: `desktop-app/docs/PACKAGING.md`.
- Khi khởi động app MUST tự kiểm tra ffmpeg (chạy nền, job chờ cho đến khi xong): chạy `ffmpeg -hide_banner` với `-version`, `-encoders`, `-filters`, `-muxers`; xác nhận có encoder `libx264`, `aac`, muxer `hls`, filter `scale`, `thumbnail`, `signalstats`, `edgedetect`, `hstack`, `tile`, `crop`, `fps`, `movie`. Thiếu thì hiện banner lỗi liệt kê phần thiếu và chặn xử lý (job ở Waiting).
- Electron Fuses (đặt qua `electronFuses` trong `electron-builder.yml`): `runAsNode=false`, `enableNodeOptionsEnvironmentVariable=false`, `enableNodeCliInspectArguments=false`, `enableEmbeddedAsarIntegrityValidation=true`, `onlyLoadAppFromAsar=true`, `enableCookieEncryption=true`. `grantFileProtocolExtraPrivileges` CỐ Ý không đặt (giữ mặc định) vì renderer là bản build Vite nạp bằng `loadFile` (`file://`); tắt fuse này có nguy cơ cửa sổ trắng. Xem lại chỉ khi chuyển sang custom protocol. Fuses chưa được chạy thử trên Windows.
- Chuỗi cung ứng npm: `desktop-app/.npmrc` có `ignore-scripts=true` (và `replace-registry-host=always`); CI dùng `npm ci --ignore-scripts`; dev cần `npx install-electron` một lần trước `npm run dev`. Dependabot hằng tuần cho GitHub Actions và npm của `desktop-app`; mọi action ghim theo commit SHA.
- Giấy phép: `LICENSES/THIRD-PARTY-NOTICES.txt` (sinh bởi `npm run gen:notices`, FAIL nếu gặp license lạ hoặc ngoài allow-list) và `LICENSES/ffmpeg/` được kèm vào installer; Electron/Chromium license nằm cạnh exe. About hiện phiên bản ffmpeg, thông báo GPL và nút Open licenses. Nghĩa vụ GPL khi phát hành ra ngoài tổ chức: mục 8.
- Ký số: installer KHÔNG ký (quyết định đã chốt), SmartScreen sẽ cảnh báo ("More info" → "Run anyway"); ghi trong release notes. Nâng cấp bằng cài đè bản mới (cùng `appId`, giữ dữ liệu trong `%APPDATA%`, kể cả khi gỡ cài đặt).
- Build: workflow `.github/workflows/desktop-app-windows.yml` (runner `windows-latest`): PR chỉ chạy typecheck/lint/test; `workflow_dispatch` và tag `desktop-v*` (phải bằng `desktop-v<version>` trong `package.json`) build thêm `--dir`, NSIS, `verify-dist.mjs` (kiểm file + sinh `SHA256SUMS.txt`), và tag tạo DRAFT release. Cấu hình đóng gói CHƯA từng chạy thực tế (dev trên macOS), lỗi nếu có sẽ lộ ở lần CI đầu tiên.

### 4.3 GUI

Cửa sổ mặc định 1100x720, tối thiểu 760x520; chỉ cho một instance (mở lần hai thì focus cửa sổ cũ). Mọi text UI bằng tiếng Anh.

1. **Đăng nhập**: URL site (https; chỉ cho phép `http://localhost` ở bản dev), username, password, checkbox "Stay signed in" (mặc định bật; tắt = token chỉ trong RAM, mất khi thoát app). Lỗi hiển thị bằng tiếng Anh, không lộ chi tiết (429 hiện số giây chờ). Sau đăng nhập gọi `GET /api/app/config`. Khi khởi động, nếu có token lưu sẵn thì tự kiểm tra bằng cùng lời gọi đó.
2. **Màn hình chính**: thanh trên (username, host site, chip "Offline" khi mất kết nối) và 3 tab **Queue / Settings / About** (điều hướng được bằng phím mũi tên).
   - **Queue**: banner trạng thái (video tools lỗi, không kết nối site + nút Reload config, site chưa cấu hình R2, có video cần đăng nhập lại để register); vùng kéo-thả / nút "Add videos" (nhiều file: mp4, mov, mkv, avi, webm; file trùng đường dẫn với job chưa kết thúc bị từ chối kèm lý do). Mỗi hàng: tên file, dung lượng, trạng thái (Waiting, Transcoding, Thumbnail, Storyboard, Uploading, Registering, Done, Failed, Cancelled, Interrupted, Register failed, Sign-in needed), thanh progress tổng, thời gian, và nút Cancel (hỏi xác nhận khi đang chạy) / Retry / Retry register / Remove; job Done có Copy embed URL / Copy shortcode (`[hls_embed_vl id="<public_id>"]`) / Open on site (chỉ mở URL https cùng host với site đang đăng nhập). Job Failed, Register failed và Interrupted có **View details** (modal: file, trạng thái, thông báo lỗi, bước lỗi, mã thoát, ~200 dòng cuối stderr của ffmpeg đã che đường dẫn cá nhân, nút Copy). Có nút "Clear finished" (hỏi xác nhận) và dòng đếm running/waiting/done/failed.
   - **Settings**: card Site (URL; đổi sang site khác sẽ đăng xuất và hỏi xác nhận; bị từ chối khi còn job đang chạy hoặc còn job đã upload chờ register), card Processing (thư mục tạm, mặc định `%TEMP%\hls-r2-studio`, nhập tay hoặc "Choose folder…" mở hộp thoại thư mục; số job song song 1-2, mặc định 1), card Account (nút "Reload config", nút "Sign out", hỏi xác nhận nếu còn job chạy). Không cho đổi thư mục tạm khi còn job chạy.
   - **About**: phiên bản app, platform, phiên bản ffmpeg (hoặc danh sách tính năng thiếu), nút **Open logs folder**, nút **Open licenses** (mở `THIRD-PARTY-NOTICES.txt`), thông báo giấy phép FFmpeg (GPL).
- Nhiều file thêm cùng lúc: sắp file nhỏ trước trong lô đó; các lô sau xếp nối tiếp (FIFO). Đóng cửa sổ/thoát khi còn job đang chạy: hỏi "Quit and cancel them?"; đồng ý thì huỷ job (dọn R2/thư mục tạm), ghi store rồi thoát (chờ tối đa 15 s). Không thu nhỏ xuống tray (MAY, chưa làm).

### 4.4 Pipeline chi tiết (port đúng từ code PHP hiện tại)

Tất cả tiến trình con chạy bằng `spawn` với mảng args (không shell, `windowsHide`), `cwd = thư mục tạm của job`, tên file đầu ra dùng đường dẫn tương đối ASCII đơn giản (tránh lỗi escape ký tự `:`/`\` của filter lavfi `movie=`; code chỉ nhận tên khớp `[A-Za-z0-9._-]+` cho `movie=`). Sau khi spawn, hạ độ ưu tiên tiến trình xuống `BELOW_NORMAL` (`os.setPriority`, best-effort; tương đương `nice`). Mọi lệnh ĐỌC file nguồn (ffprobe duration/fps, transcode, trích frame thumbnail, trích ứng viên storyboard) MUST thêm input option `-format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi` (allow-list demuxer cho đúng 5 container được phép), để file đổi đuôi (vd playlist HLS/concat đặt tên `.mp4`) không khiến ffmpeg đọc file khác hoặc URL.

**Bước 0 – chuẩn bị**
- Kiểm tra file input tồn tại, là file thường, không rỗng, đuôi hợp lệ (mp4, mov, mkv, avi, webm); kiểm tra ổ chứa thư mục tạm còn trống ≥ `size × 1.5 + 1 GiB`, thiếu thì fail sớm.
- `public_id` (12 ký tự `[a-z0-9]`, `crypto.randomInt`) do hàng đợi sinh khi job bắt đầu (job Retry luôn nhận `public_id` mới).
- Tạo thư mục tạm `<tmpRoot>/<public_id>/` (xoá nếu đã tồn tại).

**Bước 1 – prefix** (`{Y}/{m}/{d}/{slug}-{public_id}/`)
- `Y/m/d` theo UTC tại thời điểm bắt đầu job.
- `slug`: tương đương `Str::slug(pathinfo($filename, PATHINFO_FILENAME))` của Laravel: bỏ đuôi, chuyển ASCII bằng bảng sinh sẵn từ `Str::ascii` của PHP (`scripts/gen-ascii-table.php`; xử lý tiếng Việt, `đ→d`, Latin, Hy Lạp, Cyrillic...), lowercase, ký tự không phải chữ/số → `-`, gộp và trim `-`; rỗng → `video`. Hạn chế đã biết: chữ CJK, Ả Rập, Do Thái, Thái... không có trong bảng nên bị bỏ (PHP sẽ phiên âm), slug có thể ngắn hơn hoặc thành `video`; kết quả vẫn luôn khớp `[a-z0-9-]+`.
- Slug LUÔN bị cắt tối đa 100 ký tự (không chỉ khi key dài) và bỏ `-` cuối, để mọi path đăng ký (prefix + tên file dài nhất `storyboard_5x5.jpg`) ≤ 255 ký tự khớp `varchar(255)` của site. Độ dài MUST được kiểm tra ngay (trước transcode/upload); không hợp lệ thì job Failed "file name too long".
- Test tương đương bắt buộc: bảng ≥ 30 mẫu (tiếng Việt có dấu, `Đ`, emoji, nhiều khoảng trắng, chữ hoa, chỉ ký hiệu, tên rất dài, nhiều dấu chấm) với kết quả sinh từ PHP (`Str::slug`) làm "golden" (`scripts/gen-slug-golden.php` → `slug-golden.json`).

**Bước 2 – probe**
- `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <input>` (timeout 60 s; exit ≠ 0 → fail job; không phải số hoặc ≤ 0 → duration = null và vẫn tiếp tục).
- `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 <input>` → fps nguồn (`num/den`; không dùng được thì 0). CHỈ chạy khi `transcode.fps` của config là null (giống job PHP); nếu config có fps thì dùng thẳng giá trị đó cho GOP. Exit ≠ 0 → fail job.
- Cả hai lệnh đều có `-format_whitelist` (xem đầu mục 4.4).

**Bước 3 – transcode HLS**
```
ffmpeg -y -format_whitelist <demuxers> -i <input>
  -vf "scale='min(<maxWidth>,iw)':-2"
  -c:v libx264 -preset veryfast -crf 23
  -g <gop> -keyint_min <gop> -sc_threshold 0
  [-r <fps>]                       # chỉ khi config transcode.fps != null
  -c:a aac -b:a 128k
  -hls_time <segment_seconds> -hls_playlist_type vod
  -hls_segment_filename segment_%03d.ts
  -progress pipe:1 -nostats
  playlist.m3u8
```
- `maxWidth`: `480→854`, `720→1280`, `1080→1920`, giá trị khác → 1280. Không upscale, chiều cao chẵn.
- `gop = max(1, round(outputFps × segment_seconds))`, `outputFps` = `transcode.fps` hoặc fps nguồn.
- Không thêm bitrate cap, `-pix_fmt`, `-profile`, `-movflags`, `-hls_flags`, `-map` (giữ đúng hành vi hiện tại). Segment là MPEG-TS `.ts`.
- Progress: đọc stdout dạng `key=value`; dùng `out_time_us` (nếu không có thì `out_time_ms`, giá trị này thực chất là micro-giây); `fraction = (out_time/1e6)/duration`, chỉ tăng không giảm; bỏ qua nếu duration null/≤0.
- Timeout: `duration` null → 172800 s; ngược lại `max(600, ceil(duration × 8))`. Hết giờ → kill cả cây tiến trình (`taskkill /T /F`) và fail job.
- Sau khi xong MUST có `playlist.m3u8` và `segment_000.ts` (thiếu thì fail). Rồi: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,bit_rate,codec_name -of json segment_000.ts` (timeout 60 s; đọc output của ffmpeg nên không cần `-format_whitelist`) → `output_width`, `output_height`, `output_fps` (làm tròn 2 chữ số), `output_bitrate_kbps` = `round(bit_rate/1000)` (thiếu `bit_rate` thì `round(bytes_segment×8/1000/segment_seconds)`), `output_codec`. Lỗi ffprobe → bỏ các trường đó (null), không fail job.

**Bước 4 – thumbnail** (`thumbnail.jpg`, không bắt buộc; lỗi chỉ log cảnh báo)
- Trích frame ứng viên: `ffmpeg -y -ss <ts> -i <input> -vf thumbnail=24 -frames:v 1 thumb_candidate_N.jpg` (timeout 60 s mỗi lệnh).
- `duration < 3 s`: trích 1 frame tại `duration/2` thẳng ra `thumbnail.jpg`.
- Ngược lại: ts = `duration × 0.25, 0.5, 0.75`, mỗi giá trị kẹp trong `[0, duration-0.5]`; chỉ thử thêm `0.1`, `0.9` khi chưa đủ 3 ứng viên đạt lọc.
- Chấm điểm bằng ffprobe (chạy với `cwd` = thư mục tạm, `movie=<tên-file-tương-đối>`):
  - `ffprobe -v error -f lavfi -i "movie=<img>,signalstats" -show_entries frame_tags=lavfi.signalstats.SATAVG -of default=noprint_wrappers=1:nokey=1`
  - `ffprobe -v error -f lavfi -i "movie=<img>,edgedetect,signalstats" -show_entries frame_tags=lavfi.signalstats.YAVG -of default=noprint_wrappers=1:nokey=1`
  - Loại ứng viên nếu saturation là null hoặc < 5.0, hoặc detail khác null và < 3.0. Điểm xếp hạng = `saturation + 5.0 × detail`.
- Ngang (`output_width > output_height`): cần ≥ 1 ứng viên giữ lại; tạo ảnh 1080×1080 bằng `smartCropToCanvas(frame, 1080, 1080)`.
- Dọc/vuông: cần 3 ứng viên (bù từ nhóm bị loại nếu thiếu); mỗi frame crop 360×1080 bằng `smartCropToCanvas`, sắp theo timestamp, ghép: `ffmpeg -y -i c0 -i c1 -i c2 -filter_complex "[0:v][1:v][2:v]hstack=inputs=3[v]" -map "[v]" -frames:v 1 thumbnail.jpg` (kết quả 1080×1080). Không đủ 3 → quay về ảnh đơn.
- `smartCropToCanvas(W,H)`: (1) `-vf scale=W:H:force_original_aspect_ratio=increase -frames:v 1`; (2) thử 3 offset cắt tại `maxOffset×i/2` (i=0,1,2) dọc trục dư, chấm bằng detail, giữ offset điểm cao nhất; (3) cắt chính thức `-vf crop=W:H:x:y -frames:v 1`; dọn file trung gian.

**Bước 5 – storyboard** (lỗi KHÔNG làm fail video; bỏ qua nếu duration null/≤0)
- `STORYBOARD_GRID_SIZES = [3,4,5]`, tile 160×160 (hằng số trong app, không đọc từ config site), `CANDIDATES_PER_SLOT = 3`, tổng ứng viên `3×5×5 = 75`.
- Trích một lượt: `ffmpeg -y -i <input> -vf "fps=75/<duration>,crop='min(iw\,ih)':'min(iw\,ih)',scale=160:160" -frames:v 75 -start_number 0 candidate_%04d.jpg`; timeout `max(60, ceil(duration × 2))`. Ứng viên N có timestamp `N × duration / 75`.
- Chấm điểm từng ứng viên bằng hai lệnh ffprobe ở bước 4 (4 ứng viên song song; timeout 60 s mỗi lệnh).
- Với mỗi lưới N (N×N ô): chia thời lượng thành N×N slot đều nhau; mỗi slot lấy ứng viên điểm cao nhất vượt bộ lọc, nếu không có thì ứng viên điểm cao nhất bất kỳ; slot rỗng dùng slot có dữ liệu gần nhất. Copy thành `tile_NxN_%04d.jpg` (đánh số từ 0 theo thứ tự slot), ghép: `ffmpeg -y -start_number 0 -i tile_NxN_%04d.jpg -vf tile=NxN -frames:v 1 storyboard_NxN.jpg` (timeout 60 s, file đầu ra phải tồn tại). Kích thước: 480×480, 640×640, 800×800. Lưới lỗi chỉ log và bỏ qua; cuối cùng xoá candidate/tile.
- `storyboards` gửi lên site: `{"3x3":{"path":"<prefix>storyboard_3x3.jpg"},...}` chỉ gồm các lưới có file; không có lưới nào thì `null`. KHÔNG có VTT/JSON/sprite metadata.

**Bước 6 – upload R2**
- Dùng `@aws-sdk/client-s3`: `region: "auto"`, `endpoint` từ config (MUST là https; http chỉ cho localhost ở bản dev), `forcePathStyle: true`, credentials từ config (RAM), `requestChecksumCalculation`/`responseChecksumValidation: WHEN_REQUIRED` (R2 không nhận trailer CRC32 mặc định của SDK mới trên upload dạng stream). Tạo một S3 client cho mỗi lần chạy job và `destroy()` khi xong (kể cả khi lỗi/cancel).
- File upload: các file cấp 1 trong thư mục tạm khớp `segment_NNN.ts`, `playlist.m3u8`, `thumbnail.jpg`, `storyboard_{3x3,4x4,5x5}.jpg`. Key = `<prefix> + <tên file>` (phẳng). Không upload `candidate_*`, `tile_*`, `thumb_candidate_*`.
- Song song 5 file (`UPLOAD_CONCURRENCY = 5`), mỗi file một `PutObject` (stream + `ContentLength`, không multipart). `playlist.m3u8` MUST upload SAU CÙNG, chỉ khi mọi file khác đã xong.
- `ContentType` đặt tường minh: `.m3u8 → application/vnd.apple.mpegurl`, `.ts → video/mp2t`, `.jpg → image/jpeg`. KHÔNG đặt `CacheControl` (giữ hành vi hiện tại) và KHÔNG gửi `ACL` (quyền public của R2 được cấu hình ở bucket/custom domain, không theo từng object); việc upload + truy cập file thật trên R2 chưa kiểm chứng (xem mục 6, 8).
- Retry: `withRetry` tối đa 3 lần cho MỖI file (chờ 1 s trước lần 2, 2 s trước lần 3). SDK KHÔNG được tự retry upload (client upload đặt `maxAttempts = 1`) vì body stream không phát lại được; client dùng cho cleanup (List/Delete) giữ `maxAttempts = 3`. Còn file lỗi sau đó → fail job ("Uploading to R2 failed...").
- Progress upload = số file đã xong / tổng số file.

**Bước 7 – register**
- Trước khi gọi, app MUST validate payload bằng bản sao các luật của site (mục 3.5, gồm giới hạn 255); lỗi → job Failed (đã upload thì dọn R2). Hàng đợi MUST flush store xuống đĩa SAU khi chuyển sang `registering` và TRƯỚC request register đầu tiên (`onBeforeRegister`), để nếu app chết giữa chừng thì job không bị lưu ở `uploading` trong khi video có thể đã được đăng ký (Retry sẽ coi R2 là rác).
- Gọi `POST /api/app/videos` (mục 3.5) với metadata đã thu thập; `title` = tên file bỏ đuôi. Request timeout 30 s, không follow redirect.
- Phân loại lỗi (chính xác theo code):
  - Lỗi mạng/timeout, 5xx, 429: thử lại tối đa 5 lần với backoff 1, 2, 4, 8, 16 s (429 có `Retry-After` hợp lệ thì dùng giá trị đó, tối đa 60 s). Hết lần thử → job `register_failed`, GIỮ file trên R2, payload lưu local để Retry register (không upload lại). An toàn vì API idempotent.
  - 401 → job `needs_sign_in`, GIỮ file trên R2; không retry ngay. Sau khi đăng nhập lại (cùng site) app tự gọi lại register.
  - CHỈ `422 playlist_not_found` và `409 public_id_conflict` là kết luận dứt khoát → job Failed và XOÁ prefix trên R2.
  - Mọi 4xx khác (kể cả 409/422 với mã khác): `register_failed`, GIỮ file, không retry tự động; người dùng bấm Retry register sau khi xử lý nguyên nhân.
- Thành công: job Done, lưu `{id, public_id, embed_url}` vào store local, xoá thư mục tạm.
- Cancel liên quan register: (a) bấm Cancel khi chưa gửi request nào → Cancelled và dọn R2 như cancel thường; (b) Cancel trong lúc chờ backoff giữa các lần thử → app KHÔNG gửi thêm request, job thành `register_failed` ("Registering was interrupted"), GIỮ file (request trước đó có thể đã tới site); request đang bay không bị huỷ giữa chừng; (c) Cancel một lần Retry register đang chạy → job quay lại trạng thái trước đó (`register_failed`/`needs_sign_in`); (d) Cancel job đang `register_failed`/`needs_sign_in` → Cancelled, file R2 KHÔNG bị xoá (site có thể đã đăng ký video).

**Cleanup khi lỗi/Cancel**
- Fail/Cancel trong pipeline: kill cây ffmpeg (`taskkill /PID <pid> /T /F` bằng đường dẫn tuyệt đối tới `System32\taskkill.exe`); nếu đã bắt đầu upload thì xoá toàn bộ prefix trên R2 (`ListObjectsV2` + `DeleteObjects`, best-effort, lỗi chỉ log; từ chối xoá nếu prefix không khớp định dạng hợp lệ); xoá thư mục tạm; job chuyển Failed/Cancelled với message tiếng Anh (có phần chi tiết rút gọn, che đường dẫn cá nhân).
- Các loại lỗi pipeline (`PipelineError.kind`): `failed`, `cancelled`, `register_failed`, `needs_sign_in`; chỉ `failed` có cờ `definitive` (xoá R2 sau lỗi register) khi site trả đúng hai mã ở trên.
- Ngoại lệ: lỗi sau khi playlist đã upload nhưng register không dứt khoát (xem trên) → KHÔNG xoá R2; job ở `register_failed`/`needs_sign_in` ("Retry register").
- Retry job `failed` ở bước `uploading`: xoá prefix cũ (best-effort) rồi chạy lại với `public_id` mới. Retry job `interrupted` (app tắt/crash lúc đang chạy) KHÔNG BAO GIỜ xoá prefix cũ, vì bước đã lưu có thể chậm hơn một request register đã tới site; prefix chỉ được ghi log ("may be orphaned"), có thể để lại object mồ côi trên R2 (hạn chế đã biết, mục 8).
- Job gắn với site đã upload (`siteOrigin`): sau khi đổi site, job `register_failed`/`needs_sign_in` giữ nguyên với thông báo nêu host gốc; không bao giờ register hay xoá R2 cho site khác. Cleanup R2 cũng bị bỏ qua nếu origin hiện tại khác origin của job.

**Mô hình progress (chỉ hiển thị local, không cần khớp site)**: trọng số mặc định Transcoding 70%, Thumbnail 3%, Storyboard 7%, Upload 18%, Register 2%; không bao giờ giảm.

### 4.5 Lưu trữ local và bảo mật

**Store và phiên làm việc**
- Store: một file JSON `store.json` trong `app.getPath('userData')`, ghi nguyên tử (ghi file tạm rồi rename), ghi dồn (debounce 200 ms) và tuần tự. Lưu danh sách job (id, đường dẫn file nguồn, kích thước, trạng thái, `public_id`, `prefix`, `siteOrigin`, payload register để retry, thông điệp lỗi + `errorDetail`, thời gian, `registered`), cài đặt (URL site, thư mục tạm, số job song song, username đã đăng nhập). Không lưu progress từng giây (chỉ giữ trong RAM); trạng thái chỉ ghi khi chuyển bước.
- Khi nạp: MUST kiểm tra schema (`schemaVersion`) và hình dạng từng job. File hỏng, sai hình dạng, schema mới hơn hoặc không migrate được → copy sang `store.json.bak` rồi dùng dữ liệu mặc định (không crash). Lỗi ném ra trong lúc khởi động → ghi log, hiện hộp thoại lỗi native "HLS R2 Studio could not start" rồi thoát hẳn (không để tiến trình ẩn giữ single-instance lock).
- Khởi động lại: job đang ở bước chạy dở → chuyển `Interrupted` (kèm `errorDetail` nêu bước dở), xoá thư mục tạm của job, có nút Retry (chạy lại từ đầu với `public_id` mới; xem mục 4.4 về prefix cũ). Lịch sử Done giữ tối đa 200 mục.
- Job gắn với origin của site lúc bắt đầu (`siteOrigin`); xem cuối mục 4.4.
- Session epoch: mỗi lần sign-out, 401, đổi URL site tăng một bộ đếm đồng bộ; kết quả bất đồng bộ (login, tải config) bắt đầu ở epoch cũ bị bỏ, để một câu trả lời đến muộn không "hồi sinh" phiên đã đăng xuất (token vừa được cấp trong tình huống đó bị thu hồi). Hai login đồng thời: lần thứ hai bị bỏ qua. Đổi sang site khác MUST đăng xuất trước (thu hồi token cũ) để token không bao giờ tới host khác.
- Thư mục tạm: MUST là đường dẫn tuyệt đối trên ổ cục bộ; từ chối UNC/mạng (`\\server\share`, `//server/share`) và device path (`\\.\`, `\\?\`, kể cả `\\?\UNC\`); phải tạo được và ghi được; không cho đổi khi còn job chạy.
- Số job song song 1-2 (kiểm tra ở cả UI, settings service và hàng đợi).

**Token và bí mật**
- Token: `safeStorage.encryptString` → file `token.bin` trong `userData` (ghi nguyên tử, mode 0600). Nếu `isEncryptionAvailable()` là false, mã hoá lỗi, hoặc người dùng bỏ chọn "Stay signed in" thì KHÔNG ghi token xuống đĩa (chỉ giữ trong RAM của phiên, file cũ bị xoá). Sign out: gọi `POST /api/app/logout` (lỗi mạng vẫn xoá token cục bộ), xoá token.
- R2 secret/access key: chỉ trong RAM của main process, không ghi file/log, không gửi sang renderer (renderer chỉ thấy `{ r2Configured, transcode }`). Config bị xoá khi sign-out/401/đổi site.
- Mọi lời gọi site qua HTTPS (bắt buộc; `http://localhost`/`127.0.0.1` chỉ ở bản dev; URL có user/password bị từ chối; URL được chuẩn hoá về origin), kiểm tra chứng chỉ mặc định, timeout 30 s. App KHÔNG BAO GIỜ follow redirect (`redirect: manual`; 3xx coi là lỗi) để Bearer token không tới host khác. Body response tối đa 1 MB (đọc từng chunk, vượt thì huỷ). Bất kỳ 401 nào của lời gọi có xác thực → xoá token + config và về màn hình đăng nhập ("Your session has expired. Sign in again.").

**Electron hardening**
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload chỉ expose `window.hlsApi` hẹp (mọi kênh đặt tên trong `shared/ipc.ts`); CSP chặt (`default-src 'self'`, không nội dung từ xa; chèn qua meta lúc build và qua response header của session; bản dev nới vừa đủ cho Vite HMR); `setWindowOpenHandler` luôn từ chối; `will-navigate` chặn mọi URL ngoài app; `setPermissionRequestHandler` và `setPermissionCheckHandler` từ chối mọi quyền.
- IPC: MUST validate payload mọi kênh ở main (kiểu, độ dài, key lạ, id job theo regex, số lượng đường dẫn ≤ 1000); chỉ chấp nhận lời gọi từ frame chính của cửa sổ app (kiểm `sender`, `senderFrame` và URL thuộc app), còn lại ném `Forbidden`. Kênh hành động trả `{ ok } | { ok: false, error }` với thông báo tiếng Anh an toàn. Dialog chọn file/thư mục do main mở; kéo-thả chỉ truyền chuỗi đường dẫn (qua `webUtils.getPathForFile` ở preload).
- URL dev server (`ELECTRON_RENDERER_URL`) bị bỏ qua hoàn toàn khi app đã đóng gói (cả allow-list điều hướng và sender guard).
- Mở link ngoài bằng `shell.openExternal` chỉ với URL https không chứa credentials; "Open on site" còn yêu cầu cùng host với site đang đăng nhập.

**Log**
- Ghi file xoay vòng trong `userData/logs` (`app.log`, tối đa 5 file x 1 MB, mức `info`); MUST che token (kể cả dạng Sanctum), secret, header Authorization, giá trị của key nhạy cảm, và thư mục home của người dùng (thay bằng `~`). Stderr của ffmpeg luôn được thu vào bộ đệm vòng (200 dòng, mỗi dòng cắt 2000 ký tự, đã che); khi job lỗi, phần đuôi này, bước lỗi và mã thoát được che thêm đường dẫn nguồn/thư mục tạm (`<source>`, `<job-dir>`, `<tmp-root>`) rồi lưu vào store local (`errorDetail`) để hiển thị ở View details.

### 4.6 Test cho app

- Vitest (logic thuần, môi trường node; UI dùng jsdom + Testing Library): slug (golden từ PHP), prefix, build args ffmpeg (so khớp chuỗi args với mục 4.4), parse progress, gop/fps/maxWidth, timeout, chọn thumbnail/storyboard trên điểm số giả, retry/backoff, máy trạng thái job và hàng đợi, authService (epoch, 401), store (atomic, `.bak`), IPC validation/sender guard, redact, màn hình renderer.
- Integration (`*.integration.test.ts`, chạy pipeline thật với ffmpeg/ffprobe thật, filesystem thật và AWS SDK thật): dùng S3 giả chạy trong process + register client giả (thay cho MinIO/mock ngoài); video thử sinh bằng ffmpeg `lavfi` (ngang/dọc, có audio, tên file tiếng Việt/khoảng trắng); kiểm tra file đầu ra (playlist, segment, thumbnail 1080×1080, storyboard đúng kích thước) và body của `register`. Tự bỏ qua (có log) khi không tìm thấy ffmpeg; trên CI Windows chúng chạy với ffmpeg đã ghim (`FFMPEG_PATH`/`FFPROBE_PATH` trỏ `resources/bin`). CHƯA chạy trên runner Windows với ffmpeg Windows thật.
- `npm run smoke -- <file>` chạy pipeline thật một lần (S3 giả hoặc R2 thật qua biến `SMOKE_R2_*`, register giả) để thử tay.
- E2E thủ công trước mỗi bản phát hành: checklist trong `desktop-app/docs/PACKAGING.md` (cài installer trên Windows sạch không có ffmpeg/Node, đăng nhập, upload video thật lên R2 thật, xem embed, xoá từ site, kiểm tra Fuses, nâng cấp cài đè, gỡ cài đặt).

## 5. Phasing và triển khai

- **Phase A – Site (tương thích ngược): XONG, ĐÃ DEPLOY và đang dùng thật.** Migration (`public_id`, cột R2, Sanctum), `public_id` + route embed, R2 trong DB + `r2:import-env`, Settings card R2 + token, API `/api/app/*`, sửa report resolve, sửa `docs/wordpress-snippets/`. Luồng upload cũ vẫn chạy. Vẫn phải nhắc ở mỗi lần deploy: cập nhật snippet WPCode + purge cache (plugin cache và Cloudflare) cho đến khi chủ dự án xác nhận "Tôi đã thực hiện".
- **Phase B – App Windows: ĐÃ VIẾT CODE VÀ TEST, chờ build Windows đầu tiên.** Pipeline, GUI, hàng đợi, bảo mật, đóng gói NSIS, fetch ffmpeg ghim hash, workflow CI đã có và pass test tự động (unit + integration với fake). Còn lại để coi Phase B là xong: (1) chạy workflow lần đầu trên `windows-latest` (cấu hình `electron-builder.yml`, icon, `extraResources`, NSIS, Fuses CHƯA từng chạy thật); (2) chạy checklist thủ công trong `desktop-app/docs/PACKAGING.md` trên Windows sạch; (3) thử với site thật và R2 thật (kể cả việc không gửi `ACL`, phát embed, xoá video từ site).
- **Phase C – Dọn site: CHƯA BẮT ĐẦU.** Gỡ upload/queue/ffmpeg/Reverb theo mục 3.9 (hiện `routes/web.php` còn đủ các route upload, status, activity-log; `Setting::r2Disk()` còn fallback về env), bỏ biến `R2_*` khỏi `.env`/`config/filesystems.php`/docs, cập nhật docs/deploy, bỏ systemd units queue/reverb. Điều kiện bắt đầu: app Windows đã được dùng ổn định với site thật một thời gian (Phase B xong).
- Rollback: Phase A giữ nguyên luồng cũ; chỉ làm Phase C khi app đã chạy ổn định.
- Mỗi phase có commit riêng theo từng tính năng và hướng dẫn "Deploy to VPS" riêng (theo quy ước dự án).

## 6. Tiêu chí nghiệm thu

Chú thích: [A] = đã có test tự động (unit/integration với fake S3/site; phía site là PHPUnit); [W] = BẮT BUỘC kiểm tra thủ công trên Windows (checklist `desktop-app/docs/PACKAGING.md`); có thể vừa [A] vừa [W] khi phần tự động chỉ phủ logic.

1. [W] Cài installer `.exe` trên Windows chưa có ffmpeg/Node → chạy được, hiển thị phiên bản ffmpeg ở About. (Tự động chỉ phủ self-check/parse version.)
2. [A + W] Đăng nhập app bằng tài khoản site; sai mật khẩu hiện lỗi chung; revoke token trên site → app bị đưa về màn hình đăng nhập ở lần gọi tiếp theo. (Tự động: `AppApiLoginTest`, `AppTokenSettingsTest`, `authService`, `siteClient`; thủ công: chạy với site thật.)
3. [A + W] Upload một file (ngang) và một file (dọc) có tên tiếng Việt: R2 có đúng `playlist.m3u8`, `segment_*.ts`, `thumbnail.jpg` (1080×1080), `storyboard_{3x3,4x4,5x5}.jpg` dưới prefix `{Y}/{m}/{d}/{slug}-{public_id}/`; site hiện video `ready` sau khi reload; `/embed/{public_id}` phát được, storyboard hiện khi rê thanh tua. (Tự động: integration với ffmpeg thật + S3 giả; thủ công: R2 thật, quyền public không `ACL`, phát embed.)
4. [A + W] Video cũ vẫn phát ở `/embed/{id số}` (`EmbedShowTest`, `VideoPublicIdMigrationTest`) và shortcode WordPress cũ vẫn chạy (thủ công, sau khi cập nhật snippet WPCode).
5. [A + W] Lỗi giữa chừng (rút mạng khi upload, Cancel): R2 không còn object mồ côi dưới prefix, thư mục tạm bị xoá, site không có row mới. (Tự động: cancel/lỗi upload/definitive register với fake; thủ công: rút mạng thật. Ngoại lệ có chủ đích: `register_failed`/`needs_sign_in` giữ file trên R2, xem mục 4.4.)
6. [A] Gọi lại `register` hai lần không tạo trùng row (`AppApiVideoRegisterTest`).
7. [A] Report từ trang embed của video mới được gắn đúng `video_id` (`ReportApiTest`).
8. [W] Xoá video trên site xoá toàn bộ prefix trên R2 và row (dùng config R2 từ DB). Logic site có từ trước; cần kiểm với R2 thật.
9. [A + W] Cột `r2_secret_access_key` trong DB là ciphertext (`SettingsR2ConfigTest`); secret không xuất hiện trong log (test `redact`/`logger`), view, hoặc file trên máy người dùng (thủ công: kiểm `%APPDATA%` sau một phiên).
10. [A] Toàn bộ test mục 3.10 và 4.6 pass (PHPUnit phía site; `npm test`, `npm run typecheck`, `npm run lint` phía app). Phần integration trên runner Windows [W] sẽ được chứng minh ở lần chạy CI đầu tiên.
11. [W] Các điểm riêng của Windows: Electron Fuses không làm cửa sổ trắng và ASAR integrity không làm app crash; `ELECTRON_RUN_AS_NODE=1` không có tác dụng; hash `ffmpeg.exe`/`ffprobe.exe` khớp `ffmpeg.lock.json`; SmartScreen; `taskkill` (bổ sung ngoài checklist) dừng đúng cây ffmpeg khi Cancel; cài đè nâng cấp giữ cài đặt và đăng nhập; gỡ cài đặt giữ dữ liệu trong `%APPDATA%` (ghi vào release notes).

## 7. Ngoài phạm vi (xem `TODO.md`)

App hiển thị/sửa/xoá video; site hiển thị job state của app và realtime (cùng việc dọn object mồ côi bằng stale-job rule); app macOS; **auto-update** (cần nơi host bản cập nhật: GitHub Releases hoặc R2 public bucket; hiện cài đè thủ công); multi-user (`user_id` cho `Setting`/`Video`); dọn tự động row/object R2 mồ côi do app bị tắt đột ngột (hiện chỉ dọn ở Retry job `failed`, KHÔNG dọn ở Retry job `interrupted`; xem mục 8); ký số installer.

## 8. Điểm chờ xác nhận / rủi ro đã biết

Đã chốt (không còn là điểm chờ):
- Ảnh custom (`storeImage`/`destroyImage`) giữ trên site, dùng `r2Disk()` của site (2026-11-03).
- Trang Logs xoá hẳn ở Phase C (2026-11-03).
- Installer KHÔNG ký số, chấp nhận cảnh báo SmartScreen; có thể mua certificate (OV/EV hoặc dịch vụ ký cloud) sau, cần cấu hình electron-builder và secret trong CI.
- Token hết hạn sau 90 ngày (đổi trong `config/sanctum.php`). Khi gặp 401 (hết hạn, bị thu hồi, đổi mật khẩu) app xoá token local và về màn hình đăng nhập; job đang chạy vẫn tiếp tục, chỉ bước register chờ đăng nhập lại (`needs_sign_in`).
- App không gửi `ACL` (quyết định giữ; còn cần kiểm chứng bằng R2 thật ở Phase B, xem dưới).

Còn mở:
1. Auto-update chưa làm (`TODO.md`).
2. GPL cho bản phát hành ra ngoài tổ chức (`TODO.md`): bản ffmpeg gyan.dev "essentials" liên kết tĩnh nhiều thư viện GPL/LGPL (libx264, libx265, libvpx, libmp3lame...). Trước khi phát hành ra ngoài MUST đính kèm source đầy đủ (FFmpeg + các thư viện đó + build script) vào mỗi GitHub Release, hoặc có địa chỉ liên hệ hoạt động và giữ source 3 năm. File notices hiện chỉ có link source FFmpeg và lời đề nghị liên hệ, chưa đủ cho phát hành ngoài. Dùng nội bộ thì chưa bắt buộc.
3. Hạn chế đã biết của app (từ `desktop-app/README.md`):
   - Tiến trình ffmpeg/ffprobe mồ côi: app dừng ffmpeg bằng kill cả cây tiến trình, nhưng nếu main process chết cứng thì ffmpeg có thể chạy tiếp đến khi xong (chưa dùng Windows Job Object).
   - Object R2 mồ côi: (a) Cancel job `register_failed`/`needs_sign_in` giữ nguyên file trên R2 (site có thể đã đăng ký); (b) Retry job `interrupted` không xoá prefix cũ. Cả hai phải dọn tay hoặc làm công cụ dọn sau (liên quan mục "stale-job" trong `TODO.md`).
   - Đổi site khi còn job đã upload chờ register bị từ chối; sau khi đổi, job cũ chỉ hoàn tất khi đăng nhập lại đúng site đó.
   - Chỉ `playlist_not_found` và `public_id_conflict` là kết luận dứt khoát; mọi 409/422 khác giữ file và payload để Retry.
   - Slug không phiên âm được CJK/Ả Rập/Do Thái/Thái... (khác `Str::slug` của PHP) và luôn cắt tối đa 100 ký tự.
   - Thư mục tạm không được là UNC/device path; file nguồn chỉ đọc qua allow-list demuxer mp4/mov/mkv/webm/avi.
4. Chưa kiểm chứng (chỉ làm được trên Windows/R2 thật): build NSIS và `extraResources`; Fuses (`grantFileProtocolExtraPrivileges` cố ý để mặc định); upload không `ACL` + truy cập public qua custom domain; `safeStorage`/DPAPI thực tế; `os.setPriority` và `taskkill` trên Windows; hành vi gỡ cài đặt với `%APPDATA%`.
5. Build provenance (`actions/attest-build-provenance`) chưa bật vì chỉ có với repo public hoặc GitHub Enterprise Cloud; nên tạo tag ruleset cho `desktop-v*` để chỉ người tin cậy phát hành.

## 9. Thay đổi so với bản duyệt ban đầu

1. Register: kiểm tra "video đã tồn tại" chạy TRƯỚC validation đầy đủ (và không cần R2) — để retry sau lỗi mạng luôn trả 200/409 ổn định dù field phụ đã đổi.
2. Thêm `max:255` cho `disk_prefix`/path và mã `storage_unavailable` (503) — cột `varchar(255)`; lỗi R2 không được lộ chi tiết SDK.
3. Slug luôn cắt 100 ký tự (thay vì chỉ khi key > 900 byte) và app validate độ dài trước khi upload — tránh upload xong mới bị site từ chối.
4. Chính sách lỗi register chặt hơn bản đầu (chỉ `playlist_not_found`/`public_id_conflict` mới xoá R2; mọi lỗi 4xx khác giữ file) — tránh xoá nhầm video có thể đã được đăng ký.
5. Thêm `onBeforeRegister` (flush store trước request register) và quy tắc Cancel quanh register — chống mất đồng bộ khi app chết giữa chừng.
6. Retry job `interrupted` không bao giờ xoá prefix cũ (chấp nhận object mồ côi) — bước lưu có thể chậm hơn request register đã tới site.
7. Job gắn `siteOrigin`, session epoch, đổi site = đăng xuất — không để token/R2 cleanup chạm sang site khác.
8. Upload: không `ACL`, không `CacheControl`, playlist cuối, `maxAttempts=1` cho client upload + `withRetry` 3 lần, checksum `WHEN_REQUIRED` — SDK không replay được body stream; R2 không nhận trailer CRC32 mặc định.
9. Probe fps nguồn chỉ khi config không ép fps; thông tin output đọc từ `segment_000.ts` — đúng hành vi job PHP.
10. Thêm `-format_whitelist` cho mọi lệnh đọc file nguồn — chặn demuxer có khả năng đọc mạng/file khác khi file bị đổi đuôi.
11. ffmpeg ghim gyan.dev essentials 9.0.2 (thay cho gợi ý BtbN/gyan) + `ffmpeg.lock.json`, kiểm SHA-256 trước khi giải nén — tái lập được và chống đổi binary.
12. Thêm Electron Fuses, `.npmrc ignore-scripts`, ràng buộc sender IPC, từ chối quyền, bỏ dev URL khi đóng gói, không follow redirect, giới hạn body 1 MB — giảm bề mặt tấn công (nhiều mục ngoài bản duyệt đầu).
13. Store: kiểm schema + `.bak`, hộp thoại lỗi khởi động — file hỏng không làm app kẹt.
14. GUI: 3 tab (Queue/Settings/About), banner, dialog xác nhận, nút Open licenses, Choose folder; không làm tray — UI gọn hơn, tray là MAY.
15. Phương án test: S3 giả trong process thay cho MinIO, integration trên cả máy dev lẫn CI Windows — không cần dịch vụ ngoài.
16. Installer không ký số và chưa auto-update; GPL source offer cho phát hành ngoài ghi trong `TODO.md`.
