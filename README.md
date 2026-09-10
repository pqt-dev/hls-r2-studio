# HLS R2 Studio

Ứng dụng quản lý video nội bộ: đăng nhập admin → upload video (đơn lẻ hoặc chunk-upload cho file lớn) → băm (transcode) sang HLS bằng FFmpeg với chất lượng/segment/fps có thể cấu hình → upload lên Cloudflare R2 (S3-compatible storage) → xem qua trình phát HLS.js. Có dashboard Tổng quan (số liệu CPU/RAM/Disk thật của server + thống kê video), trang Nhật ký, trang Cài đặt (đổi mật khẩu, cấu hình R2 động, tuỳ chọn xử lý/hiển thị), và danh sách video dạng bảng có phân trang + xoá hàng loạt.

## Kiến trúc / Luồng xử lý

1. **Đăng nhập** (`GET/POST /login`, `POST /logout` — `App\Http\Controllers\AuthController`):
   - Xác thực qua bảng `users` (Laravel Auth chuẩn, session driver `database`).
   - Toàn bộ route nghiệp vụ (trừ `/login`) nằm sau middleware `auth`.

2. **Dashboard Tổng quan** (`GET /`, `VideoController@overview`):
   - Đếm số video theo `status` (`ready`, `pending`/`processing`, `failed`).
   - Đọc `/proc/loadavg`, `/proc/cpuinfo`, `/proc/meminfo` để tính % CPU/RAM đang dùng, và `disk_total_space()`/`disk_free_space()` cho dung lượng ổ đĩa của server chạy ứng dụng (Linux-only; các số liệu này `null` nếu không đọc được các file `/proc/*`, ví dụ trên macOS).

3. **Upload video** (`GET /upload` — `VideoController@create`, chunk-upload qua `POST /uploads/init`, `POST /uploads/{uploadId}/chunk`, `POST /uploads/{uploadId}/complete`):
   - `initUpload`: validate `filename` (đuôi `mp4/mov/mkv/avi/webm`), `total_size` (tối đa theo `UPLOAD_MAX_SIZE_MB`), tạo `upload_id` (UUID), tạo thư mục tạm `storage/app/private/chunked_uploads/{upload_id}/`.
   - `uploadChunk`: nhận từng chunk qua request body raw (`php://input`), append tuần tự vào file `blob.part` trong thư mục tạm (client tự chia file thành các chunk theo `UPLOAD_CHUNK_SIZE_MB`).
   - `completeUpload`: kiểm tra kích thước file lắp ráp khớp `total_size`, đổi tên thành `storage/app/private/uploads/{uuid}.{ext}`, tạo bản ghi `Video` với `status = pending`, dispatch `App\Jobs\TranscodeVideoJob` (queue `database`), redirect về `/videos`.

4. **Transcode** (`App\Jobs\TranscodeVideoJob`, chạy qua `php artisan queue:work`):
   - Set `status = processing`, `stage = queued`, `progress = 0`.
   - `ffprobe` lấy `duration`; chuyển `stage = transcoding`.
   - Chạy `ffmpeg` băm sang HLS theo cấu hình hiện tại trong `Setting` (`transcode_resolution` → scale chiều rộng tối đa 854/1280/1920px tương ứng 480/720/1080, không upscale; `transcode_fps` nếu có set `-r` và tính lại GOP, nếu để trống thì giữ nguyên fps gốc; `transcode_segment_seconds` → `-hls_time`; codec cố định `libx264` preset `veryfast` crf `23`, audio `aac` 128k; `hls_playlist_type=vod`).
   - Theo dõi tiến độ transcode qua file `-progress` của ffmpeg (đọc `out_time_ms`), cập nhật cột `progress` (2% → 88%) theo thời gian thực trong lúc job đang chạy.
   - Sau khi transcode xong, `ffprobe` một segment `.ts` đầu tiên để lấy thông số output thật (`output_width`, `output_height`, `output_fps`, `output_bitrate_kbps` — tính từ bitrate segment nếu ffprobe không trả `bit_rate`, `output_codec`), lưu vào `Video`; `progress = 90`.
   - Sinh thumbnail: nếu video dưới 3 giây, chụp 1 khung tại `duration/2`; nếu dài hơn, chụp 3 khung mẫu ở 15%/50%/85% thời lượng, đo độ bão hoà màu (`signalstats.SATAVG` qua ffprobe) của từng khung và chọn khung có độ bão hoà cao nhất làm thumbnail cuối cùng (tránh chọn phải khung đen/mờ).
   - `stage = uploading_r2`, upload toàn bộ file (`playlist.m3u8`, các `segment_*.ts`, `thumbnail.jpg`) lên disk `r2` (qua `Setting::r2Disk()`, cấu hình R2 động từ DB, fallback về `.env` nếu DB trống) dưới prefix `{năm}/{tháng}/{ngày}/{slug-title}-{video_id}/`; tiến độ upload từng file cập nhật `progress` từ 92% → 99%.
   - Hoàn tất: lưu `disk_prefix`, `playlist_path`, `thumbnail_path`, `status = ready`, `stage = ready`, `progress = 100`; dọn thư mục tạm và file upload gốc (trừ khi `KEEP_ORIGINAL_UPLOAD=true`).
   - Nếu lỗi ở bất kỳ bước nào: `status = failed`, `stage = failed`, ghi `error_message`, dọn dẹp thư mục tạm, ghi log lỗi, không retry (`$tries = 1`).

