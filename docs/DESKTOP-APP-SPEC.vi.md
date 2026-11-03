# Spec: Desktop app (Windows) + Site dashboard

Trạng thái: DRAFT chờ duyệt (2026-11-03). Đối tượng đọc: chủ dự án (duyệt) và dev/agent triển khai.
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
| 4 | R2 secret trong app CHỈ giữ trong bộ nhớ (không ghi xuống đĩa). Token đăng nhập mã hoá bằng Electron `safeStorage` (DPAPI trên Windows). |
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

Lỗi giữa chừng: app tự xoá phần đã upload lên R2 (best-effort) và xoá thư mục tạm; site không biết gì.

## 3. SITE

Triển khai theo 3 phase (xem mục 5). Phase A tương thích ngược: luồng upload cũ vẫn chạy.

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

- `User` dùng `HasApiTokens`. `config/sanctum.php`: `guard => []` (chỉ token, không SPA/cookie), `expiration` = 129600 phút (90 ngày); app xử lý 401 bằng cách quay lại màn hình đăng nhập.
- Mọi route `/api/app/*` (trừ login) dùng middleware `auth:sanctum`. Lỗi xác thực trả JSON 401 (cấu hình hiện tại đã trả 401 cho `api/*`). Đăng nhập web và secret login key không bị ảnh hưởng.
- Đổi mật khẩu (`SettingsController::updatePassword`) MUST thu hồi toàn bộ token app.
- Rate limit: login 5 lần/phút theo (IP + username); các route còn lại 60/phút theo token. Lỗi đăng nhập trả message chung `Incorrect username or password.` (không lộ username có tồn tại hay không) và log cảnh báo kèm IP (giống `AuthController::login`).

### 3.5 API contract (`routes/api.php`, prefix `/api/app`)

Tất cả response JSON; request JSON; mọi response nhạy cảm kèm `Cache-Control: no-store`.

**POST /api/app/login**
- Body: `username` (required string), `password` (required string), `device_name` (required string, max 100).
- 200: `{ "token": "<plain token>", "user": { "username": "..." } }`. Token tạo với tên = `device_name`.
- 422: sai thông tin (message chung). 429: vượt rate limit.

**POST /api/app/logout** (auth) → 204, thu hồi token hiện tại.

**GET /api/app/config** (auth) → 200:
```json
{
  "r2": { "access_key_id": "...", "secret_access_key": "...", "bucket": "...", "endpoint": "https://<acct>.r2.cloudflarestorage.com", "url": "https://cdn.example.com" },
  "transcode": { "resolution": "720", "segment_seconds": 6, "fps": null }
}
```
- Nếu R2 chưa cấu hình đủ: 409 `{ "error": "r2_not_configured" }`.
- Cũng dùng để app kiểm tra token còn hiệu lực khi khởi động.

**POST /api/app/videos** (auth) — đăng ký video đã upload xong:
- Body (validate chặt):
  - `public_id`: `required|regex:/^[a-z0-9]{12}$/`
  - `title`: `required|string|max:255`
  - `original_filename`: `required|string|max:255`; `original_size_bytes`: `required|integer|min:1`
  - `disk_prefix`: `required|regex:/^\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-{public_id}\/$/` (phải kết thúc bằng `-{public_id}/` và khớp `public_id` gửi lên)
  - `playlist_path`: bằng `disk_prefix.'playlist.m3u8'`; `thumbnail_path`: nullable, bằng `disk_prefix.'thumbnail.jpg'`
  - `storyboards`: nullable object, chỉ nhận key `3x3|4x4|5x5`, mỗi mục `{ "path": disk_prefix.'storyboard_NxN.jpg' }`
  - `duration`: nullable numeric ≥ 0; `output_width`, `output_height`: nullable int; `output_fps`: nullable numeric; `output_bitrate_kbps`: nullable int; `output_codec`: nullable string max 20
