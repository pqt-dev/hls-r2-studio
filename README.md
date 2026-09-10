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

#### Chạy production thật trên VPS (thay vì `php artisan serve`)

`php artisan serve` chỉ dùng để dev — không bền vững cho production (không tự khởi động lại, không xử lý nhiều connection tốt). Các bước dưới đây thay thế bằng Nginx + PHP-FPM + systemd, giả định Ubuntu 22.04/24.04.

**1. Cài Nginx + PHP-FPM** (đổi `php8.2-fpm` theo đúng version PHP đã cài — kiểm tra bằng `php -v`):

```bash
sudo apt install -y nginx php8.2-fpm
```

**2. Set quyền thư mục** (Laravel cần ghi được vào `storage/` và `bootstrap/cache/`):

```bash
sudo chown -R www-data:www-data storage bootstrap/cache
sudo chmod -R 775 storage bootstrap/cache
```

**3. Cấu hình Nginx** — tạo file `/etc/nginx/sites-available/hls-r2-studio`:

```nginx
server {
    listen 80;
    server_name your-domain.com;   # đổi thành domain thật hoặc để _ nếu test qua IP

    root /path/to/hls-r2-studio/public;   # đổi đúng đường dẫn project thật
    index index.php;

    client_max_body_size 2048m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;   # đổi khớp version PHP-FPM đã cài
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300s;
    }

    location ~ /\.(?!well-known).* {
        deny all;
    }
}
```

Kích hoạt:

```bash
sudo ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**4. Cấu hình `php.ini` cho PHP-FPM** (khớp `UPLOAD_MAX_SIZE_MB=2048`) — sửa `/etc/php/8.2/fpm/php.ini`:

```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
```

Restart: `sudo systemctl restart php8.2-fpm`.

**5. Chạy queue worker bền vững bằng systemd** (thay vì mở terminal thủ công) — tạo file `/etc/systemd/system/hls-r2-studio-queue@.service` (template unit để chạy nhiều instance song song, khớp mặc định 2 worker của bản Docker):

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service

[Service]
User=www-data
WorkingDirectory=/path/to/hls-r2-studio
ExecStart=/usr/bin/php artisan queue:work --tries=1 --timeout=3600
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Kích hoạt 2 worker song song (khớp mặc định Docker):

```bash
sudo systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
```

Kiểm tra: `sudo systemctl status hls-r2-studio-queue@1`, xem log: `sudo journalctl -u hls-r2-studio-queue@1 -f`.

**6. Firewall**:

```bash
sudo ufw allow 80/tcp
```

**7. Cập nhật code sau này** (không như Docker tự rebuild) cần tự chạy lại `composer install --no-dev`, `npm run build`, và `sudo systemctl restart php8.2-fpm hls-r2-studio-queue@1 hls-r2-studio-queue@2` để áp dụng code mới.

- Domain/SSL, cập nhật CORS R2 cho domain thật, và backup định kỳ vẫn là việc cần tự làm thêm (giống Cách 2, không lặp lại chi tiết ở đây).

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
- Nếu là VPS production: đổi thêm `APP_ENV=production`, `APP_DEBUG=false`, `APP_URL=<domain thật>`.

**Bắt buộc — sinh `APP_KEY`** (Laravel dùng key này để mã hoá session, cookie, và các trường nhạy cảm như `r2_secret_access_key` trong Cài đặt; thiếu key này app sẽ lỗi ngay khi chạy):

```bash
docker compose run --rm app php artisan key:generate
```

⚠️ Chỉ chạy lệnh này **1 lần duy nhất** khi mới cài — sinh lại `APP_KEY` sau khi đã có dữ liệu thật sẽ làm hỏng các trường đã mã hoá bằng key cũ (ví dụ R2 Secret Key đã lưu qua trang Cài đặt sẽ không giải mã được nữa).

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
- Nếu deploy sau reverse proxy có SSL riêng (aaPanel, Nginx ngoài, Cloudflare Tunnel...), có 2 cách để link asset/URL sinh ra dùng đúng `https://` (nếu không sẽ bị sai scheme `http://` gây mixed content):
  - **Cách 1**: cấu hình reverse proxy gửi đúng header `X-Forwarded-Proto: https` — app đã tự động trust proxy header (`trustProxies(at: '*')` trong `bootstrap/app.php`) nên phía Laravel không cần chỉnh gì thêm. Một số panel (ví dụ aaPanel) tự sinh cấu hình Nginx không kèm header này, phải tự sửa tay và dễ bị ghi đè khi sửa lại qua GUI.
  - **Cách 2 (đơn giản hơn, khuyến nghị)**: set `APP_ENV=production` trong `.env` (thường đã có sẵn ở môi trường production) hoặc `FORCE_HTTPS=true` — Laravel sẽ tự ép scheme `https` cho mọi URL sinh ra (`URL::forceScheme('https')` trong `AppServiceProvider`), không cần đụng gì tới cấu hình proxy/Nginx bên ngoài. Mặc định `FORCE_HTTPS` bật theo `APP_ENV=production`, có thể override thủ công bằng `FORCE_HTTPS=false`/`true`.
  - **Lưu ý**: KHÔNG bật `FORCE_HTTPS=true` (hoặc `APP_ENV=production`) trên môi trường dev local không có HTTPS thật ở tầng ngoài — trình duyệt sẽ cố tải asset qua `https://` trên cổng không có TLS (ví dụ `https://localhost:8080`) và load lỗi. Tính năng này chỉ dùng cho VPS production có HTTPS thật ở tầng ngoài (aaPanel/Nginx làm SSL termination).
