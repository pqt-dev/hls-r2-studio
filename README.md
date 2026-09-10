# HLS R2 Studio

Ứng dụng quản lý video nội bộ: upload video, băm sang HLS bằng FFmpeg, lưu trữ trên Cloudflare R2 và phát qua trình phát HLS.js. Có sẵn dashboard theo dõi server, nhật ký upload và trang cài đặt để cấu hình R2/transcode.

## Chức năng

- Đăng nhập admin
- Upload video (đơn lẻ hoặc nhiều file, hỗ trợ file lớn qua chunk-upload)
- Băm HLS bằng FFmpeg, tuỳ chỉnh chất lượng (480/720/1080p), độ dài segment, FPS
- Upload lên Cloudflare R2, phát qua HLS.js
- Dashboard Tổng quan (số liệu CPU/RAM/Disk server + thống kê video)
- Trang Nhật ký (lịch sử upload)
- Trang Cài đặt (đổi mật khẩu, cấu hình R2 động, tuỳ chọn xử lý)
- Danh sách video dạng bảng, phân trang, xoá hàng loạt
- Hiển thị thông số kỹ thuật video (độ phân giải, fps, codec, bitrate, kích thước file)
- Chạy nhiều worker song song để băm nhiều video cùng lúc

**Lưu ý**: URL public của video phụ thuộc vào việc bạn tự cấu hình bucket R2 public (custom domain hoặc `r2.dev` URL) trên Cloudflare dashboard và điền vào `R2_URL` (hoặc trường `r2_url` trong trang Cài đặt). Code không tự động public hoá bucket.

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

## Cài đặt

### Cách 1: Không dùng Docker (cài trực tiếp)

Yêu cầu: PHP 8.2+, Composer, Node.js + npm, MySQL, FFmpeg/FFprobe, tài khoản Cloudflare R2.

```bash
composer install
npm install && npm run build

cp .env.example .env
php artisan key:generate
```

Điền vào `.env`: thông tin MySQL (`DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`), Cloudflare R2 (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_URL`), và `FFMPEG_BINARY`/`FFPROBE_BINARY` nếu ffmpeg không nằm trong `$PATH` (dùng `which ffmpeg` / `which ffprobe` để lấy full path).

Laravel migration chỉ tạo bảng, không tự tạo database — tạo database trống trên MySQL trước khi migrate (đổi `hls_r2_studio` khớp với `DB_DATABASE` bạn đã điền ở bước trên):

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
php artisan migrate
php artisan admin:create admin@example.com "mat-khau-manh"
```

Chạy ứng dụng — cần **hai tiến trình song song**:

```bash
# Terminal 1
php artisan serve

# Terminal 2 — bắt buộc, video sẽ không transcode nếu không chạy queue worker
php artisan queue:work
```

Truy cập `http://localhost:8000/login`.

### Cách 2: Dùng Docker (chạy local hoặc lên VPS — cùng 1 quy trình)

Các bước dưới đây giống nhau dù chạy trên máy local hay trên VPS thật — nếu deploy VPS, SSH vào VPS trước rồi làm các bước y hệt.

Yêu cầu: Docker + Docker Compose đã cài (trên VPS: `curl -fsSL https://get.docker.com | sh`).

Nếu là VPS, đưa code lên VPS trước (không copy `.env` thật qua kênh này):

```bash
rsync -avz --progress --exclude 'node_modules' --exclude 'vendor' --exclude '.env' --exclude '.git' \
  ./ user@your-vps-ip:/path/to/hls-r2-studio/
```

Các bước còn lại (local và VPS giống nhau):

```bash
cp .env.example .env
```

- Điền R2 thật vào `.env` (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_URL`).
- Đổi `DB_PASSWORD`/`DB_ROOT_PASSWORD` khỏi giá trị mặc định.
- Sinh `APP_KEY`: `docker compose run --rm app php artisan key:generate`.
- Nếu là VPS production: đổi thêm `APP_ENV=production`, `APP_DEBUG=false`, `APP_URL=<domain thật>`.

Không cần tự tạo database — container `mysql` tự tạo theo `MYSQL_DATABASE`/`DB_DATABASE` trong `.env` ngay lần khởi động đầu tiên.

```bash
docker compose up -d mysql
# đợi mysql healthy

docker compose run --rm app php artisan migrate --force
docker compose run --rm app php artisan admin:create admin@example.com "mat-khau-manh"

docker compose up -d
```

Truy cập `http://localhost:8080/login` (hoặc domain/IP:port VPS).

Nếu là VPS và test qua IP:port, mở firewall: `ufw allow 8080/tcp`.

- Domain/SSL và cập nhật CORS R2 cho domain thật là việc cần tự làm thêm (không nằm trong phạm vi hướng dẫn này).
- Nên tự thiết lập backup định kỳ cho volume `mysql-data` (ứng dụng không tự động backup).

## Chạy nhiều worker song song

Mặc định `docker-compose.yml` chạy 2 worker song song (`queue: deploy.replicas: 2`). Để đổi số lượng, sửa `replicas` của service `queue` rồi `docker compose up -d`:

```yaml
  queue:
    deploy:
      replicas: 2   # tuỳ chỉnh theo số core CPU thực tế của VPS
```

Khuyến nghị: số worker = số core CPU trừ 1 (dư 1 core cho web server). Có thể override tạm thời bằng `docker compose up -d --scale queue=5`.

## Lưu ý khác

- Laravel giới hạn upload theo `UPLOAD_MAX_SIZE_MB` trong `.env`, nhưng PHP còn giới hạn riêng qua `php.ini` (`docker/php/uploads.ini`) và nginx (`client_max_body_size` trong `docker/nginx.conf`) — đổi cả 3 nơi rồi build lại image nếu cần tăng giới hạn.
- `FFMPEG_BINARY`/`FFPROBE_BINARY` mặc định là `ffmpeg`/`ffprobe` (lấy từ `$PATH`); image Docker đã cài sẵn qua `apt` nên không cần chỉnh khi chạy Docker.