5. **Danh sách video** (`GET /videos`, `VideoController@index`):
   - Bảng chia 2 nhóm: video đang xử lý (`pending`/`processing`, sắp xếp cũ → mới) và video đã xong/lỗi (`ready`/`failed`, sắp xếp mới → cũ, có phân trang theo `videos_per_page` trong Cài đặt hoặc override qua query `per_page` với các mức 12/24/48/100).
   - Video `ready` có `public_url` lấy qua `Setting::current()->r2Disk()->url($video->playlist_path)` để phát qua HLS.js.
   - Xoá 1 video: `DELETE /videos/{video}` (`VideoController@destroy`). Xoá hàng loạt: `DELETE /videos/bulk-destroy` (`VideoController@bulkDestroy`, nhận mảng `selected_ids`). Cả hai đều xoá object trên R2 nếu `delete_from_r2_on_destroy = true` trong Cài đặt, ngược lại chỉ xoá bản ghi DB và giữ lại file trên R2.

6. **Nhật ký** (`GET /logs`, `VideoController@logs`):
   - Liệt kê toàn bộ `Video` (phân trang 30/trang) làm log, kèm tổng số / số thành công (`ready`) / số lỗi (`failed`).

7. **Cài đặt** (`GET /settings` + `PUT /settings/r2|transcode|display|password` — `App\Http\Controllers\SettingsController`):
   - `updateR2`: cập nhật `r2_bucket`, `r2_endpoint`, `r2_url`, `delete_from_r2_on_destroy`; `r2_access_key_id`/`r2_secret_access_key` chỉ ghi đè nếu người dùng nhập giá trị mới (để trống thì giữ nguyên giá trị cũ, `r2_secret_access_key` được mã hoá tại DB qua cast `encrypted`).
   - `updateTranscode`: cập nhật `transcode_resolution` (480/720/1080), `transcode_segment_seconds` (2-15), `transcode_fps` (15-60 hoặc để trống = giữ fps gốc).
   - `updateDisplay`: cập nhật `videos_per_page` (12/24/48/100).
   - `updatePassword`: đổi mật khẩu admin đang đăng nhập (yêu cầu `current_password` đúng).

**Lưu ý quan trọng**: URL public của video phụ thuộc vào việc bạn tự cấu hình bucket R2 public (custom domain hoặc `r2.dev` URL) trên Cloudflare dashboard và điền vào `R2_URL` (hoặc trường `r2_url` trong trang Cài đặt). Code không tự động public hoá bucket.

## Cài đặt (dev, không Docker)

### Yêu cầu

- PHP 8.2+ (Dockerfile production dùng PHP 8.4)
- Composer
- Node.js + npm
- MySQL đang chạy sẵn (local hoặc qua Docker, xem mục "Chạy bằng Docker" bên dưới)
- FFmpeg / FFprobe (đường dẫn binary cấu hình qua `FFMPEG_BINARY`/`FFPROBE_BINARY` trong `.env`, mặc định `ffmpeg`/`ffprobe` tức lấy từ `$PATH`. Nếu chạy local trên Mac và ffmpeg không nằm trong `$PATH` của PHP-FPM/CLI, chạy `which ffmpeg` / `which ffprobe` để lấy full path rồi set vào 2 biến này, ví dụ `/opt/homebrew/bin/ffmpeg`)
- Tài khoản Cloudflare R2 (bucket + API token)

### Các bước

