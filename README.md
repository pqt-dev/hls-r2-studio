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
| username | string, unique | dùng để đăng nhập |
| email | string, nullable | dự phòng cho tính năng quên mật khẩu sau này, hiện có thể để trống |
| email_verified_at | timestamp, nullable | không dùng trong luồng hiện tại (không có xác minh email) |
| password | string, hashed | |
| remember_token | string, nullable | |
| created_at / updated_at | timestamp | |

## Cài đặt

### Cách 1: Cài trực tiếp (khuyến nghị cho VPS/production)

Khuyến nghị dùng cách này cho VPS/production: Docker chạy Nginx và kết nối DB riêng dễ xung đột với panel quản lý VPS có sẵn (ví dụ aaPanel) — từng gặp lỗi HTTPS/CSS do 2 lớp Nginx chồng nhau, và firewall/quyền MySQL phức tạp không cần thiết khi mọi thứ vốn đã chạy sẵn trên cùng máy.

> **VPS của bạn đã có sẵn panel quản lý (aaPanel, cPanel, Plesk...) chưa?**
> - **Đã có aaPanel** → làm theo mục [Deploy với aaPanel](#deploy-với-aapanel) bên dưới — đơn giản hơn nhiều, không cần tự cài Nginx/PHP-FPM/systemd thủ công.
> - **VPS "trắng", chưa cài gì** → làm theo phần "Cài Nginx + PHP-FPM thủ công" tiếp theo ngay sau đây.

Yêu cầu: PHP 8.4+ (composer.json yêu cầu PHP `^8.4` vì `composer.lock` khoá một số gói Symfony yêu cầu PHP >=8.4), Composer 2.2+ (bản cũ hơn sẽ báo lỗi `composer-runtime-api` không tương thích — cập nhật bằng `composer self-update`), Node.js + npm, MySQL, FFmpeg/FFprobe, tài khoản Cloudflare R2.

```bash
composer install
npm install && npm run build

cp .env.example .env
php artisan key:generate
```

Mở file `.env` và điền các giá trị sau — mỗi key một dòng riêng biệt, không gộp chung:

**Database (MySQL):**
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user MySQL>
DB_PASSWORD=<password MySQL>
```
> `DB_HOST` là `127.0.0.1` khi MySQL chạy trên cùng máy với PHP (trường hợp thường gặp nhất, kể cả khi dùng aaPanel). Giá trị `mysql` chỉ có ý nghĩa khi chạy qua Docker Compose ở Cách 2 — không dùng giá trị đó ở Cách 1.

**Cloudflare R2:**
```env
R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<tên bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<URL public để phát video, vd https://cdn.your-domain.com hoặc URL r2.dev>
```

**FFmpeg** (chỉ cần điền nếu ffmpeg/ffprobe không nằm sẵn trong `$PATH` — kiểm tra bằng `which ffmpeg` và `which ffprobe` trước):
```env
FFMPEG_BINARY=/usr/bin/ffmpeg
FFPROBE_BINARY=/usr/bin/ffprobe
```

**Domain/HTTPS** (bắt buộc đổi khi deploy production):
```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-thật-của-bạn
```

Laravel migration chỉ tạo bảng, không tự tạo database — tạo database trống trên MySQL trước khi migrate (đổi `hls_r2_studio` khớp với `DB_DATABASE` bạn đã điền ở bước trên):

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
php artisan migrate
php artisan admin:create admin "mat-khau-manh" --email=admin@example.com
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

Cần làm 2 việc: **(1) tạo 1 file cấu hình mới** mô tả cách chạy queue worker, **(2) bật nó chạy**. Systemd là công cụ có sẵn trên Linux để quản lý các tiến trình chạy nền (tự khởi động lại nếu crash, tự chạy khi VPS reboot) — không cần cài thêm gì.

**Bước 1** — tạo file (dùng `nano`, dán nguyên đoạn dưới vào, lưu bằng `Ctrl+O` → `Enter` → `Ctrl+X`):
```bash
sudo nano /etc/systemd/system/hls-r2-studio-queue@.service
```
Dán đoạn cấu hình sau (giải thích nhanh: `[Unit]` = thông tin chung + chờ mạng/MySQL sẵn sàng trước khi chạy; `[Service]` = lệnh thực sự chạy và tự khởi động lại nếu lỗi; `[Install]` = tự chạy mỗi khi VPS khởi động lại):

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

**Bước 2** — bật chạy thật (lệnh này mới là lúc queue worker THỰC SỰ bắt đầu chạy), kích hoạt 2 worker song song (khớp mặc định Docker):

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

#### Deploy với aaPanel

aaPanel tự quản lý Nginx + PHP-FPM + SSL cho bạn — không cần tự `apt install nginx`/tự tạo file cấu hình Nginx như phần "VPS trắng" ở trên (làm vậy sẽ xung đột với Nginx của chính aaPanel).

**Bước 1 — Đưa code lên VPS**

SSH vào VPS, vào thư mục web root (`/www/wwwroot/`), rồi clone code vào một thư mục tạm rồi đổi tên — cách này tránh lỗi `destination path '.' already exists` do aaPanel thường tự sinh sẵn vài file ẩn (`.user.ini`, `.htaccess`...) trong thư mục site trống mà `ls` mặc định không hiện ra:

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf ten-domain.com          # thư mục site aaPanel đã tạo sẵn (nếu có), đổi đúng tên domain thật
mv hls-temp ten-domain.com
cd ten-domain.com
```

**Bước 2 — Kiểm tra và cài đúng version PHP**

Dự án yêu cầu PHP `^8.4` theo `composer.json`, vì `composer.lock` khoá một số gói Symfony (ví dụ `symfony/console`, `symfony/http-foundation`, `symfony/http-kernel`...) yêu cầu PHP **>= 8.4**. Kiểm tra:

```bash
php -v
```

Nếu VPS chưa có PHP 8.4: vào aaPanel → **App Store** → tab **PHP** → tìm **PHP-8.4** → **Install**. Không cần gỡ bản PHP cũ, aaPanel cho cài song song nhiều bản.

Từ đây, các lệnh PHP CLI trong hướng dẫn này đều dùng full path tới đúng bản 8.4 để tránh gọi nhầm bản mặc định cũ hơn (thường vẫn còn là 8.3 sau khi cài thêm 8.4):

```bash
/www/server/php/84/bin/php -v
```
(nếu đường dẫn khác, kiểm tra bằng `ls /www/server/php/` để tìm đúng số thư mục version)

**Bước 3 — Bật extension PHP bắt buộc**

aaPanel → **PHP** → chọn **8.4** → **Install extensions** (hoặc **Installed Extensions**) → bật các extension sau (không phải lúc nào cũng bật sẵn mặc định, phải tự kiểm tra từng cái):
- `fileinfo` — **bắt buộc**, thiếu sẽ làm `composer install` báo lỗi ngay
- `pdo_mysql`
- `mbstring`
- `curl`
- `pcntl`
- `bcmath`

Sau khi tick xong → **Restart** PHP 8.4. Kiểm tra lại:
```bash
/www/server/php/84/bin/php -m | grep fileinfo
```

**Bước 4 — Cập nhật Composer** (bản Composer có sẵn trên nhiều VPS/aaPanel là bản cũ, không hỗ trợ Laravel 13):

```bash
/www/server/php/84/bin/php /usr/bin/composer self-update
```

Nếu lệnh trên báo lỗi không tìm thấy composer, cài mới:
```bash
/www/server/php/84/bin/php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
/www/server/php/84/bin/php composer-setup.php --install-dir=/usr/bin --filename=composer
/www/server/php/84/bin/php -r "unlink('composer-setup.php');"
```

**Bước 5 — Cài Node.js + FFmpeg** (nếu VPS chưa có):

```bash
# Node.js 20+ qua NodeSource (bản apt mặc định của Ubuntu thường quá cũ)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# FFmpeg
sudo apt install -y ffmpeg
```

**Bước 6 — Cài dependencies + build asset**

```bash
/www/server/php/84/bin/php /usr/bin/composer install --no-dev
npm install
npm run build
```

**Bước 7 — Tạo database qua aaPanel**

aaPanel → **Database** → **Add database** → đặt tên (vd `hls_r2_studio`) → tạo user + password mới → ghi nhớ lại 3 thông tin này để điền `.env` ở bước sau.

**Bước 8 — Cấu hình `.env`**

```bash
cp .env.example .env
```

Mở file bằng `nano .env`, điền các giá trị sau — **mỗi key một dòng riêng biệt**, không gộp chung:

```env
# Database — khớp với database vừa tạo ở Bước 7
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user MySQL vừa tạo>
DB_PASSWORD=<password MySQL vừa tạo>
```

> `DB_HOST` luôn là `127.0.0.1` khi deploy kiểu này (PHP và MySQL cùng chạy trên 1 máy qua aaPanel) — **không** dùng giá trị `mysql`, đó là tên service chỉ có ý nghĩa trong Cách 2 (Docker).

```env
# Cloudflare R2
R2_ACCESS_KEY_ID=<access key R2>
R2_SECRET_ACCESS_KEY=<secret key R2>
R2_BUCKET=<tên bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<URL public để phát video — custom domain hoặc URL r2.dev>
```

```env
# Domain/HTTPS thật
APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-thật-của-bạn
FORCE_HTTPS=true
```

**Bước 9 — Sinh key, tạo bảng, tạo admin**

```bash
/www/server/php/84/bin/php artisan key:generate
/www/server/php/84/bin/php artisan migrate --force
/www/server/php/84/bin/php artisan admin:create admin "mat-khau-manh" --email=admin@example.com
```

**Bước 10 — Set quyền thư mục** (Laravel cần ghi được vào `storage/` và `bootstrap/cache/`; `www` là user chạy PHP-FPM mặc định của aaPanel — kiểm tra bằng `ps aux | grep php-fpm` nếu VPS bạn dùng user khác):

```bash
chown -R www:www storage bootstrap/cache
chmod -R 775 storage bootstrap/cache
```

**Bước 11 — Tạo website trong aaPanel**

Vào tab **Website** → **Add site** (hoặc **PHP Project** tuỳ phiên bản aaPanel) → điền domain → chọn **PHP version 8.4** → **Document Root** đặt thành thư mục `public/` bên trong code vừa clone (ví dụ `/www/wwwroot/ten-domain.com/public`) — Laravel luôn trỏ web root vào `public/`, không phải thư mục gốc project.

Nếu site đã được tạo sẵn trước khi bạn clone code (thường gặp), vào site đó → **Directory** → xác nhận **Site directory** đang trỏ đúng `.../public`.

**Bước 12 — Tắt "Anti-XSS attack" (open_basedir)**

Vào site → **Directory** → tìm toggle **Anti-XSS attack** (chú thích nhỏ bên dưới: *Base directory limit / open_basedir*) → đảm bảo toggle này đang **TẮT**.

> ⚠️ Đây là bước dễ bị bỏ sót nhất và gây lỗi khó hiểu nhất: nếu bật, PHP chỉ được phép đọc file trong `public/` — nhưng code Laravel thật (`vendor/`, `storage/`, `bootstrap/`) nằm ở thư mục cha, nên trang sẽ trắng trang kèm lỗi `open_basedir restriction in effect` khi truy cập. Nếu gặp lỗi này, quay lại đây tắt toggle rồi thử lại.

**Bước 13 — Bật URL rewrite (bắt buộc, thiếu bước này mọi trang ngoài trang chủ sẽ báo `404 Not Found`)**

Vào site → **URL rewrite** (伪静态) → chọn template có sẵn **Laravel5** (hoặc **Laravel**, tuỳ tên hiển thị) → **Save**.

Nếu aaPanel không có sẵn template Laravel, chọn **Custom** và dán:
```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

**Bước 14 — Tăng giới hạn upload**

aaPanel → **PHP** → **8.4** → **Configuration file** → tìm và sửa:
```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
memory_limit = 512M
```
**Save** → aaPanel tự restart PHP-FPM.

**Bước 15 — Bật SSL**

Vào site → tab **SSL** → chọn **Let's Encrypt** → tick domain → **Apply** (aaPanel tự xin và tự gia hạn chứng chỉ, không cần đụng vào Nginx config thủ công).

**Bước 16 — Chạy queue worker bằng systemd** (bắt buộc — video sẽ không bao giờ transcode nếu thiếu bước này; aaPanel KHÔNG tự quản lý việc này)

Tạo file:
```bash
nano /etc/systemd/system/hls-r2-studio-queue@.service
```

Dán đúng nội dung sau — chú ý `--timeout=3600`, thiếu cờ này Laravel sẽ tự kill job sau 60 giây mặc định (dù video ngắn, quá trình ffmpeg + upload R2 thường vượt quá 60 giây):

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/ten-domain.com
ExecStart=/www/server/php/84/bin/php artisan queue:work --sleep=3 --tries=1 --timeout=3600 --max-time=3600
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Kích hoạt 2 worker song song:
```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-queue@1
systemctl enable --now hls-r2-studio-queue@2
```

Kiểm tra: `systemctl status hls-r2-studio-queue@1`, xem log: `journalctl -u hls-r2-studio-queue@1 -f`.

**Bước 17 — Kiểm tra**

Mở `https://domain-thật/login`, đăng nhập bằng tài khoản admin đã tạo ở Bước 9, thử upload 1 video ngắn để xác nhận toàn bộ pipeline (upload → transcode → upload R2 → phát HLS) chạy hoàn chỉnh.

#### Xử lý sự cố thường gặp khi deploy aaPanel

| Lỗi gặp phải | Nguyên nhân | Cách fix |
|---|---|---|
| `destination path '.' already exists` khi `git clone` | Thư mục site có file ẩn aaPanel tự sinh (`.user.ini`...) mà `ls` không hiện | Clone vào thư mục tạm rồi `mv` đè lên (xem Bước 1) |
| `composer install` báo `ext-fileinfo` thiếu | Extension `fileinfo` chưa bật cho bản PHP đang dùng | Bật qua aaPanel → PHP → Install extensions (Bước 3) |
| `composer install` báo các gói Symfony yêu cầu PHP >= 8.4 | VPS đang chạy PHP 8.3 nhưng `composer.lock` khoá bản cần 8.4 | Cài PHP 8.4 qua App Store (Bước 2) |
| `composer install` báo `composer-runtime-api` không khớp | Bản Composer cài sẵn quá cũ (< 2.2) | `composer self-update` (Bước 4) |
| Trang trắng, lỗi `open_basedir restriction in effect` | Toggle "Anti-XSS attack" (open_basedir) đang bật, giới hạn PHP chỉ đọc được `public/` | Tắt toggle này trong site → Directory (Bước 12) |
| `404 Not Found nginx` khi vào `/login` (nhưng trang chủ `/` vào được) | Thiếu rule rewrite URL đẹp cho Laravel | Bật URL rewrite template Laravel5 (Bước 13) |
| Video kẹt ở "Đang xử lý" mãi không xong, log có `Job timed out` | Queue worker thiếu cờ `--timeout`, Laravel tự kill job sau 60s mặc định | Thêm `--timeout=3600` vào `ExecStart` của systemd unit (Bước 16) |
| `systemctl restart nginx`/`php-fpm-84` báo lỗi nhưng service vẫn đang chạy | Script khởi động kiểu LSB không xử lý đúng "restart" khi service đã chạy | Dùng `/etc/init.d/nginx reload` và `/etc/init.d/php-fpm-84 restart` thay vì `systemctl restart` |

### Cách 2: Dùng Docker (CHỈ khuyến nghị cho test/dev cục bộ, KHÔNG dùng cho VPS)

Cách này chỉ nên dùng để test tính năng trên máy cá nhân trước khi deploy thật bằng Cách 1. Không dùng Docker để deploy lên VPS production — xem lý do ở đầu mục Cách 1.

Yêu cầu: Docker + Docker Compose đã cài.

```bash
cp .env.example .env
```

- Điền R2 thật vào `.env` (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_URL`).
- Đổi `DB_PASSWORD` và `DB_ROOT_PASSWORD` khỏi giá trị mặc định.

**Bắt buộc — sinh `APP_KEY`** (Laravel dùng key này để mã hoá session, cookie, và các trường nhạy cảm như `r2_secret_access_key` trong Cài đặt; thiếu key này app sẽ lỗi ngay khi chạy):

```bash
docker compose run --rm app php artisan key:generate
```

⚠️ Chỉ chạy lệnh này **1 lần duy nhất** khi mới cài — sinh lại `APP_KEY` sau khi đã có dữ liệu thật sẽ làm hỏng các trường đã mã hoá bằng key cũ (ví dụ R2 Secret Key đã lưu qua trang Cài đặt sẽ không giải mã được nữa).

```bash
docker compose up -d
docker compose run --rm app php artisan migrate --force
docker compose run --rm app php artisan admin:create admin "mat-khau-manh" --email=admin@example.com
```

Truy cập `http://localhost:8080/login`.

## Chạy nhiều worker song song

Với Cách 1 (cài trực tiếp), "nhiều worker" nghĩa là chạy nhiều instance systemd (`hls-r2-studio-queue@1`, `hls-r2-studio-queue@2`, ...) — xem hướng dẫn ở bước 5 của Cách 1.

Nếu dùng Cách 2 (Docker, chỉ để test/dev cục bộ): mặc định `docker-compose.yml` chạy 2 worker song song (`queue: deploy.replicas: 2`). Để đổi số lượng, sửa `replicas` của service `queue` rồi `docker compose up -d`:

```yaml
  queue:
    deploy:
      replicas: 2
```

Có thể override tạm thời bằng `docker compose up -d --scale queue=5`.

## Lưu ý khác

- Laravel giới hạn upload theo `UPLOAD_MAX_SIZE_MB` trong `.env`, nhưng PHP còn giới hạn riêng qua `php.ini` (`docker/php/uploads.ini`) và nginx (`client_max_body_size` trong `docker/nginx.conf`) — đổi cả 3 nơi rồi build lại image nếu cần tăng giới hạn.
- `FFMPEG_BINARY`/`FFPROBE_BINARY` mặc định là `ffmpeg`/`ffprobe` (lấy từ `$PATH`); image Docker đã cài sẵn qua `apt` nên không cần chỉnh khi chạy Docker.
- Nếu deploy sau reverse proxy có SSL riêng (aaPanel, Nginx ngoài, Cloudflare Tunnel...), có 2 cách để link asset/URL sinh ra dùng đúng `https://` (nếu không sẽ bị sai scheme `http://` gây mixed content):
  - **Cách 1**: cấu hình reverse proxy gửi đúng header `X-Forwarded-Proto: https` — app đã tự động trust proxy header (`trustProxies(at: '*')` trong `bootstrap/app.php`) nên phía Laravel không cần chỉnh gì thêm. Một số panel (ví dụ aaPanel) tự sinh cấu hình Nginx không kèm header này, phải tự sửa tay và dễ bị ghi đè khi sửa lại qua GUI.
  - **Cách 2 (đơn giản hơn, khuyến nghị)**: set `APP_ENV=production` trong `.env` (thường đã có sẵn ở môi trường production) hoặc `FORCE_HTTPS=true` — Laravel sẽ tự ép scheme `https` cho mọi URL sinh ra (`URL::forceScheme('https')` trong `AppServiceProvider`), không cần đụng gì tới cấu hình proxy/Nginx bên ngoài. Mặc định `FORCE_HTTPS` bật theo `APP_ENV=production`, có thể override thủ công bằng `FORCE_HTTPS=false`/`true`.
  - **Lưu ý**: KHÔNG bật `FORCE_HTTPS=true` (hoặc `APP_ENV=production`) trên môi trường dev local không có HTTPS thật ở tầng ngoài — trình duyệt sẽ cố tải asset qua `https://` trên cổng không có TLS (ví dụ `https://localhost:8080`) và load lỗi. Tính năng này chỉ dùng cho VPS production có HTTPS thật ở tầng ngoài (aaPanel/Nginx làm SSL termination).
- Thư mục `database/` bên trong container là named volume (`database-data`) — sau khi `git pull` code có migration MỚI rồi `docker compose build/up`, migration file mới có thể KHÔNG tự xuất hiện trong container (volume cũ che mất bản mới từ image). Nếu `php artisan migrate` chạy xong nhưng thiếu đúng migration bạn vừa thêm, copy tay vào trước:
  ```bash
  docker compose cp database/migrations/<tên_file_migration>.php app:/var/www/html/database/migrations/
  docker compose exec app php artisan migrate --force
  ```