- Hành vi:
  1. Kiểm tra `playlist_path` tồn tại trên R2 bằng `r2Disk()->exists()`; không có → 422 `{ "error": "playlist_not_found" }`.
  2. Tạo `Video` với `status=ready`, `stage=ready`, `progress=100`.
  3. Idempotent: nếu `public_id` đã tồn tại với cùng `disk_prefix` → 200 trả lại video hiện có (app gọi lại sau lỗi mạng không tạo trùng); khác `disk_prefix` → 409 `{ "error": "public_id_conflict" }`.
- 201 (hoặc 200 khi lặp): `{ "id": 123, "public_id": "ab12cd34ef56", "embed_url": "https://<site>/embed/ab12cd34ef56" }`.

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

- Card **Storage (R2)** mới: nhập các giá trị mục 3.3, route `PUT /settings/r2`. SHOULD có nút "Test connection" (ghi + xoá một object nhỏ trong một prefix tạm) báo thành công/lỗi.
- Card **Desktop app access** mới: bảng token (tên thiết bị, ngày tạo, `last_used_at`) + nút Revoke từng token + Revoke all.
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

## 4. APP WINDOWS

### 4.1 Stack và cấu trúc

- Electron (bản stable hiện hành) + TypeScript + Vite (electron-vite); UI React. Repo: thư mục `desktop-app/` trong monorepo này, `package.json` riêng.
- Tiến trình: **main** (Node: ffmpeg, upload R2, HTTP tới site, lưu trữ) và **renderer** (UI thuần, không có Node). Giao tiếp qua `preload` + IPC có kiểu.
- Module chính (main): `api` (client site), `config` (giữ config trong RAM), `queue` (hàng đợi + máy trạng thái job), `pipeline` (prefix, transcode, thumbnail, storyboard, upload, register, cleanup), `ffmpeg` (xây args, chạy process, parse progress), `store` (JSON local), `secure` (safeStorage), `logger`.
- Phần logic thuần (slug, prefix, build args, parse progress, chọn thumbnail/storyboard) tách khỏi Electron để test bằng Vitest.

### 4.2 Installer và ffmpeg

- `electron-builder` target NSIS x64, cài theo user (`perMachine: false`, không đòi quyền admin), tạo shortcut Start Menu/Desktop. Một file `.exe` duy nhất; người dùng không phải cài thêm runtime hay ffmpeg.
- `ffmpeg.exe` và `ffprobe.exe` nằm trong `extraResources` (`resources/bin/`), app gọi bằng đường dẫn tuyệt đối (`process.resourcesPath`), KHÔNG dùng PATH. Bản build ffmpeg: build static "GPL" có libx264 (ví dụ BtbN hoặc gyan.dev), ghim phiên bản, tải ở bước build CI và kiểm tra SHA-256.
- Khi khởi động app MUST tự kiểm tra ffmpeg: chạy `ffmpeg -hide_banner -encoders`/`-filters`, xác nhận có `libx264`, `aac`, muxer `hls`, filter `scale`, `thumbnail`, `signalstats`, `edgedetect`, `hstack`, `tile`, `crop`, `fps`, nguồn lavfi `movie`. Thiếu thì hiện lỗi rõ ràng và chặn xử lý.
- Giấy phép: kèm `LICENSES/` (ffmpeg GPL + thông báo nguồn, các thư viện npm) và hiện trong màn hình About.
- Ký số: installer chưa ký sẽ bị SmartScreen cảnh báo. Chưa có chứng chỉ thì ghi rõ trong hướng dẫn cài đặt (xem mục 8).

### 4.3 GUI