```bash
composer install
npm install && npm run build

cp .env.example .env   # nếu chưa có .env
php artisan key:generate
```

Các biến `.env` cần kiểm tra/điền:

```env
# Database (MySQL)
DB_CONNECTION=mysql
DB_HOST=127.0.0.1        # hoặc "mysql" nếu chạy qua Docker Compose
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=hls_app
DB_PASSWORD=changeme
DB_ROOT_PASSWORD=changeme

QUEUE_CONNECTION=database
SESSION_DRIVER=database

# Cloudflare R2 — xem mục "Cấu hình Cloudflare R2" bên dưới
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_URL=

# Upload
UPLOAD_MAX_SIZE_MB=2048      # dung lượng tối đa cho video gốc (MB)
UPLOAD_CHUNK_SIZE_MB=8       # kích thước mỗi chunk khi upload (MB)
KEEP_ORIGINAL_UPLOAD=false   # true nếu muốn giữ lại file gốc sau khi transcode xong

# FFmpeg
FFMPEG_BINARY=ffmpeg
FFPROBE_BINARY=ffprobe

# Log
LOG_CHANNEL=daily
LOG_DAILY_DAYS=14
```

```bash
php artisan migrate

# Tạo tài khoản admin đầu tiên (upsert theo email — chạy lại lệnh này với cùng
# email sẽ cập nhật mật khẩu, không tạo trùng)
php artisan admin:create admin@example.com "mat-khau-manh"
```

Chạy ứng dụng — cần **hai tiến trình chạy song song**:

```bash
# Terminal 1 — HTTP server
php artisan serve

# Terminal 2 — Queue worker (BẮT BUỘC)
php artisan queue:work
```

> **Quan trọng**: `php artisan queue:work` **bắt buộc phải chạy** thì video mới được transcode. Nếu không chạy queue worker, video sẽ mãi ở trạng thái `pending` vì job transcode nằm trong bảng `jobs` chờ được xử lý.

Truy cập `http://localhost:8000/login` để đăng nhập, sau đó vào `http://localhost:8000/` (Tổng quan), `/videos` (danh sách), `/upload` (upload video mới).

## Cấu hình Cloudflare R2

1. Vào Cloudflare dashboard → R2 → tạo một bucket mới.
2. Tạo R2 API Token (Manage R2 API Tokens) với quyền đọc/ghi cho bucket vừa tạo. Lấy `Access Key ID` và `Secret Access Key`.
3. Lấy `Account ID` để tạo endpoint dạng `https://<account_id>.r2.cloudflarestorage.com`.
4. (Tuỳ chọn nhưng khuyến nghị) Cấu hình public access cho bucket (custom domain hoặc bật public development URL `r2.dev`) để lấy `R2_URL` — đây là URL public dùng để phát HLS và hiển thị thumbnail.
5. Điền vào `.env` (hoặc trực tiếp trong trang Cài đặt của ứng dụng sau khi đăng nhập — giá trị nhập trong Cài đặt được ưu tiên hơn `.env`):

```env
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=ten-bucket-cua-ban
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_URL=https://pub-xxxxxxxx.r2.dev
```

6. Nếu deploy lên domain thật, nhớ vào R2 dashboard → bucket → CORS Policy, thêm domain của bạn vào `AllowedOrigins` (xem thêm ở mục Deploy VPS, Bước 6).

## Cấu trúc dữ liệu

Bảng `videos`:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | bigint | |
| title | string | |
| original_filename | string | |
| original_size_bytes | unsigned bigint, nullable | dung lượng file gốc (bytes) |
| status | string, default `pending` | `pending` \| `processing` \| `ready` \| `failed` |
| stage | string, nullable, default `queued` | `queued` \| `transcoding` \| `uploading_r2` \| `ready` \| `failed` |
| progress | unsigned tinyint, default 0 | % tiến độ xử lý (0-100) |
| disk_prefix | string, nullable | vd `2026/09/10/my-video-12/` |
| playlist_path | string, nullable | path tới `.m3u8` trên disk `r2` |
| thumbnail_path | string, nullable | |
| duration | float, nullable | giây |
| error_message | text, nullable | |
| output_width | unsigned smallint, nullable | chiều rộng video output thật (ffprobe) |
| output_height | unsigned smallint, nullable | chiều cao video output thật |
| output_fps | decimal(5,2), nullable | fps output thật |
| output_bitrate_kbps | unsigned int, nullable | bitrate output thật (kbps) |
| output_codec | string(20), nullable | codec video output (vd `h264`) |
| created_at / updated_at | timestamp | |

