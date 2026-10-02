# HLS R2 Studio

Ứng dụng quản lý video nội bộ: upload video → băm sang HLS bằng FFmpeg → lưu trên Cloudflare R2 → phát qua HLS.js. Có dashboard, nhật ký upload, trang cài đặt và tính năng nhận báo lỗi phát video từ người xem.

## Mục lục

- [Chức năng chính](#chức-năng-chính)
- [Cách cài đặt](#cách-cài-đặt)
  - [Cài đặt trên VPS thuần (không qua panel)](#cài-đặt-trên-vps-thuần-không-qua-panel)
    - [Cập nhật / deploy lại khi có code mới (VPS thuần)](#cập-nhật--deploy-lại-khi-có-code-mới-vps-thuần)
  - [Deploy qua aaPanel](#deploy-qua-aapanel)
    - [Cập nhật / deploy lại khi có code mới (aaPanel)](#cập-nhật--deploy-lại-khi-có-code-mới-aapanel)
- [Cấu trúc dữ liệu](#cấu-trúc-dữ-liệu)
- [Một số tình huống gặp lỗi, cách xử lý, Q&A](#một-số-tình-huống-gặp-lỗi-cách-xử-lý-qa)

## Chức năng chính

- Đăng nhập admin
- Upload video (đơn lẻ/nhiều file, hỗ trợ file lớn qua chunk-upload)
- Băm HLS bằng FFmpeg, tuỳ chỉnh chất lượng (480/720/1080p), độ dài segment, FPS
- Lưu lên Cloudflare R2, phát bằng HLS.js
- Dashboard tổng quan (CPU/RAM/Disk server + thống kê video)
- Trang Nhật ký (lịch sử upload) và tiến độ transcode theo thời gian thực (qua Reverb/WebSocket)
- Trang Cài đặt (đổi mật khẩu, cấu hình R2 động, tuỳ chọn xử lý, số video/trang, múi giờ hiển thị)
- Danh sách video dạng bảng, phân trang, xoá hàng loạt, hiển thị thông số kỹ thuật (độ phân giải, fps, codec, bitrate, dung lượng)
- Chạy nhiều worker song song để băm nhiều video cùng lúc
- Nhận báo lỗi phát video (Report) từ trang public qua API, admin xem/đánh dấu đã xử lý

**Lưu ý**: URL public của video phụ thuộc vào việc bạn tự cấu hình bucket R2 public (custom domain hoặc `r2.dev` URL) trên Cloudflare dashboard rồi điền vào `R2_URL` (hoặc trường `r2_url` trong trang Cài đặt). Code không tự động public hoá bucket.

Tính năng Report: trang phát video công khai (kể cả đặt ở domain khác) gửi lỗi về `POST /api/reports`. Muốn cho domain khác gọi API này, thêm domain đó vào `allowed_origins` trong `config/cors.php`.

## Cách cài đặt

> **VPS của bạn đã có sẵn panel quản lý (aaPanel, cPanel, Plesk...) chưa?**
> - **Đã có aaPanel** → làm theo mục [Deploy qua aaPanel](#deploy-qua-aapanel) — đơn giản hơn, không cần tự cài Nginx/PHP-FPM thủ công.
> - **VPS "trắng", chưa cài gì** → làm theo mục [Cài đặt trên VPS thuần](#cài-đặt-trên-vps-thuần-không-qua-panel) ngay bên dưới.

### Cài đặt trên VPS thuần (không qua panel)

**Yêu cầu**: PHP 8.4+ (bắt buộc — `composer.lock` khoá một số gói Symfony cần PHP >= 8.4), Composer 2.2+ (`composer self-update` nếu báo lỗi `composer-runtime-api`), Node.js + npm, MySQL, FFmpeg/FFprobe, tài khoản Cloudflare R2.

**1. Cài dependencies**

```bash
composer install
npm install && npm run build
cp .env.example .env
php artisan key:generate
```

**2. Cấu hình `.env`** — mỗi key một dòng riêng, không gộp chung:

```env
# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user MySQL>
DB_PASSWORD=<password MySQL>

# Cloudflare R2
R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<tên bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<URL public phát video, vd https://cdn.your-domain.com hoặc URL r2.dev>

# Domain/HTTPS (bắt buộc đổi khi lên production)
APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-thật-của-bạn

# WebSocket (Reverb) — sinh giá trị ngẫu nhiên thật cho 3 dòng dưới, không để trống
REVERB_APP_ID=<số ngẫu nhiên>
REVERB_APP_KEY=<chuỗi ngẫu nhiên>
REVERB_APP_SECRET=<chuỗi ngẫu nhiên>
REVERB_HOST=domain-thật-của-bạn
REVERB_PORT=443
REVERB_SCHEME=https
```

> Sinh 3 giá trị trên bằng 1 trong 2 cách:
> ```bash
> php artisan tinker --execute="echo Str::random(20);"   # REVERB_APP_KEY
> php artisan tinker --execute="echo Str::random(32);"   # REVERB_APP_SECRET
> php artisan tinker --execute="echo random_int(100000, 999999);"   # REVERB_APP_ID
> ```
> hoặc không cần `tinker`:
> ```bash
> openssl rand -hex 10   # REVERB_APP_ID
> openssl rand -hex 20   # REVERB_APP_KEY
> openssl rand -hex 32   # REVERB_APP_SECRET
> ```
> Không cần đăng ký ở đâu — chỉ cần 3 giá trị khác nhau và đủ ngẫu nhiên để client/server Reverb bắt tay với nhau.

> Chỉ cần điền `FFMPEG_BINARY`/`FFPROBE_BINARY` nếu `which ffmpeg`/`which ffprobe` không trả về gì (không có sẵn trong `$PATH`).

**3. Tạo database và khởi tạo**

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
php artisan migrate
php artisan admin:create admin --email=admin@example.com
```
> Lệnh `admin:create` sẽ hỏi password (ẩn ký tự khi gõ, tối thiểu 8 ký tự) — không nên truyền password trực tiếp trên dòng lệnh. Lệnh này upsert theo `username`: chạy lại cùng username sẽ đổi mật khẩu tài khoản đó thay vì tạo trùng.

**4. Chạy thử (dev)** — cần **4 tiến trình song song**:

```bash
php artisan serve          # web server (terminal 1)
php artisan queue:work     # bắt buộc — thiếu thì video không bao giờ được transcode (terminal 2)
php artisan schedule:work  # dọn rác tự động hàng ngày, thiếu vẫn chạy được, chỉ là rác không tự dọn (terminal 3)
php artisan reverb:start   # hiển thị tiến độ transcode live, thiếu vẫn chạy được, chỉ là phải tự reload để xem tiến độ (terminal 4)
```

Truy cập `http://localhost:8000/login`.

**5. Chạy production thật (thay `php artisan serve` bằng Nginx + PHP-FPM + systemd)**

Cài Nginx + PHP-FPM (đổi `php8.2-fpm` theo đúng version PHP đã cài, kiểm tra bằng `php -v`):

```bash
sudo apt install -y nginx php8.2-fpm
sudo chown -R www-data:www-data storage bootstrap/cache
sudo chmod -R 775 storage bootstrap/cache
```

Tạo `/etc/nginx/sites-available/hls-r2-studio`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /path/to/hls-r2-studio/public;
    index index.php;

    client_max_body_size 2048m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300s;
    }

    location ~ /\.(?!well-known).* {
        deny all;
    }

    # Reverb cần proxy CẢ HAI path: /app/ (WebSocket từ client) và /apps/
    # (REST request server dùng để publish event). Thiếu /apps/ làm broadcast
    # âm thầm thất bại dù WebSocket trông vẫn kết nối bình thường.
    location /app/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 60s;
    }

    location /apps/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> `REVERB_SERVER_HOST=127.0.0.1`/`REVERB_SERVER_PORT=8080` giữ nguyên trong `.env` (Reverb chỉ bind local, không expose trực tiếp); `REVERB_HOST`/`PORT`/`SCHEME` đặt domain/443/https thật như ở bước 2.

Tăng giới hạn upload trong `/etc/php/8.2/fpm/php.ini` (khớp `UPLOAD_MAX_SIZE_MB=2048`):

```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
```

```bash
sudo systemctl restart php8.2-fpm
sudo ufw allow 80/tcp
```

**Chạy 3 tiến trình nền bằng systemd** (thay cho 3 terminal thủ công ở bước 4 — `serve` vẫn thay bằng Nginx/PHP-FPM ở trên):

Queue worker — `/etc/systemd/system/hls-r2-studio-queue@.service` (template, chạy được nhiều instance):

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

```bash
sudo systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
```

> `DB_QUEUE_RETRY_AFTER` trong `.env` (mặc định `176400`) **phải luôn lớn hơn** `--timeout` ở trên (`172800`) — nếu không, worker khác sẽ nhận lại job đang chạy dở, gây xử lý trùng.

Reverb (WebSocket) — `/etc/systemd/system/hls-r2-studio-reverb.service` (1 instance duy nhất, không dùng template):

```ini
[Unit]
Description=HLS R2 Studio Reverb (WebSocket)
After=network.target

[Service]
User=www-data
WorkingDirectory=/path/to/hls-r2-studio
ExecStart=/usr/bin/php artisan reverb:start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hls-r2-studio-reverb
```

Scheduler (dọn rác hàng ngày) — `/etc/systemd/system/hls-r2-studio-scheduler.service` (1 instance duy nhất):

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

```bash
sudo systemctl enable --now hls-r2-studio-scheduler
```

Kiểm tra bất kỳ service nào: `sudo systemctl status <tên-service>`, xem log: `sudo journalctl -u <tên-service> -f`.

Domain/SSL, cập nhật CORS R2 cho domain thật, và backup định kỳ vẫn cần tự làm thêm.

#### Cập nhật / deploy lại khi có code mới (VPS thuần)

```bash
cd /path-to-project
git pull
```

| Lệnh | Chỉ cần chạy khi nào |
|---|---|
| `composer install --no-dev` | `composer.json`/`composer.lock` thay đổi |
| `npm install` | `package.json`/`package-lock.json` thay đổi |
| `npm run build` | Có sửa `resources/css`, `resources/js`, hoặc `.blade.php` |
| `php artisan migrate --force` | Có migration mới trong `database/migrations/` |
| `php artisan config:clear` | Đổi file `config/*.php` hoặc thêm biến mới vào `.env` |
| Restart queue worker (`sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`) | Sửa `app/Jobs/TranscodeVideoJob.php` hoặc code xử lý hàng đợi |
| Restart Reverb (`sudo systemctl restart hls-r2-studio-reverb`) | Sửa `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` |
| Restart scheduler | Gần như không bao giờ cần, trừ khi sửa `routes/console.php` hoặc lệnh cleanup trong `app/Console/Commands/` |

Không chắc có cần lệnh nào không thì cứ chạy hết — không hại gì.

### Deploy qua aaPanel

aaPanel tự quản lý Nginx + PHP-FPM + SSL — không tự `apt install nginx`/tự tạo cấu hình Nginx như phần VPS thuần ở trên (sẽ xung đột với Nginx của aaPanel).

**1. Đưa code lên VPS** — clone vào thư mục tạm rồi đổi tên (tránh lỗi `destination path '.' already exists` do aaPanel hay tự sinh sẵn vài file ẩn trong thư mục site trống):

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf ten-domain.com
mv hls-temp ten-domain.com
cd ten-domain.com
```

**2. Cài đúng version PHP** — project cần PHP `^8.4`. Nếu chưa có: aaPanel → **App Store** → tab **PHP** → cài **PHP-8.4** (cài song song được, không cần gỡ bản cũ). Từ đây dùng full path để chắc chắn gọi đúng bản:

```bash
/www/server/php/84/bin/php -v
```
(nếu khác, tìm đúng số thư mục version bằng `ls /www/server/php/`)

**3. Bật extension PHP bắt buộc** — aaPanel → **PHP** → **8.4** → **Install extensions**, bật: `fileinfo` (bắt buộc, thiếu sẽ làm `composer install` lỗi ngay), `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath` → **Restart** PHP 8.4.

**4. Cập nhật Composer** (bản có sẵn trên nhiều VPS quá cũ, không chạy được Laravel 13):

```bash
/www/server/php/84/bin/php /usr/bin/composer self-update
```

**5. Cài Node.js + FFmpeg** (nếu chưa có):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs ffmpeg
```

**6. Cài dependencies + build asset**

```bash
/www/server/php/84/bin/php /usr/bin/composer install --no-dev
npm install && npm run build
```

**7. Tạo database** — aaPanel → **Database** → **Add database** → đặt tên + tạo user/password mới, ghi nhớ lại để điền `.env`.

**8. Cấu hình `.env`**

```bash
cp .env.example .env
nano .env
```

Điền (mỗi key một dòng riêng):

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user vừa tạo>
DB_PASSWORD=<password vừa tạo>

R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<tên bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<URL public phát video>

APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-thật-của-bạn
FORCE_HTTPS=true

REVERB_APP_ID=<số ngẫu nhiên>
REVERB_APP_KEY=<chuỗi ngẫu nhiên>
REVERB_APP_SECRET=<chuỗi ngẫu nhiên>
REVERB_HOST=domain-thật-của-bạn
REVERB_PORT=443
REVERB_SCHEME=https
```

> Sinh 3 giá trị trên bằng 1 trong 2 cách:
> ```bash
> /www/server/php/84/bin/php artisan tinker --execute="echo Str::random(20);"   # REVERB_APP_KEY
> /www/server/php/84/bin/php artisan tinker --execute="echo Str::random(32);"   # REVERB_APP_SECRET
> /www/server/php/84/bin/php artisan tinker --execute="echo random_int(100000, 999999);"   # REVERB_APP_ID
> ```
> hoặc không cần `tinker`:
> ```bash
> openssl rand -hex 10   # REVERB_APP_ID
> openssl rand -hex 20   # REVERB_APP_KEY
> openssl rand -hex 32   # REVERB_APP_SECRET
> ```
> Không cần đăng ký ở đâu — chỉ cần 3 giá trị khác nhau và đủ ngẫu nhiên để client/server Reverb bắt tay với nhau.

**9. Sinh key, tạo bảng, tạo admin**

```bash
/www/server/php/84/bin/php artisan key:generate
/www/server/php/84/bin/php artisan migrate --force
/www/server/php/84/bin/php artisan admin:create admin --email=admin@example.com
```

**10. Set quyền thư mục** (`www` là user PHP-FPM mặc định của aaPanel — kiểm tra bằng `ps aux | grep php-fpm` nếu VPS dùng user khác):

```bash
chown -R www:www storage bootstrap/cache
chmod -R 775 storage bootstrap/cache
```

**11. Tạo website trong aaPanel** — tab **Website** → **Add site** → điền domain → chọn **PHP 8.4** → **Document Root** đặt thành `.../public` (không phải thư mục gốc project). Nếu site đã có sẵn trước khi clone, vào site → **Directory** → xác nhận **Site directory** trỏ đúng `.../public`.

**12. Tắt "Anti-XSS attack" (open_basedir)** — site → **Directory** → tắt toggle **Anti-XSS attack**. Bật toggle này sẽ giới hạn PHP chỉ đọc được `public/`, gây trang trắng kèm lỗi `open_basedir restriction in effect` vì code Laravel thật (`vendor/`, `storage/`...) nằm ở thư mục cha.

**13. Bật URL rewrite** (thiếu bước này mọi trang ngoài trang chủ sẽ báo `404`) — site → **URL rewrite** (伪静态) → chọn template **Laravel5**/**Laravel**. Nếu không có sẵn, chọn **Custom** và dán:

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

**14. Tăng giới hạn upload** — aaPanel → **PHP** → **8.4** → **Configuration file**:

```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
memory_limit = 512M
```

**15. Bật SSL** — site → tab **SSL** → **Let's Encrypt** → tick domain → **Apply** (tự xin và tự gia hạn).

**16. Chạy queue worker bằng systemd** (bắt buộc — aaPanel KHÔNG tự quản lý việc này):

```bash
nano /etc/systemd/system/hls-r2-studio-queue@.service
```

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

```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-queue@1
systemctl enable --now hls-r2-studio-queue@2
```

> `--timeout=172800` (48 tiếng) khớp với timeout job thật trong code (hệ số x8 theo độ dài video, xem `TRANSCODE_TIMEOUT_MULTIPLIER` ở phần Q&A). `DB_QUEUE_RETRY_AFTER` trong `.env` (`176400`) phải luôn lớn hơn giá trị này.

**17. Chạy Reverb (WebSocket) bằng systemd**:

```bash
nano /etc/systemd/system/hls-r2-studio-reverb.service
```

```ini
[Unit]
Description=HLS R2 Studio Reverb (WebSocket)
After=network.target

[Service]
User=www
WorkingDirectory=/www/wwwroot/ten-domain.com
ExecStart=/www/server/php/84/bin/php artisan reverb:start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-reverb
```

Mở site → tab **Config File** (配置文件) → thêm vào bên trong `server { }` đã có sẵn (giống hệt block ở phần VPS thuần) — Reverb cần proxy CẢ `/app/` (WebSocket) và `/apps/` (REST publish event), thiếu `/apps/` làm broadcast âm thầm thất bại dù WebSocket vẫn trông như kết nối bình thường:

```nginx
location /app/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 60s;
}

location /apps/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
}
```

Lưu lại — aaPanel tự reload Nginx, tận dụng luôn chứng chỉ SSL đã bật ở bước 15.

**18. Chạy scheduler bằng systemd** (1 instance, không dùng template `@`):

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

```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-scheduler
```

**19. Kiểm tra** — mở `https://domain-thật/login`, đăng nhập bằng tài khoản admin vừa tạo, thử upload 1 video ngắn để xác nhận pipeline chạy hoàn chỉnh (upload → transcode → upload R2 → phát HLS).

#### Cập nhật / deploy lại khi có code mới (aaPanel)

```bash
cd /www/wwwroot/ten-domain.com
git pull
```

| Lệnh | Chỉ cần chạy khi nào |
|---|---|
| `/www/server/php/84/bin/php /usr/bin/composer install --no-dev` | `composer.json`/`composer.lock` thay đổi |
| `npm install` | `package.json`/`package-lock.json` thay đổi |
| `npm run build` | Có sửa `resources/css`, `resources/js`, hoặc `.blade.php` |
| `/www/server/php/84/bin/php artisan migrate --force` | Có migration mới trong `database/migrations/` |
| `/www/server/php/84/bin/php artisan config:clear` | Đổi file `config/*.php` hoặc thêm biến mới vào `.env` |
| Restart queue worker (`systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`) | Sửa `app/Jobs/TranscodeVideoJob.php` hoặc code xử lý hàng đợi |
| Restart Reverb (`systemctl restart hls-r2-studio-reverb`) | Sửa `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` |
| Restart scheduler | Gần như không bao giờ cần, trừ khi sửa `routes/console.php` hoặc lệnh cleanup |

Không chắc có cần lệnh nào không thì cứ chạy hết — không hại gì.

## Cấu trúc dữ liệu

**`videos`** — mỗi dòng là 1 video: tiêu đề, tên/dung lượng file gốc, trạng thái xử lý (`status`: pending/processing/ready/failed, `stage`: queued/transcoding/uploading_r2/ready/failed, `progress` %), đường dẫn tới file HLS/thumbnail/storyboard trên R2, thông số kỹ thuật video output thật (độ phân giải, fps, bitrate, codec, thời lượng), và lỗi nếu xử lý thất bại.

**`settings`** — bảng cấu hình, luôn chỉ có 1 dòng duy nhất (`id = 1`, lấy qua `Setting::current()`): thông tin R2 (có thể override biến `.env`), có xoá file trên R2 khi xoá video không, cấu hình transcode mặc định (độ phân giải/segment/fps), số video hiển thị mỗi trang, múi giờ hiển thị.

**`users`** — tài khoản đăng nhập admin (username + password), theo cơ chế Auth chuẩn của Laravel.

**`reports`** — báo lỗi phát video gửi từ trang public: URL trang đang phát, ghi chú người báo, IP, trạng thái (`new`/`resolved`), số lần bị báo trùng cùng URL (`report_count`), thời điểm báo gần nhất và thời điểm admin xử lý xong.

## Một số tình huống gặp lỗi, cách xử lý, Q&A

| Lỗi gặp phải | Nguyên nhân | Cách fix |
|---|---|---|
| `destination path '.' already exists` khi `git clone` (aaPanel) | Thư mục site có file ẩn aaPanel tự sinh mà `ls` không hiện | Clone vào thư mục tạm rồi `mv` đè lên |
| `composer install` báo `ext-fileinfo` thiếu | Extension `fileinfo` chưa bật cho bản PHP đang dùng | Bật qua aaPanel → PHP → Install extensions (hoặc cài extension tương ứng trên VPS thuần) |
| `composer install` báo gói Symfony yêu cầu PHP >= 8.4 | Đang chạy PHP < 8.4 nhưng `composer.lock` khoá bản cần 8.4 | Cài/nâng cấp PHP lên 8.4 |
| `composer install` báo `composer-runtime-api` không khớp | Bản Composer cài sẵn quá cũ (< 2.2) | `composer self-update` |
| Trang trắng, lỗi `open_basedir restriction in effect` (aaPanel) | Toggle "Anti-XSS attack" đang bật, giới hạn PHP chỉ đọc được `public/` | Tắt toggle này ở site → Directory |
| `404 Not Found` khi vào `/login` (trang chủ `/` vẫn vào được) | Thiếu rule rewrite URL đẹp cho Laravel | Bật URL rewrite template Laravel (aaPanel) hoặc kiểm tra lại `try_files` trong Nginx config (VPS thuần) |
| Video kẹt "Đang xử lý" mãi không xong, log có `Job timed out` | Queue worker thiếu cờ `--timeout`, Laravel tự kill job sau 60s mặc định | Thêm `--timeout=172800` vào `ExecStart` của systemd unit |
| Console báo `You must pass your app key when you instantiate Pusher` | Thiếu `REVERB_*`/`VITE_REVERB_*` trong `.env` lúc `npm run build`, hoặc chưa cấu hình Reverb | Điền đủ biến, `npm run build` lại, đảm bảo Reverb đang chạy |
| WebSocket kết nối được nhưng tiến độ transcode không bao giờ cập nhật live; dispatch event qua tinker báo `Pusher error: 404 Not Found` | Thiếu `location /apps/` trong cấu hình reverse-proxy Reverb | Thêm `location /apps/` proxy sang cùng port Reverb |
| `systemctl restart nginx`/`php-fpm-84` báo lỗi nhưng service vẫn chạy (aaPanel) | Script khởi động kiểu LSB xử lý sai "restart" khi service đã chạy | Dùng `/etc/init.d/nginx reload` và `/etc/init.d/php-fpm-84 restart` thay vì `systemctl restart` |

**Q: Quên mật khẩu admin thì sao?**
Chạy lại `php artisan admin:create <username>` (hoặc full path PHP 8.4 nếu dùng aaPanel) — lệnh này upsert theo `username`, chạy lại cùng username sẽ đổi mật khẩu tài khoản đó thay vì báo lỗi trùng.

**Q: Video bị kẹt xử lý mãi không xong?**
Kiểm tra queue worker còn chạy không (`systemctl status hls-r2-studio-queue@1` hoặc xem terminal đang chạy `queue:work`) và xem log lỗi (`journalctl -u hls-r2-studio-queue@1 -f`). Nếu log có `Job timed out`, xem dòng troubleshooting tương ứng ở trên.

**Q: Làm sao cho trang phát video ở domain khác gửi được report?**
Thêm domain đó vào `allowed_origins` trong `config/cors.php` (mặc định chỉ cho phép domain khai báo sẵn trong file này). Route `/api/reports` có rate limit 5 lần/10 giây.

**Q: Đổi giới hạn upload ở đâu?**
Phải đổi đồng thời 3 nơi: `UPLOAD_MAX_SIZE_MB` trong `.env`, `upload_max_filesize`/`post_max_size` trong `php.ini`, và `client_max_body_size` trong Nginx — đổi 1 nơi mà thiếu 2 nơi còn lại vẫn sẽ bị chặn.

**Q: Các tuỳ chỉnh nâng cao khác?**
Không bắt buộc, có giá trị mặc định hợp lý, thêm vào `.env` nếu muốn đổi:
```env
UPLOAD_ABANDONED_TTL_HOURS=24       # dọn upload chunk bỏ dở sau bao lâu
TRANSCODE_ORPHANED_TTL_HOURS=48     # dọn thư mục tạm băm HLS bị crash treo sau bao lâu
UPLOAD_ORPHANED_TTL_HOURS=72        # dọn file video gốc mồ côi sau bao lâu
TRANSCODE_TIMEOUT_MULTIPLIER=8      # hệ số nhân với độ dài video để tính timeout băm HLS
STORYBOARD_TILE_SIZE=160            # kích thước (px) mỗi ô trong ảnh lưới storyboard
DB_QUEUE_RETRY_AFTER=176400         # phải lớn hơn --timeout của queue worker
```

**Q: App chạy sau reverse proxy HTTPS (aaPanel/Nginx/Cloudflare Tunnel) nhưng link asset ra `http://` (mixed content)?**
Set `APP_ENV=production` (thường đã có sẵn ở production) hoặc `FORCE_HTTPS=true` trong `.env` — Laravel sẽ tự ép `https` cho mọi URL sinh ra. Không bật tuỳ chọn này trên môi trường dev local không có HTTPS thật, trình duyệt sẽ load lỗi asset.

**Q: Rate limit mặc định của các API là bao nhiêu?**
Đăng nhập: 5 lần/phút. `/uploads/init`: 30 lần/phút. `/uploads/{id}/chunk`: 120 lần/phút. `/api/reports`: 5 lần/10 giây. Gặp lỗi "Too Many Requests" khi thao tác quá nhanh là do các giới hạn này.
