# HLS R2 Studio

Ứng dụng quản lý video nội bộ: upload video, băm sang HLS bằng FFmpeg, lưu trữ trên Cloudflare R2 và phát qua trình phát HLS.js. Có sẵn dashboard theo dõi server, nhật ký upload, trang cài đặt và tính năng nhận báo lỗi phát video từ người xem.

## Chức năng

- Đăng nhập admin
- Upload video (đơn lẻ hoặc nhiều file, hỗ trợ file lớn qua chunk-upload)
- Băm HLS bằng FFmpeg, tuỳ chỉnh chất lượng (480/720/1080p), độ dài segment, FPS
- Upload lên Cloudflare R2, phát qua HLS.js
- Dashboard Tổng quan (số liệu CPU/RAM/Disk server + thống kê video)
- Trang Nhật ký (lịch sử upload)
- Trang Cài đặt (đổi mật khẩu, cấu hình R2 động, tuỳ chọn xử lý, số video/trang, múi giờ hiển thị)
- Danh sách video dạng bảng, phân trang, xoá hàng loạt
- Hiển thị thông số kỹ thuật video (độ phân giải, fps, codec, bitrate, kích thước file)
- Chạy nhiều worker song song để băm nhiều video cùng lúc
- Nhận báo lỗi phát video (Report) từ trang public qua API, quản lý/đánh dấu đã xử lý ở trang admin

**Lưu ý**: URL public của video phụ thuộc vào việc bạn tự cấu hình bucket R2 public (custom domain hoặc `r2.dev` URL) trên Cloudflare dashboard và điền vào `R2_URL` (hoặc trường `r2_url` trong trang Cài đặt). Code không tự động public hoá bucket.

### Tính năng Report (báo lỗi phát video)

Cho phép trang phát video công khai (kể cả đặt trên domain khác) gửi báo cáo lỗi phát về `POST /api/reports` (body: `page_url`, `note` tuỳ chọn). Nhiều báo cáo trùng `page_url` khi còn ở trạng thái `new` sẽ được gộp lại (tăng `report_count`), không tạo dòng mới. Admin xem/đánh dấu đã xử lý tại trang `/reports`.

Muốn gọi API này từ domain khác (site phát video không cùng domain với app), phải thêm domain đó vào `allowed_origins` trong `config/cors.php` — mặc định chỉ cho phép domain khai báo sẵn trong file này. Route API có rate limit 5 lần/10 giây.

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
| storyboard_path | string, nullable | path ảnh lưới storyboard (preview khi tua video) |
| storyboard_meta_path | string, nullable | path file metadata mô tả lưới storyboard |
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
| display_timezone | string, default `Asia/Ho_Chi_Minh` | múi giờ hiển thị thời gian trên giao diện |
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

Bảng `reports` (báo lỗi phát video, gửi từ trang public qua `POST /api/reports`):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | bigint | |
| page_url | string | URL trang đang phát video khi người xem báo lỗi |
| note | text, nullable | ghi chú thêm của người báo (tối đa 1000 ký tự) |
| reporter_ip | string, nullable | IP người gửi |
| status | string, default `new` | `new` \| `resolved` |
| report_count | unsigned int, default 1 | số lần bị báo trùng `page_url` khi còn `new` |
| resolved_at | timestamp, nullable | thời điểm admin đánh dấu đã xử lý |
| last_reported_at | timestamp, nullable | lần báo gần nhất (kể cả báo trùng) |
| created_at / updated_at | timestamp | |

## Cài đặt

### Cài đặt (khuyến nghị cho VPS/production)