Bảng `settings` (bảng đơn dòng, luôn có 1 record `id = 1` — truy cập qua `Setting::current()`):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | bigint | |
| r2_access_key_id | string, nullable | override `.env` nếu có giá trị |
| r2_secret_access_key | text, nullable, mã hoá (`encrypted` cast) | |
| r2_bucket | string, nullable | |
| r2_endpoint | string, nullable | |
| r2_url | string, nullable | |
| delete_from_r2_on_destroy | boolean, default `true` | xoá video có xoá luôn file trên R2 hay không |
| transcode_resolution | string, default `720` | `480` \| `720` \| `1080` |
| transcode_segment_seconds | unsigned tinyint, default 6 | độ dài mỗi segment `.ts` (giây) |
| transcode_fps | unsigned tinyint, nullable | fps ép cứng; để trống = giữ fps gốc video |
| videos_per_page | unsigned smallint, default 24 | số video/trang ở danh sách |
| created_at / updated_at | timestamp | |

Bảng `users` (Laravel Auth chuẩn, dùng cho đăng nhập admin):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | bigint | |
| name | string | |
| email | string, unique | dùng để đăng nhập |
| email_verified_at | timestamp, nullable | không dùng trong luồng hiện tại (không có xác minh email) |
| password | string, hashed | |
| remember_token | string, nullable | |
| created_at / updated_at | timestamp | |

## Chạy bằng Docker (local/dev)

Bộ Docker (`Dockerfile`, `docker-compose.yml`, `docker/`) chạy toàn bộ luồng thật: web (nginx + php-fpm), queue worker (FFmpeg transcode), MySQL, và upload thật lên Cloudflare R2 — không dùng MinIO hay giả lập storage nào.

### Chuẩn bị

```bash
cp .env.example .env   # nếu chưa có .env
```