1. **Đăng nhập**: URL site (phải https; chỉ cho phép `http://localhost` ở bản dev), username, password, checkbox "Stay signed in". Lỗi hiển thị bằng tiếng Anh, không lộ chi tiết. Sau đăng nhập gọi `GET /api/app/config`.
2. **Màn hình chính**: vùng kéo-thả / nút "Add videos" (chọn nhiều file: mp4, mov, mkv, avi, webm). Bảng hàng đợi: tên file, dung lượng, bước hiện tại (Waiting, Transcoding, Thumbnail, Storyboard, Uploading, Registering, Done, Failed, Cancelled), thanh progress tổng, nút Cancel / Retry / Remove, và với job Done: nút Copy embed URL / Copy shortcode (`[hls_embed_vl id="<public_id>"]`) / Open on site. Mỗi job Failed có nút **View details** hiển thị thông báo lỗi, bước bị lỗi, mã thoát và ~200 dòng cuối stderr của ffmpeg (đã che đường dẫn cá nhân) kèm nút Copy.
3. **Settings**: URL site, thư mục tạm (mặc định `%TEMP%\hls-r2-studio`), số job chạy song song (mặc định 1, tối đa 2), nút Sign out, nút "Reload config".
4. **About**: phiên bản app, phiên bản ffmpeg, giấy phép, nút **Open logs folder**.
- Nếu nhiều file thì xử lý tuần tự, file nhỏ trước (giống hành vi hiện tại). Đóng cửa sổ khi còn job đang chạy: hỏi xác nhận; MAY thu nhỏ xuống tray.
- Mọi text UI bằng tiếng Anh.

### 4.4 Pipeline chi tiết (port đúng từ code PHP hiện tại)