Khuyến nghị dùng cách này cho VPS/production: chạy trực tiếp trên panel quản lý VPS có sẵn (ví dụ aaPanel) tránh xung đột Nginx/firewall/quyền MySQL khi mọi thứ vốn đã chạy sẵn trên cùng máy.

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
> `DB_HOST` là `127.0.0.1` khi MySQL chạy trên cùng máy với PHP (trường hợp thường gặp nhất, kể cả khi dùng aaPanel).

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
php artisan admin:create admin --email=admin@example.com
```
> Không truyền password trên dòng lệnh (tránh lộ qua lịch sử shell) — lệnh sẽ tự hỏi (`Enter password:`) và ẩn ký tự khi gõ. Password tối thiểu 8 ký tự. Muốn truyền trực tiếp vẫn được: `php artisan admin:create admin "mat-khau-manh" --email=admin@example.com`. Lệnh này upsert theo `username` — chạy lại với cùng username sẽ đổi mật khẩu tài khoản đó thay vì tạo trùng.

Chạy ứng dụng — cần **ba tiến trình song song**:

```bash
# Terminal 1
php artisan serve

# Terminal 2 — bắt buộc, video sẽ không transcode nếu không chạy queue worker
php artisan queue:work

# Terminal 3 — bắt buộc để tự động dọn rác hàng ngày (upload chunk bỏ dở, thư mục tạm
# băm HLS bị crash treo, file video mồ côi); nếu thiếu, rác không tự dọn nhưng
# ứng dụng vẫn hoạt động bình thường (khác với thiếu queue worker — thiếu queue worker
# thì video hoàn toàn không xử lý được)
php artisan schedule:work
```

Truy cập `http://localhost:8000/login`.

#### Chạy production thật trên VPS (thay vì `php artisan serve`)

`php artisan serve` chỉ dùng để dev — không bền vững cho production. Các bước dưới đây thay thế bằng Nginx + PHP-FPM + systemd, giả định Ubuntu 22.04/24.04.

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

**5. Chạy queue worker bền vững bằng systemd** (thay vì mở terminal thủ công) — tạo file `/etc/systemd/system/hls-r2-studio-queue@.service` (template unit để chạy nhiều instance song song):

**Bước 1** — tạo file (dùng `nano`, dán nguyên đoạn dưới vào, lưu bằng `Ctrl+O` → `Enter` → `Ctrl+X`):
```bash
sudo nano /etc/systemd/system/hls-r2-studio-queue@.service
```
Dán đoạn cấu hình sau:

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service

[Service]
User=www-data
WorkingDirectory=/path/to/hls-r2-studio
ExecStart=/usr/bin/php artisan queue:work --tries=1 --timeout=172800
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Bước 2** — bật chạy thật, kích hoạt 2 worker song song:

```bash
sudo systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
```

Kiểm tra: `sudo systemctl status hls-r2-studio-queue@1`, xem log: `sudo journalctl -u hls-r2-studio-queue@1 -f`.

> **Lưu ý về `DB_QUEUE_RETRY_AFTER`**: `.env.example` đã có sẵn `DB_QUEUE_RETRY_AFTER=176400`. Giá trị này PHẢI luôn LỚN HƠN `--timeout` của queue worker (`172800`) — nếu không, database queue driver sẽ coi 1 job đang chạy hợp lệ là "đã chết" và cho worker khác nhận lại, gây xử lý trùng lặp. Đổi cái này thì phải đổi cái kia theo.