Điền các biến R2 thật vào `.env` (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_URL` — xem hướng dẫn ở phần "Cấu hình Cloudflare R2" phía trên) và đảm bảo `DB_HOST=mysql`.

Nếu `.env` chưa có `APP_KEY`:

```bash
docker compose build
docker compose run --rm app php artisan key:generate
```

Chạy migrate lần đầu (container `mysql` cần chạy và healthy trước, `docker compose run` sẽ tự chờ theo `depends_on`):

```bash
docker compose up -d mysql
docker compose run --rm app php artisan migrate --force
docker compose run --rm app php artisan admin:create admin@example.com "mat-khau-manh"
```

### Chạy

```bash
docker compose up -d
```

Truy cập `http://localhost:8080/login` để đăng nhập.

**Trước khi public production**, PHẢI đổi `APP_ENV=production` và `APP_DEBUG=false` trong `.env`, đồng thời cập nhật `APP_URL` thành domain thật (xem mục "Deploy VPS" bên dưới để làm đầy đủ).

Xem log queue worker để debug transcode (đây là service bắt buộc phải chạy thì video mới chuyển từ `pending` sang `ready`):

```bash
docker compose logs -f queue
```

## Hướng dẫn Deploy lên VPS Production

> **Phạm vi**: mục này chỉ hướng dẫn đưa ứng dụng chạy được trên một VPS qua IP hoặc domain trỏ thẳng vào cổng ứng dụng (mặc định `8080`). **Domain, DNS, SSL/HTTPS KHÔNG nằm trong phạm vi hướng dẫn này** — nếu bạn muốn chạy qua domain thật kèm HTTPS, bạn cần tự cấu hình reverse proxy (Nginx, Caddy...) hoặc dùng công cụ quản lý VPS có sẵn (aaPanel...) để trỏ vào cổng ứng dụng, và tự xin chứng chỉ SSL (Let's Encrypt, Cloudflare...). Hướng dẫn dưới đây viết cho người **chưa từng deploy VPS lần nào**.

### Bước 1 — Chuẩn bị VPS

- Hệ điều hành: Ubuntu 22.04 hoặc 24.04.
- Cấu hình tối thiểu:
  - **Tối thiểu (dùng nhẹ, set `deploy.replicas: 1` cho service `queue` trong `docker-compose.yml`)**: 2 vCPU, 2GB RAM, 20GB SSD.
  - **Khuyến nghị cho mặc định hiện tại (2 worker song song, `deploy.replicas: 2`)**: 4 vCPU, 4GB RAM, 40GB SSD.
  - Nếu tăng số worker cao hơn 2 (sửa `replicas` trong `docker-compose.yml`), cần tăng vCPU/RAM theo tỷ lệ tương ứng — mỗi worker cộng thêm nên có ít nhất 1 vCPU riêng.
- SSH vào VPS, cài Docker + Docker Compose plugin:

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # xác nhận Docker Compose plugin đã cài thành công
```

### Bước 2 — Đưa code lên VPS

Project này **hiện chưa có git repository**. Chọn 1 trong 2 cách:

**Cách (a) — đơn giản nhất, dùng `rsync`/`scp` (khuyến nghị cho người mới):**

Từ máy local, copy toàn bộ project lên VPS, loại trừ các thư mục nặng/không cần thiết và **không copy `.env` thật** (tránh lộ secret qua kênh không mã hoá/không kiểm soát):

```bash
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'vendor' \
  --exclude '.env' \
  --exclude '.git' \
  ./ user@your-vps-ip:/path/to/hls-r2-studio/
```

Sau đó ở Bước 3, bạn sẽ tạo `.env` **mới trên VPS** từ `.env.example` và điền lại credentials thật trực tiếp trên server (không đi qua kênh copy file).

**Cách (b) — dùng git (tuỳ chọn, cho ai quen git):**

Tự khởi tạo một git repository riêng cho project (`git init`, commit, đẩy lên remote riêng của bạn — GitHub/GitLab tự host...), sau đó `git clone` repository đó về VPS. Cách này không bắt buộc.

### Bước 3 — Cấu hình `.env` trên VPS

Trên VPS, trong thư mục project:

```bash
cp .env.example .env
```

Sửa các giá trị sau trong `.env`:

```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-that-cua-ban   # <-- PHẢI tự điền domain (hoặc http://ip-vps:8080 nếu chưa có domain), việc trỏ domain/SSL nằm ngoài phạm vi README này

DB_DATABASE=hls_r2_studio
DB_USERNAME=hls_app
DB_PASSWORD=<đổi-mật-khẩu-mặc-định>
DB_ROOT_PASSWORD=<đổi-mật-khẩu-mặc-định>

R2_ACCESS_KEY_ID=<credentials-thật>
R2_SECRET_ACCESS_KEY=<credentials-thật>
R2_BUCKET=<bucket-thật>
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_URL=<url-public-thật>
```

Sinh `APP_KEY` (chạy qua Docker, sau khi đã `docker compose build` ở Bước 5):

```bash
docker compose run --rm app php artisan key:generate
```

### Bước 4 — Mở firewall

Nếu test trực tiếp qua `IP:8080` (chưa dùng domain):

```bash
ufw allow 8080/tcp
```

Nếu bạn dùng domain + reverse proxy (Nginx/Caddy ở tầng ngoài, hoặc panel quản lý như aaPanel) để trỏ vào ứng dụng và làm SSL, việc cấu hình đó nằm **ngoài phạm vi README này** — bạn tự thực hiện phần domain/SSL theo công cụ bạn chọn.

### Bước 5 — Build & chạy

```bash
docker compose build
docker compose up -d mysql
# đợi mysql healthy (docker compose run tự chờ theo depends_on ở bước sau)

docker compose run --rm app php artisan migrate --force

# Đổi khỏi admin/admin123 mặc định dev — dùng email và mật khẩu mạnh thật
docker compose run --rm app php artisan admin:create admin@your-domain.com "mat-khau-manh-that"

docker compose up -d
```

### Bước 6 — Cấu hình R2 CORS cho domain thật

Vào Cloudflare R2 dashboard → bucket → Settings → CORS Policy, thêm domain thật của VPS (hoặc `http://ip-vps:8080` nếu chưa có domain) vào `AllowedOrigins`. Nếu bỏ qua bước này, trình phát HLS.js trên domain thật sẽ không phát được video (lỗi CORS khi tải `.m3u8`/`.ts` từ R2).

### Bước 7 — Kiểm tra

```bash
docker compose ps                     # xác nhận các service đang chạy (mysql, app, queue x2, webserver)
curl http://localhost:8080            # hoặc curl domain thật, kỳ vọng nhận được trang login
docker compose logs -f queue          # theo dõi log transcode
```

Truy cập bằng trình duyệt vào domain/IP:port đã cấu hình, đăng nhập bằng tài khoản admin vừa tạo ở Bước 5, thử upload 1 video để xác nhận toàn bộ luồng transcode → upload R2 → phát video hoạt động.

### Bước 8 — Backup

Ứng dụng **không tự động backup** dữ liệu. Bạn cần tự thiết lập backup định kỳ cho volume `mysql-data` (ví dụ `mysqldump` chạy qua cron, hoặc công cụ backup có sẵn trong panel quản lý VPS bạn dùng như aaPanel). Đây là việc **cần làm**, không có sẵn mặc định trong project này.

## Chạy nhiều worker song song (transcode nhiều video cùng lúc)

Mặc định `docker-compose.yml` đã chạy **2 worker song song** (`queue: deploy.replicas: 2`), nên `docker compose up -d` (kể cả sau `docker compose down`, kể cả khi deploy lần đầu lên VPS thật) sẽ tự động lên đúng 2 container `queue` — không cần nhớ chạy `--scale queue=2` thủ công mỗi lần.

Để đổi số worker, sửa `replicas` của service `queue` trong `docker-compose.yml` rồi `docker compose up -d`:

```yaml
  queue:
    ...
    deploy:
      replicas: 2   # số worker chạy song song — tuỳ chỉnh theo số core CPU thực tế của VPS
```

Đã test thật: `deploy.replicas` hoạt động đúng với `docker compose up -d` trên Docker Compose v2 hiện đại (đã xác nhận trên Docker Compose v5.5.1, không cần Swarm mode) — chạy `docker compose ps` sẽ thấy đúng N container `hls-r2-studio-queue-1`, `-2`, `-3`, ...

Chỉ cần dùng `--scale` khi muốn **override tạm thời** số worker mà không sửa file (không đổi default):

```bash
docker compose up -d --scale queue=5
```

**Chọn số lượng worker theo CPU của VPS**: mỗi worker chạy `ffmpeg` là tác vụ CPU-bound (dùng nhiều core khi encode). Khuyến nghị đặt số worker = **số core CPU của VPS trừ 1** (để dư 1 core cho web server/php-fpm và việc dispatch job). Số `deploy.replicas` hiện tại của service `queue` không tự động thay đổi theo mục này — muốn đổi thì sửa thủ công trong `docker-compose.yml` như hướng dẫn ở trên.

### Database: MySQL

Ứng dụng dùng queue driver `database` trên **MySQL** (`QUEUE_CONNECTION=database`, `DB_CONNECTION=mysql`), chạy qua container `mysql` (image `mysql:8.4`, dữ liệu lưu ở named volume `mysql-data`). MySQL dùng row-level lock nên nhiều worker (`queue: deploy.replicas`) tranh nhau lấy/xoá job cùng lúc không gây lỗi khoá file như SQLite.

Container `app`/`queue` chờ `mysql` healthy (`depends_on: mysql: condition: service_healthy`) trước khi khởi động, nên `docker compose up -d` tự đợi đúng thứ tự.

## Lưu ý khác

- MySQL database (named volume `mysql-data`), upload tạm và thư mục transcode tạm (`storage/app/private/...`) nằm trong Docker named volumes (`mysql-data`, `storage-data`) để không mất dữ liệu giữa các lần `docker compose down` / `up`. `docker compose down -v` sẽ xoá sạch các volume này (mất DB + upload tạm).
- Laravel validate dung lượng file theo `UPLOAD_MAX_SIZE_MB` trong `.env`, nhưng **PHP tự nó cũng giới hạn dung lượng upload** thông qua `php.ini` (`docker/php/uploads.ini` trong image Docker). Nếu đổi `UPLOAD_MAX_SIZE_MB`, phải sửa thêm giới hạn tương ứng trong `docker/php/uploads.ini` (`upload_max_filesize`, `post_max_size`) và `client_max_body_size` trong `docker/nginx.conf`, sau đó `docker compose build app queue` lại (PHP ini và nginx conf không đọc trực tiếp biến môi trường từ `.env`).
- `app/Jobs/TranscodeVideoJob.php` gọi `ffmpeg`/`ffprobe` qua `config('services.ffmpeg.binary')` / `config('services.ffmpeg.ffprobe_binary')`, đọc từ biến môi trường `FFMPEG_BINARY`/`FFPROBE_BINARY`. Mặc định `.env.example` là `ffmpeg`/`ffprobe` (không path), tức tự tìm trong `$PATH` của container — image Docker cài ffmpeg qua `apt` nên binary đã nằm sẵn trong `$PATH` chuẩn, không cần symlink hay path riêng.