Tất cả tiến trình con chạy bằng `spawn` với mảng args (không shell), `cwd = thư mục tạm của job`, tên file đầu ra dùng đường dẫn tương đối ASCII đơn giản (tránh lỗi escape ký tự `:`/`\` của filter lavfi `movie=` trên Windows). Hạ độ ưu tiên tiến trình ffmpeg xuống `BELOW_NORMAL` (tương đương `nice`).

**Bước 0 – chuẩn bị**
- Kiểm tra file input tồn tại, đuôi hợp lệ; kiểm tra ổ chứa thư mục tạm còn trống ≥ `size × 1.5 + 1 GB`, thiếu thì fail sớm.
- Sinh `public_id` (12 ký tự `[a-z0-9]`, `crypto.randomInt`).
- Tạo thư mục tạm `<tmpRoot>/<public_id>/`.

**Bước 1 – prefix** (`{Y}/{m}/{d}/{slug}-{public_id}/`)
- `Y/m/d` theo UTC tại thời điểm bắt đầu job.
- `slug`: tương đương `Str::slug(pathinfo($filename, PATHINFO_FILENAME))` của Laravel: bỏ đuôi, chuyển ASCII (xử lý tiếng Việt, `đ→d`), lowercase, ký tự không phải chữ/số → `-`, gộp và trim `-`; rỗng → `video`. Guard mới: nếu key đầy đủ > 900 byte thì cắt slug còn 100 ký tự.
- Test tương đương bắt buộc: bảng ≥ 30 mẫu (tiếng Việt có dấu, `Đ`, emoji, nhiều khoảng trắng, chữ hoa, chỉ ký hiệu, tên rất dài, nhiều dấu chấm) với kết quả sinh từ PHP (`Str::slug`) làm "golden".

**Bước 2 – probe**
- `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <input>` (timeout 60 s; exit ≠ 0 → fail job; không phải số hoặc ≤ 0 → duration = null và vẫn tiếp tục).
- `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 <input>` → fps nguồn (`num/den`).

**Bước 3 – transcode HLS**
```
ffmpeg -y -i <input>
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
- Sau khi xong: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,bit_rate,codec_name -of json <segment đầu tiên .ts>` (timeout 60 s) → `output_width`, `output_height`, `output_fps` (làm tròn 2 chữ số), `output_bitrate_kbps` = `round(bit_rate/1000)` (thiếu `bit_rate` thì `round(bytes_segment×8/1000/segment_seconds)`), `output_codec`. Lỗi ffprobe → bỏ các trường đó (null), không fail job.

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
- `STORYBOARD_GRID_SIZES = [3,4,5]`, tile 160×160 (`storyboard_tile_size` mặc định 160), `CANDIDATES_PER_SLOT = 3`, tổng ứng viên `3×5×5 = 75`.
- Trích một lượt: `ffmpeg -y -i <input> -vf "fps=75/<duration>,crop='min(iw\,ih)':'min(iw\,ih)',scale=160:160" -frames:v 75 -start_number 0 candidate_%04d.jpg`; timeout `max(60, ceil(duration × 2))`. Ứng viên N có timestamp `N × duration / 75`.
- Chấm điểm từng ứng viên bằng hai lệnh ffprobe ở bước 4 (4 ứng viên song song; timeout 60 s mỗi lệnh).
- Với mỗi lưới N (N×N ô): chia thời lượng thành N×N slot đều nhau; mỗi slot lấy ứng viên điểm cao nhất vượt bộ lọc, nếu không có thì ứng viên điểm cao nhất bất kỳ; slot rỗng dùng slot có dữ liệu gần nhất. Copy thành `tile_NxN_%04d.jpg` (đánh số từ 0 theo thứ tự slot), ghép: `ffmpeg -y -start_number 0 -i tile_NxN_%04d.jpg -vf tile=NxN -frames:v 1 storyboard_NxN.jpg` (timeout 60 s, file đầu ra phải tồn tại). Kích thước: 480×480, 640×640, 800×800. Lưới lỗi chỉ log và bỏ qua; cuối cùng xoá candidate/tile.
- `storyboards` gửi lên site: `{"3x3":{"path":"<prefix>storyboard_3x3.jpg"},...}` chỉ gồm các lưới có file; không có lưới nào thì `null`. KHÔNG có VTT/JSON/sprite metadata.

**Bước 6 – upload R2**
- Dùng `@aws-sdk/client-s3`: `region: "auto"`, `endpoint` từ config, `forcePathStyle: true`, credentials từ config (RAM).
- File upload: các file cấp 1 trong thư mục tạm có đuôi `ts`, `m3u8`, `jpg` — tức `segment_NNN.ts`, `playlist.m3u8`, `thumbnail.jpg`, `storyboard_NxN.jpg`. Key = `<prefix> + <tên file>` (phẳng). Không upload `candidate_*`, `tile_*`, `thumb_candidate_*`.
- Song song 5 file (`UPLOAD_CONCURRENCY = 5`), mỗi file một `PutObject` (stream + `ContentLength`, không multipart). `playlist.m3u8` MUST upload SAU CÙNG (an toàn dù row chỉ tạo ở cuối).
- `ContentType` đặt tường minh: `.m3u8 → application/vnd.apple.mpegurl`, `.ts → video/mp2t`, `.jpg → image/jpeg`. Không đặt `CacheControl` (giữ hành vi hiện tại). KHÔNG gửi `ACL` (quyền public của R2 được cấu hình ở bucket/custom domain, không theo từng object); dev xác nhận bằng một lần upload + truy cập file thật ở Phase B.
- Retry: file lỗi thử lại tuần tự tối đa 3 lần, chờ 1 s trước lần 2 và 2 s trước lần 3 (ngoài retry nội bộ của SDK). Còn file lỗi sau đó → fail job.
- Progress upload = số file đã xong / tổng số file.

**Bước 7 – register**
- Gọi `POST /api/app/videos` (mục 3.5) với metadata đã thu thập; `title` = tên file bỏ đuôi.
- Lỗi mạng/5xx: thử lại tối đa 5 lần (backoff 1, 2, 4, 8, 16 s); an toàn vì API idempotent. 4xx (trừ 409 coi như lỗi) → fail job và hiển thị message.
- 401 → giữ job ở trạng thái "Waiting for sign-in", yêu cầu đăng nhập lại rồi tự gọi lại register (không upload lại).
- Thành công: job Done, lưu `public_id`, `embed_url` vào store local, xoá thư mục tạm.

**Cleanup khi lỗi/Cancel**
- Fail/Cancel: kill cây ffmpeg; nếu đã upload ≥ 1 file thì xoá toàn bộ prefix trên R2 (`ListObjectsV2` + `DeleteObjects`, best-effort, lỗi chỉ log); xoá thư mục tạm; job chuyển Failed/Cancelled với message tiếng Anh (có phần chi tiết rút gọn, che đường dẫn cá nhân).
- Ngoại lệ: lỗi sau khi playlist đã upload nhưng register thất bại do mạng → KHÔNG xoá R2; để job ở trạng thái "Register failed – Retry" để gọi lại register.

**Mô hình progress (chỉ hiển thị local, không cần khớp site)**: trọng số mặc định Transcoding 70%, Thumbnail 3%, Storyboard 7%, Upload 18%, Register 2%; không bao giờ giảm.

### 4.5 Lưu trữ local và bảo mật

- Store: một file JSON trong `app.getPath('userData')`, ghi nguyên tử (ghi file tạm rồi rename). Lưu danh sách job (id, đường dẫn file nguồn, trạng thái, `public_id`, `prefix`, thông điệp lỗi, thời gian), cài đặt (URL site, thư mục tạm, số job song song). Không lưu progress từng giây (chỉ giữ trong RAM).
- Khởi động lại: job đang ở bước chạy dở → chuyển `Interrupted` với nút Retry (chạy lại từ đầu: dọn thư mục tạm và prefix R2 dở dang trước). Lịch sử Done giữ tối đa 200 mục.
- Token: `safeStorage.encryptString` → file trong `userData`. Nếu `safeStorage.isEncryptionAvailable()` là false thì KHÔNG ghi token xuống đĩa (chỉ giữ trong phiên). Sign out: gọi `POST /api/app/logout`, xoá token cục bộ.
- R2 secret/access key: chỉ trong RAM của main process, không ghi file/log, không gửi sang renderer.
- Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` cho renderer; preload chỉ expose API hẹp; CSP chặt (không load nội dung từ xa); `setWindowOpenHandler` chặn mở cửa sổ; chặn điều hướng ngoài; validate mọi input IPC ở main; mở link ngoài bằng `shell.openExternal` chỉ với URL https của site.
- Log: ghi file xoay vòng trong `userData/logs`; MUST che token, secret, header Authorization, đường dẫn thư mục người dùng. Stderr của ffmpeg luôn được thu vào bộ đệm vòng trong RAM; khi job lỗi, ~200 dòng cuối (đã che) cùng bước lỗi và mã thoát được lưu vào store local (`errorDetail`) để hiển thị ở View details.
- Mọi lời gọi site qua HTTPS (bắt buộc), kiểm tra chứng chỉ mặc định, timeout 30 s.

### 4.6 Test cho app

- Vitest (logic thuần): slug (golden từ PHP), prefix, build args ffmpeg (so khớp chuỗi args với mục 4.4), parse progress, gop/fps/maxWidth, timeout, chọn thumbnail/storyboard trên điểm số giả, retry/backoff, máy trạng thái job.
- Integration (chạy trên runner Windows): sinh video thử bằng ffmpeg `lavfi testsrc` (ngang và dọc, có audio, có tên file tiếng Việt/khoảng trắng), chạy pipeline với S3 giả (MinIO/mock) và site giả; kiểm tra các file đầu ra (playlist, segment, thumbnail 1080×1080, 3 storyboard đúng kích thước) và body của `register`.
- E2E thủ công trước khi phát hành (checklist trong `desktop-app/README`): cài installer trên Windows sạch (không có ffmpeg/Node), đăng nhập, upload 1 video thật lên R2 thật, xem embed, xoá từ site.

## 5. Phasing và triển khai

- **Phase A – Site (tương thích ngược)**: migration (`public_id`, cột R2, Sanctum), `public_id` + route embed, R2 trong DB + `r2:import-env`, Settings card R2 + token, API `/api/app/*`, sửa report resolve, sửa `docs/wordpress-snippets/`. Luồng upload cũ vẫn chạy. SAU KHI deploy: cập nhật snippet WPCode + purge cache (nhắc đến khi chủ dự án xác nhận "Tôi đã thực hiện").
- **Phase B – App Windows**: dựng project, pipeline, GUI, installer; thử với site thật.
- **Phase C – Dọn site**: gỡ upload/queue/ffmpeg/Reverb theo mục 3.9, bỏ biến `R2_*` khỏi `.env`, cập nhật docs/deploy.
- Rollback: Phase A có thể giữ nguyên luồng cũ; chỉ làm Phase C khi app đã chạy ổn định một thời gian.
- Mỗi phase có commit riêng theo từng tính năng và hướng dẫn "Deploy to VPS" riêng (theo quy ước dự án).

## 6. Tiêu chí nghiệm thu

1. Cài installer `.exe` trên Windows chưa có ffmpeg/Node → chạy được, hiển thị phiên bản ffmpeg ở About.
2. Đăng nhập app bằng tài khoản site; sai mật khẩu hiện lỗi chung; revoke token trên site → app bị đưa về màn hình đăng nhập ở lần gọi tiếp theo.
3. Upload một file (ngang) và một file (dọc) có tên tiếng Việt: R2 có đúng `playlist.m3u8`, `segment_*.ts`, `thumbnail.jpg` (1080×1080), `storyboard_{3x3,4x4,5x5}.jpg` dưới prefix `{Y}/{m}/{d}/{slug}-{public_id}/`; site hiện video `ready` sau khi reload; `/embed/{public_id}` phát được, storyboard hiện khi rê thanh tua.
4. Video cũ vẫn phát ở `/embed/{id số}` và shortcode WordPress cũ vẫn chạy (sau khi cập nhật snippet).
5. Lỗi giữa chừng (rút mạng khi upload, Cancel): R2 không còn object mồ côi dưới prefix, thư mục tạm bị xoá, site không có row mới.
6. Gọi lại `register` hai lần không tạo trùng row.
7. Report từ trang embed của video mới được gắn đúng `video_id`.
8. Xoá video trên site xoá toàn bộ prefix trên R2 và row (dùng config R2 từ DB).
9. Cột `r2_secret_access_key` trong DB là ciphertext; secret không xuất hiện trong log, view, hoặc file trên máy người dùng.
10. Toàn bộ test mục 3.10 và 4.6 pass.

## 7. Ngoài phạm vi (xem `TODO.md`)

App hiển thị/sửa/xoá video; site hiển thị job state của app và realtime; app macOS; auto-update; multi-user (`user_id` cho `Setting`/`Video`); dọn row/đối tượng mồ côi do app bị tắt đột ngột sau khi đã upload một phần (hiện app tự dọn ở lần Retry/khởi động lại).

## 8. Điểm chờ xác nhận / rủi ro đã biết

1. (Đã xác nhận 2026-11-03) Ảnh custom (`storeImage`/`destroyImage`) giữ trên site (dùng `r2Disk()` của site) — chưa chuyển sang app.
2. (Đã xác nhận 2026-11-03) Trang Logs đề xuất xoá hẳn ở Phase C (chỉ còn trùng với trang Videos).
3. (Đã chấp nhận 2026-11-03) Installer không ký số → SmartScreen cảnh báo khi cài; có thể mua certificate sau.
4. Auto-update chưa làm; cần nơi host bản cập nhật khi làm (GitHub Releases hoặc server riêng).
5. (Đã chốt) Token hết hạn sau 90 ngày (đổi được trong `config/sanctum.php`). Khi gặp 401 (hết hạn, bị thu hồi, đổi mật khẩu) app xoá token local và quay về màn hình đăng nhập; job đang upload vẫn chạy, chỉ bước register chờ đăng nhập lại.
6. (Đã quyết định) App không gửi `ACL`; kiểm chứng bằng bucket thật ở Phase B.
7. Bản ffmpeg GPL kèm theo installer cần đính kèm thông báo giấy phép (đã nêu ở 4.2).