**6. Chạy scheduler bền vững bằng systemd** (bắt buộc để 3 lệnh dọn rác tự động chạy hàng ngày, xem [Lưu ý khác](#lưu-ý-khác) — nếu thiếu, rác không tự dọn nhưng ứng dụng vẫn hoạt động bình thường)

Tạo file `/etc/systemd/system/hls-r2-studio-scheduler.service` (không dùng template `@` — scheduler chỉ cần chạy 1 instance duy nhất):

```bash
sudo nano /etc/systemd/system/hls-r2-studio-scheduler.service
```

```ini
[Unit]
Description=HLS R2 Studio Scheduler
After=network.target mysql.service

[Service]
User=www-data
WorkingDirectory=/path/to/hls-r2-studio
ExecStart=/usr/bin/php artisan schedule:work
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Bật chạy:

```bash
sudo systemctl enable --now hls-r2-studio-scheduler
```

Kiểm tra: `sudo systemctl status hls-r2-studio-scheduler`, xem log: `sudo journalctl -u hls-r2-studio-scheduler -f`.

**7. Firewall**:

```bash
sudo ufw allow 80/tcp
```

**8. Cập nhật code** — xem mục [Cập nhật / Deploy lại khi có code mới](#cập-nhật--deploy-lại-khi-có-code-mới) bên dưới.

- Domain/SSL, cập nhật CORS R2 cho domain thật, và backup định kỳ vẫn là việc cần tự làm thêm.

#### Deploy với aaPanel

aaPanel tự quản lý Nginx + PHP-FPM + SSL cho bạn — không cần tự `apt install nginx`/tự tạo file cấu hình Nginx như phần "VPS trắng" ở trên (làm vậy sẽ xung đột với Nginx của chính aaPanel).

**Bước 1 — Đưa code lên VPS**

SSH vào VPS, vào thư mục web root (`/www/wwwroot/`), clone code vào thư mục tạm rồi đổi tên (tránh lỗi `destination path '.' already exists` do aaPanel thường tự sinh sẵn vài file ẩn trong thư mục site trống):

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf ten-domain.com          # thư mục site aaPanel đã tạo sẵn (nếu có), đổi đúng tên domain thật
mv hls-temp ten-domain.com
cd ten-domain.com
```

**Bước 2 — Kiểm tra và cài đúng version PHP**

Dự án yêu cầu PHP `^8.4` theo `composer.json`, vì `composer.lock` khoá một số gói Symfony yêu cầu PHP **>= 8.4**. Kiểm tra:

```bash
php -v
```

Nếu VPS chưa có PHP 8.4: vào aaPanel → **App Store** → tab **PHP** → tìm **PHP-8.4** → **Install**. Không cần gỡ bản PHP cũ, aaPanel cho cài song song nhiều bản.

Từ đây, các lệnh PHP CLI trong hướng dẫn này đều dùng full path tới đúng bản 8.4 để tránh gọi nhầm bản mặc định cũ hơn:

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

> `DB_HOST` luôn là `127.0.0.1` khi deploy kiểu này (PHP và MySQL cùng chạy trên 1 máy qua aaPanel).

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
/www/server/php/84/bin/php artisan admin:create admin --email=admin@example.com
```
> Không truyền password trên dòng lệnh — lệnh sẽ tự hỏi (`Enter password:`, ẩn ký tự khi gõ, tối thiểu 8 ký tự). Chạy lại với cùng username sẽ đổi mật khẩu tài khoản đó (upsert theo `username`).

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

Dán đúng nội dung sau — chú ý `--timeout=172800`: timeout job scale theo độ dài video thật (hệ số x8, sàn 600s — xem `TRANSCODE_TIMEOUT_MULTIPLIER` ở [Lưu ý khác](#lưu-ý-khác)), và `172800` (48 tiếng) là trần an toàn tổng cho cả job (transcode + tạo thumbnail + upload R2), khớp với `$timeout` mức job trong code. Không dùng `3600` — quá thấp cho video dài, Laravel sẽ tự kill job giữa chừng:

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/ten-domain.com
ExecStart=/www/server/php/84/bin/php artisan queue:work --sleep=3 --tries=1 --timeout=172800 --max-time=172800
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

> **Lưu ý về `DB_QUEUE_RETRY_AFTER`**: `.env.example` đã có sẵn `DB_QUEUE_RETRY_AFTER=176400`, PHẢI luôn LỚN HƠN `--timeout` ở trên (`172800`) — nếu không, database queue driver sẽ coi 1 job đang chạy hợp lệ là "đã chết" và cho worker khác nhận lại, gây xử lý trùng lặp. Đổi cái này thì phải đổi cái kia theo.

**Bước 17 — Chạy scheduler bằng systemd** (bắt buộc để 3 lệnh dọn rác tự động chạy hàng ngày, xem [Lưu ý khác](#lưu-ý-khác) — nếu thiếu, rác không tự dọn nhưng ứng dụng vẫn hoạt động bình thường; aaPanel KHÔNG tự quản lý việc này)

Tạo file (không dùng template `@` như queue worker — scheduler chỉ cần chạy 1 instance duy nhất):
```bash
nano /etc/systemd/system/hls-r2-studio-scheduler.service
```

```ini
[Unit]
Description=HLS R2 Studio Scheduler
After=network.target mysql.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/ten-domain.com
ExecStart=/www/server/php/84/bin/php artisan schedule:work
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Kích hoạt:
```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-scheduler
```

Kiểm tra: `systemctl status hls-r2-studio-scheduler`, xem log: `journalctl -u hls-r2-studio-scheduler -f`.

**Bước 18 — Kiểm tra**

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
| Video kẹt ở "Đang xử lý" mãi không xong, log có `Job timed out` | Queue worker thiếu cờ `--timeout`, Laravel tự kill job sau 60s mặc định | Thêm `--timeout=172800` vào `ExecStart` của systemd unit (Bước 16) |
| `systemctl restart nginx`/`php-fpm-84` báo lỗi nhưng service vẫn đang chạy | Script khởi động kiểu LSB không xử lý đúng "restart" khi service đã chạy | Dùng `/etc/init.d/nginx reload` và `/etc/init.d/php-fpm-84 restart` thay vì `systemctl restart` |

## Chạy nhiều worker song song

"Nhiều worker" nghĩa là chạy nhiều instance systemd (`hls-r2-studio-queue@1`, `hls-r2-studio-queue@2`, ...) — xem hướng dẫn ở bước 5 trong mục [Chạy production thật trên VPS](#chạy-production-thật-trên-vps-thay-vì-php-artisan-serve).

## Cập nhật / Deploy lại khi có code mới

Luôn chạy `git pull`. Các lệnh còn lại chỉ chạy khi loại file tương ứng có thay đổi — không chắc thì cứ chạy hết cho chắc, không hại gì.

```bash
cd /path-to-project   # hoặc /www/wwwroot/ten-domain.com nếu dùng aaPanel
git pull
```

| Lệnh | Chỉ cần chạy khi nào |
|---|---|
| `composer install --no-dev` (dùng đúng bản PHP như hướng dẫn aaPanel nếu áp dụng) | `composer.json`/`composer.lock` thay đổi (có dependency mới) |
| `npm run build` | Có thay đổi trong `resources/css`, `resources/js`, hoặc file `.blade.php` (thêm/sửa class Tailwind) |
| `php artisan migrate --force` | Có file migration mới trong `database/migrations/` |
| `php artisan config:clear` | Đổi file `config/*.php` bất kỳ, hoặc thêm biến mới vào `.env` |
| Restart queue worker (`systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`, đổi tên service theo đúng phần deploy đã dùng ở trên) | `app/Jobs/TranscodeVideoJob.php` hoặc code xử lý hàng đợi thay đổi — PHP-FPM tự đọc code mới mỗi request nên các file PHP khác không cần restart gì, chỉ riêng queue worker giữ code cũ trong bộ nhớ tới khi restart |
| Restart scheduler | Hầu như KHÔNG BAO GIỜ cần, trừ khi sửa `routes/console.php` hoặc chính các lệnh cleanup trong `app/Console/Commands/` |

## Lưu ý khác

- Laravel giới hạn upload theo `UPLOAD_MAX_SIZE_MB` trong `.env`, nhưng PHP còn giới hạn riêng qua `php.ini` (`upload_max_filesize`, `post_max_size`) và nginx (`client_max_body_size`) — đổi cả các nơi này theo hướng dẫn ở bước 4 trong mục [Chạy production thật trên VPS](#chạy-production-thật-trên-vps-thay-vì-php-artisan-serve) (hoặc Bước 14 nếu deploy qua aaPanel) nếu cần tăng giới hạn.
- `FFMPEG_BINARY`/`FFPROBE_BINARY` mặc định là `ffmpeg`/`ffprobe` (lấy từ `$PATH`).
- Ứng dụng chạy 3 lệnh dọn rác hàng ngày qua Laravel scheduler (`uploads:cleanup-abandoned`, `videos:cleanup-orphaned-tmp`, `videos:cleanup-orphaned-uploads`) — các lệnh này KHÔNG tự chạy nếu thiếu tiến trình scheduler. Cần `php artisan schedule:work` chạy liên tục (xem Terminal 3 hoặc systemd unit `hls-r2-studio-scheduler` ở trên), hoặc thay bằng cron gọi `php artisan schedule:run` mỗi phút:
  ```
  * * * * * cd /path-to-project && php artisan schedule:run >> /dev/null 2>&1
  ```
  Nếu thiếu tiến trình này, rác (upload chunk bỏ dở, thư mục tạm băm HLS bị crash treo, file video mồ côi) sẽ không tự động được dọn, dù ứng dụng vẫn hoạt động bình thường.
- **Tuỳ chỉnh nâng cao** (không bắt buộc, có giá trị mặc định hợp lý — thêm vào `.env` nếu muốn đổi):
  ```env
  UPLOAD_ABANDONED_TTL_HOURS=24       # dọn upload chunk bỏ dở sau bao lâu
  TRANSCODE_ORPHANED_TTL_HOURS=48     # dọn thư mục tạm băm HLS bị crash treo sau bao lâu
  UPLOAD_ORPHANED_TTL_HOURS=72        # dọn file video gốc mồ côi sau bao lâu
  TRANSCODE_TIMEOUT_MULTIPLIER=8      # hệ số nhân với độ dài video để tính timeout băm HLS
  STORYBOARD_TILE_SIZE=160            # kích thước (px) mỗi ô trong ảnh lưới storyboard
  DB_QUEUE_RETRY_AFTER=176400         # PHẢI lớn hơn --timeout của queue worker (xem mục ở trên)
  ```
- Rate limiting: đăng nhập giới hạn 5 lần/phút, khởi tạo upload (`/uploads/init`) giới hạn 30 lần/phút, gửi chunk (`/uploads/{id}/chunk`) giới hạn 120 lần/phút, gửi report (`/api/reports`) giới hạn 5 lần/10 giây — nếu gặp lỗi "Too Many Requests" khi thao tác quá nhanh, đây là nguyên nhân.
- Muốn nhận report từ trang phát video đặt ở domain khác, thêm domain đó vào `allowed_origins` trong `config/cors.php` (mặc định chỉ cho phép domain khai báo sẵn trong file).
- Nếu deploy sau reverse proxy có SSL riêng (aaPanel, Nginx ngoài, Cloudflare Tunnel...), có 2 cách để link asset/URL sinh ra dùng đúng `https://` (nếu không sẽ bị sai scheme `http://` gây mixed content):
  - **Cách 1**: cấu hình reverse proxy gửi đúng header `X-Forwarded-Proto: https` — app đã tự động trust proxy header (`trustProxies(at: '*')` trong `bootstrap/app.php`) nên phía Laravel không cần chỉnh gì thêm. Một số panel (ví dụ aaPanel) tự sinh cấu hình Nginx không kèm header này, phải tự sửa tay và dễ bị ghi đè khi sửa lại qua GUI.
  - **Cách 2 (đơn giản hơn, khuyến nghị)**: set `APP_ENV=production` trong `.env` (thường đã có sẵn ở môi trường production) hoặc `FORCE_HTTPS=true` — Laravel sẽ tự ép scheme `https` cho mọi URL sinh ra (`URL::forceScheme('https')` trong `AppServiceProvider`), không cần đụng gì tới cấu hình proxy/Nginx bên ngoài. Mặc định `FORCE_HTTPS` bật theo `APP_ENV=production`, có thể override thủ công bằng `FORCE_HTTPS=false`/`true`.
  - **Lưu ý**: KHÔNG bật `FORCE_HTTPS=true` (hoặc `APP_ENV=production`) trên môi trường dev local không có HTTPS thật ở tầng ngoài — trình duyệt sẽ cố tải asset qua `https://` trên cổng không có TLS và load lỗi. Tính năng này chỉ dùng cho VPS production có HTTPS thật ở tầng ngoài (aaPanel/Nginx làm SSL termination).
