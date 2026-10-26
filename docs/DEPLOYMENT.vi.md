> [English](DEPLOYMENT.md) | Tiếng Việt

# Hướng dẫn Deploy

> Quay lại [README](../README.vi.md). Phần phát triển local nằm trong README; lỗi, Q&A và cấu trúc dữ liệu nằm trong [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md).

Hướng dẫn này đưa một VPS mới tinh thành một bản cài đặt đang chạy thật phía sau Cloudflare, theo đúng thứ tự. Hành vi của ứng dụng lấy từ repo này; các bước hạ tầng (apt, Nginx, giao diện aaPanel, dashboard Cloudflare) phụ thuộc vào môi trường, và mọi nội dung chưa được kiểm chứng với repo hoặc tài liệu chính thức đều được đánh dấu `(verify)`. Nhãn giao diện thay đổi giữa các phiên bản aaPanel và Cloudflare. Dấu `(verify)` nghĩa là "chưa được kiểm chứng với repo hoặc tài liệu chính thức, cần đối chiếu trên môi trường thật".

**Placeholder** (dùng xuyên suốt bên dưới):

| Placeholder | Ý nghĩa | VPS thuần | aaPanel |
|---|---|---|---|
| `embed.example.com` | Domain của app và embed (server này) | giống nhau | giống nhau |
| `cdn.example.com` | Custom domain public của R2 (= `R2_URL`) | giống nhau | giống nhau |
| `www.example.com` | Website WordPress nhúng player | giống nhau | giống nhau |
| `<APP_DIR>` | Thư mục project | `/var/www/hls-r2-studio` | `/www/wwwroot/embed.example.com` |
| `<PHP>` | PHP CLI dùng để chạy `artisan` và `composer` | `php` | `/www/server/php/84/bin/php` |
| `<USER>` | User chạy dịch vụ (PHP-FPM, queue, Reverb, scheduler) | `www-data` | `www` |
| `<git-repo-url>` | URL repository của bạn | giống nhau | giống nhau |

Hãy mở root shell trước (`sudo -i`); mọi lệnh trong hướng dẫn này đều giả định chạy bằng root (tiền tố `sudo` không gây hại khi đã là root). Trường hợp dùng deploy user không phải root (sở hữu `<APP_DIR>`) không được đề cập ở đây.

## Chọn hướng deploy

| Server của bạn | Dùng |
|---|---|
| Đã chạy aaPanel | **Hướng A: aaPanel**. Không bao giờ dùng hướng VPS thuần trên cùng server đó. |
| VPS sạch, chưa cài gì (Ubuntu/Debian) | **Hướng B: VPS thuần** |

Vì sao không trộn hai hướng:

- aaPanel đã quản lý Nginx (cổng 80/443), PHP (`/www/server/php/84`, `php.ini` riêng, extension riêng và FPM user `www`), MySQL (3306), Redis (App Store), SSL, firewall và cấu hình website.
- `apt install nginx php8.4-fpm` trên server aaPanel sẽ tạo ra một Nginx thứ hai tranh cổng 80/443 cùng một PHP CLI và `php.ini` khác. `ufw` xung đột với firewall của panel. aaPanel tạo lại hoặc bỏ qua các file `/etc/nginx` sửa tay (verify).
- Chiều ngược lại cũng đúng: cài aaPanel lên server đã cấu hình tay sẽ ghi đè cấu hình Nginx/PHP của server đó (verify).

aaPanel quản lý những gì (Hướng A): Nginx, phiên bản/extension/`php.ini` của PHP, MySQL/MariaDB, Redis, site/SSL/rewrite, firewall, cron, file manager.
aaPanel **không** quản lý những gì cho app này: queue worker, Reverb, scheduler (dùng systemd unit, mục 10), Node.js, FFmpeg, cập nhật Composer, `.env` của app, Cloudflare/R2.

## Go-live runbook (theo thứ tự)

| # | Bước | Mục |
|---|---|---|
| 0 | Tài khoản: domain trên Cloudflare, chọn cấu hình VPS, R2 bucket + token + custom domain, Origin certificate, các domain WordPress | [0](#0-chuẩn-bị-và-tài-khoản) |
| 1 | Phần mềm trên server: PHP 8.4, Composer, Node 22, FFmpeg, Nginx (VPS thuần) | [1](#1-phần-mềm-trên-server) |
| 2 | Database: MySQL/MariaDB, user riêng | [2](#2-database) |
| 3 | Redis (cache và rate limiting) | [3](#3-redis) |
| 4 | Lấy code, `composer install` | [4](#4-lấy-code-và-cài-php-dependencies) |
| 5 | Tạo và điền đầy đủ `.env` | [5](#5-cấu-hình-env) |
| 6 | `key:generate`, `migrate --force`, `admin:create` | [6](#6-app-key-tạo-bảng-database-tạo-admin) |
| 7 | `npm ci`, `npm run build` (sau khi xong `.env`!) | [7](#7-build-frontend-assets) |
| 8 | Quyền file (sau mỗi lệnh artisan chạy bằng root) | [8](#8-quyền-thư-mục) |
| 9 | Web server, giới hạn upload, Origin certificate (SSL) | [9](#9-web-server-và-ssl) |
| 10 | Dịch vụ chạy nền: queue, Reverb, scheduler | [10](#10-dịch-vụ-chạy-nền) |
| 11 | Cloudflare: DNS proxied, WebSockets, SSL Full (strict), các rule | [11](#11-cấu-hình-cloudflare) |
| 12 | App Settings (embed allowlist), smoke test, dọn index Google | [12](#12-cài-đặt-trong-app-smoke-test-dọn-index-google) |

Sau go-live: [Cập nhật](#cập-nhật--deploy-lại-khi-có-code-mới), [Vận hành](#vận-hành), [Các lỗi thường gặp khi deploy](#các-lỗi-thường-gặp-khi-deploy).

## 0. Chuẩn bị và tài khoản

**Cấu hình VPS**

| | CPU / RAM | Ổ đĩa |
|---|---|---|
| Tối thiểu | 2 vCPU / 4 GB | khoảng 2x dung lượng video lớn nhất nhân với số lượt upload đồng thời, cộng thêm OS |
| Khuyến nghị | 4 vCPU / 8 GB | cùng quy tắc |

App từ chối upload khi dung lượng đĩa trống thấp hơn 2x kích thước file + 256 MB. Hãy đặt region của VPS và location hint của R2 bucket gần nhau và gần đối tượng người xem của bạn.

**Cloudflare và R2** (nhãn trên dashboard `(verify)`)

1. Thêm domain vào Cloudflare. Tạo DNS record: `A` `embed.example.com` → IP của VPS, **Proxied** (đám mây màu cam). Giữ nguyên chế độ SSL/TLS cho đến bước 11.
2. R2 → tạo bucket. Kết nối custom domain `cdn.example.com` với bucket đó (Settings → Custom Domains). `R2_URL` phải là custom domain này, không bao giờ dùng `r2.dev` (bị rate limit, không dành cho production).
3. R2 → Manage API tokens → tạo token **Object Read & Write** giới hạn cho bucket này. Ghi lại Access Key ID, Secret Access Key và S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. SSL/TLS → Origin Server → Create Certificate: **RSA**, hostname `embed.example.com`, thời hạn 15 năm. Copy certificate và private key ngay bây giờ (key chỉ hiển thị một lần); cài đặt chúng ở bước 9.
5. Xác định origin WordPress của bạn, ví dụ `https://www.example.com` (cần cho `CORS_ALLOWED_ORIGINS`, `REPORT_ALLOWED_HOSTS` và embed allowlist).

Không bao giờ dán key, token, nội dung `.env` hoặc private key vào ticket hay chat.

## 1. Phần mềm trên server

Hãy mở root shell trước (`sudo -i`); mọi lệnh trong hướng dẫn này đều giả định chạy bằng root (tiền tố `sudo` không gây hại khi đã là root). Trường hợp dùng deploy user không phải root (sở hữu `<APP_DIR>`) không được đề cập ở đây.

### Hướng A: aaPanel

1. PHP: App Store → PHP → cài **PHP-8.4** (song song với các phiên bản khác). Kiểm tra:
   ```bash
   /www/server/php/84/bin/php -v
   ```
   Nếu khác, tìm thư mục bằng `ls /www/server/php/`.
2. Extension: PHP → 8.4 → Install extensions → bật `fileinfo`, `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath`, `redis` (trang PHP, sau đó restart PHP 8.4). `pcntl` bắt buộc để `--timeout` của queue worker hoạt động. Kiểm tra:
   ```bash
   /www/server/php/84/bin/php -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
   ```
3. Composer (bản cài sẵn thường quá cũ so với Laravel 13):
   ```bash
   /www/server/php/84/bin/php /usr/bin/composer self-update
   ```
4. Node 22 LTS, FFmpeg, git (Debian/Ubuntu; với distro khác dùng gói tương đương của distro đó `(verify)`):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
   sudo apt install -y nodejs ffmpeg git unzip
   ```
5. Kiểm tra toàn bộ (xem phần "Kiểm tra" bên dưới).

### Hướng B: VPS thuần (server sạch)

PHP 8.4 không có trong repo mặc định của Ubuntu cho đến 24.04 (24.04 đi kèm 8.3). Hãy thêm PPA (Debian: dùng repository sury thay thế `(verify)`):

```bash
sudo apt update && sudo apt install -y software-properties-common git unzip curl
sudo add-apt-repository -y ppa:ondrej/php
sudo apt update
apt-cache policy php8.4-fpm
```

`apt-cache policy` phải hiển thị một candidate version `(verify)`. Sau đó:

```bash
sudo apt install -y php8.4-cli php8.4-fpm php8.4-mysql php8.4-mbstring php8.4-curl php8.4-xml php8.4-bcmath php8.4-redis
sudo apt install -y nginx ffmpeg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
```

`pcntl` và `fileinfo` đi kèm `php-cli` chuẩn của Debian/Ubuntu. Nếu `php -v` không phải 8.4, chạy `sudo update-alternatives --set php /usr/bin/php8.4` `(verify)`.

### Kiểm tra (cả hai hướng, dùng `<PHP>`)

```bash
<PHP> -v
<PHP> -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
node -v
ffmpeg -version
ffprobe -version
ffmpeg -encoders | grep libx264
```

- PHP phải là 8.4+ (`composer.json` yêu cầu `^8.4`); `pcntl`, `fileinfo`, `redis`, `pdo_mysql` phải có trong danh sách.
- Node phải thỏa `^20.19.0 || >=22.12.0` (engines của Vite 8 / laravel-vite-plugin 3); dùng Node 22 LTS. Quá trình build cũng cần internet đi ra ngoài (cấu hình Vite tải font Bunny).
- `libx264` phải xuất hiện trong danh sách encoder; `nice` (được dùng bởi `FFMPEG_NICE`) là lệnh chuẩn trên Linux.
- Composer 2.2+: `composer -V`.

## 2. Database

Yêu cầu: **MySQL 8.0.16+ hoặc MariaDB 10.6+** `(verify)`. Các migration dùng ràng buộc `CHECK` được thực thi thật, một cột `STORED` generated với `SHA2()`, và một prefix index; charset là utf8mb4. Dùng một user riêng với mật khẩu mạnh, chỉ giới hạn cho database này; không bao giờ đặt `root` vào `.env`.

### Hướng A: aaPanel

aaPanel → Database → Add database: tên `hls_r2_studio`, charset utf8mb4, tạo user và mật khẩu (access: local). Kiểm tra phiên bản engine trong panel (App Store → MySQL); nếu thấp hơn yêu cầu, hãy cài bản mới hơn `(verify)`.

### Hướng B: VPS thuần (server sạch)

Ubuntu 24.04 đi kèm MySQL 8.0 (`mysql-server`); Debian đi kèm MariaDB (`mariadb-server`) `(verify)`:

```bash
sudo apt install -y mysql-server
sudo mysql -e "SELECT VERSION();"
```

```bash
sudo mysql
```

```sql
CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hls_app'@'127.0.0.1' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON hls_r2_studio.* TO 'hls_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Mặc định MySQL chỉ lắng nghe trên localhost; không mở 3306 trên bất kỳ firewall nào.

## 3. Redis

Bộ đếm rate-limit, key dedup của Activity Log và lock của scheduler nằm trong Redis, tự hết hạn và không tạo thêm tải cho MySQL. Với `CACHE_STORE=failover`, app sẽ chuyển sang bảng cache trong database nếu Redis ngừng hoạt động. Session và queue vẫn nằm trên database.

### Hướng A: aaPanel

App Store → cài **Redis**; xác nhận nó lắng nghe trên `127.0.0.1` và tự khởi động cùng hệ thống `(verify)`. Nếu bạn đặt mật khẩu, hãy điền vào `REDIS_PASSWORD` trong `.env`. Extension PHP `redis` đã được bật ở mục 1.

### Hướng B: VPS thuần (server sạch)

```bash
sudo apt install -y redis-server
```

Trong `/etc/redis/redis.conf`, đảm bảo các dòng sau được đặt (`allkeys-lru` có thể xóa key khi thiếu bộ nhớ, điều này chấp nhận được với cache):

```conf
bind 127.0.0.1 ::1
maxmemory 256mb
maxmemory-policy allkeys-lru
```

```bash
sudo systemctl enable --now redis-server
redis-cli ping
```

Nó phải trả lời `PONG`. KHÔNG mở cổng 6379 trên bất kỳ firewall nào. Việc kiểm tra thông qua app nằm ở bước 6.

## 4. Lấy code và cài PHP dependencies

### Hướng A: aaPanel

Clone vào một thư mục tạm rồi di chuyển vào đúng chỗ (clone trực tiếp vào thư mục site do panel tạo sẽ lỗi `destination path '.' already exists` vì có các file ẩn). Lệnh `rm -rf` xóa thư mục đích, nên chỉ chạy khi thư mục đó chỉ chứa các file do panel sinh ra `(verify)`:

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf embed.example.com
mv hls-temp embed.example.com
cd embed.example.com
```

```bash
/www/server/php/84/bin/php /usr/bin/composer install --no-dev -o
```

### Hướng B: VPS thuần (server sạch)

```bash
sudo mkdir -p /var/www && cd /var/www
sudo git clone <git-repo-url> hls-r2-studio
cd hls-r2-studio
composer install --no-dev -o
```

## 5. Cấu hình `.env`

Các lệnh trong mục 4-8 chạy từ `<APP_DIR>`. Đây là nguồn sự thật duy nhất cho các giá trị production. **Điền đầy đủ trước bước 6 và bước 7.**

```bash
cp .env.example .env
nano .env
```

`.env.example` đi kèm các giá trị mặc định cho development (`APP_ENV=local`, `DB_HOST=mysql`, `FORCE_HTTPS=false`, `REVERB_HOST=localhost`, `REVERB_ALLOWED_ORIGINS=*`, `CORS_ALLOWED_ORIGINS=https://toicovl.com`, ...). Hãy đổi **mọi** key bên dưới, mỗi key một dòng. Để trống `APP_KEY` (bước 6) và giữ các key còn lại ở giá trị mặc định.

```env
# App
APP_ENV=production
APP_DEBUG=false
APP_URL=https://embed.example.com
FORCE_HTTPS=true
SESSION_SECURE_COOKIE=true
# Only Cloudflare IP ranges may set X-Forwarded-For (per-IP throttling depends on it)
TRUSTED_PROXIES=cloudflare

# Database (the dedicated user from section 2)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=hls_app
DB_PASSWORD=<strong-password>
# Must stay greater than the queue worker --timeout (172800)
DB_QUEUE_RETRY_AFTER=176400

# Redis cache, falls back to the database if Redis is down
CACHE_STORE=failover
REDIS_CLIENT=phpredis
# Only if Redis has a password: uncomment and set it
# REDIS_PASSWORD=<redis-password>

# Cloudflare R2
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=<bucket-name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=https://cdn.example.com

# Reverb (WebSocket): REVERB_HOST/PORT/SCHEME are the PUBLIC address the browser uses
REVERB_APP_ID=<generated>
REVERB_APP_KEY=<generated>
REVERB_APP_SECRET=<generated>
REVERB_HOST=embed.example.com
REVERB_PORT=443
REVERB_SCHEME=https
# Where reverb:start binds; Nginx proxies to it. Never expose it directly.
REVERB_SERVER_HOST=127.0.0.1
REVERB_SERVER_PORT=8080
# Hostname only, NOT a URL (Reverb compares the host part of the Origin header)
REVERB_ALLOWED_ORIGINS=embed.example.com

# Report API from the WordPress site: origins WITH scheme, hosts WITHOUT scheme
CORS_ALLOWED_ORIGINS=https://www.example.com
REPORT_ALLOWED_HOSTS=www.example.com,example.com

# Uploads are chunked: the chunk must stay <= ~90 MB (Cloudflare caps a request body at 100 MB on Free/Pro)
UPLOAD_MAX_SIZE_MB=2048
UPLOAD_CHUNK_SIZE_MB=8

# ffmpeg at low CPU priority; thread cap per job (about CPU cores / number of workers)
FFMPEG_NICE=10
FFMPEG_THREADS=2
```

**Cảnh báo:** với `CACHE_STORE=failover`, cấu hình Redis sai KHÔNG gây lỗi; app lặng lẽ dùng cache database. Luôn chạy bước kiểm tra Redis ở mục 6 và xác nhận các key xuất hiện.

Nếu bạn không chạy Redis, đặt `CACHE_STORE=database` và bỏ các dòng `REDIS_*`. Chỉ đặt `FFMPEG_BINARY`/`FFPROBE_BINARY` khi `which ffmpeg`/`which ffprobe` không trả về gì.

**Tạo các Reverb secret** (ba giá trị ngẫu nhiên khác nhau bất kỳ đều dùng được; không có gì được đăng ký ở đâu cả):

| Key | Lệnh |
|---|---|
| `REVERB_APP_ID` | `openssl rand -hex 10` |
| `REVERB_APP_KEY` | `openssl rand -hex 20` |
| `REVERB_APP_SECRET` | `openssl rand -hex 32` |

> **Mọi thay đổi sau này đối với giá trị `REVERB_*` đều yêu cầu chạy lại `npm run build`.** `resources/js/echo.js` nhúng `VITE_REVERB_*` (được mở rộng từ `${REVERB_*}`) vào JavaScript tại thời điểm build; bản build tạo với giá trị mặc định của `.env.example` sẽ gửi `localhost:8080` tới trình duyệt và live progress hỏng một cách âm thầm.

Mỗi lần sửa `.env`: chạy `<PHP> artisan config:clear`, rồi restart các dịch vụ (mục 10), vì chúng giữ config trong bộ nhớ.

## 6. App key, tạo bảng database, tạo admin

```bash
<PHP> artisan key:generate
<PHP> artisan migrate --force
<PHP> artisan admin:create admin --email=admin@example.com
```

- `--force` là bắt buộc: với `APP_ENV=production`, `migrate` thông thường từ chối chạy ở chế độ không tương tác.
- `admin:create` hỏi mật khẩu ẩn (tối thiểu 8 ký tự); không truyền mật khẩu trên command line. Lệnh này upsert theo username: chạy lại với cùng username sẽ đặt lại mật khẩu của tài khoản đó.
- Kiểm tra Redis (bỏ qua nếu `CACHE_STORE=database`):
  ```bash
  <PHP> artisan tinker --execute="Cache::put('ping','pong',60); echo Cache::get('ping');"
  redis-cli -n 1 keys '*'
  ```
  Lệnh đầu in ra `pong`; lệnh thứ hai liệt kê các key (`REDIS_CACHE_DB` mặc định là 1). Nếu `redis-cli -n 1 keys '*'` không in ra gì, app KHÔNG dùng Redis (đã chuyển sang database): kiểm tra `REDIS_*`, extension PHP `redis` và `redis-cli ping`. Bước kiểm tra tinker này khi chạy bằng root có thể tạo file thuộc root trong `storage/`; mục 8 sửa lại quyền sở hữu (hoặc chạy nó bằng `<USER>`).

## 7. Build frontend assets

Chỉ sau khi `.env` đã hoàn chỉnh (xem cảnh báo ở mục 5):

```bash
npm ci
npm run build
```

`npm ci` dùng `package-lock.json`. Cần Node 22 và internet đi ra ngoài.

## 8. Quyền thư mục

Các lệnh artisan chạy bằng root (`migrate`, `admin:create`, `config:clear`, ...) có thể tạo file thuộc root trong `storage/` (ví dụ log hằng ngày) mà PHP-FPM và các systemd service không ghi được, dẫn đến HTTP 500. Vì vậy hãy kết thúc mọi lần cài đặt và mọi lần cập nhật bằng bước này, **sau khi** chạy xong mọi lệnh artisan bằng root:

```bash
sudo chown -R <USER>:<USER> storage bootstrap/cache
sudo chmod -R 775 storage bootstrap/cache
sudo chown root:<USER> .env
sudo chmod 640 .env
```

Các service chạy bằng `www-data` (VPS thuần) hoặc `www` (aaPanel); nếu không chắc, kiểm tra user PHP-FPM thực tế bằng `ps aux | grep php-fpm`.

## 9. Web server và SSL

Hãy cài **Cloudflare Origin certificate lên origin trước**, và chỉ sau đó mới chuyển Cloudflare sang Full (strict) (bước 11); thứ tự ngược lại gây lỗi 521/526. Giới hạn upload (cả hai hướng): upload được chia chunk, nên mỗi giới hạn chỉ cần lớn hơn `UPLOAD_CHUNK_SIZE_MB` (8) một chút, và chunk phải giữ tối đa khoảng 90 MB do giới hạn request 100 MB của Cloudflare. Ảnh cover tùy chỉnh (tối đa 5 MB, upload dạng form) cũng nằm trong giới hạn này. Giới hạn tổng kích thước file là `UPLOAD_MAX_SIZE_MB` trong app.

| Thiết lập | Giá trị |
|---|---|
| Nginx `client_max_body_size` | `100m` |
| php.ini `upload_max_filesize` | `100M` |
| php.ini `post_max_size` | `100M` |
| php.ini `max_execution_time` | `300` |
| php.ini `memory_limit` | `512M` |

### Hướng A: aaPanel

aaPanel quản lý Nginx; không chạy `apt install nginx`.

1. **Website → Add site**: domain `embed.example.com`, PHP **8.4**, thư mục site `/www/wwwroot/embed.example.com/public` (không phải thư mục gốc của project). Nếu site đã tồn tại trước khi clone: site → Directory → xác nhận thư mục site là `.../public`.
2. Site → **Directory** → **tắt** "Anti-XSS attack" (open_basedir). Nếu để bật, PHP chỉ đọc được `public/` và bạn sẽ gặp trang trắng kèm `open_basedir restriction in effect`.
3. Site → **URL rewrite** → template **Laravel** (Laravel5). Nếu không có, mọi trang trừ `/` đều 404. Nếu không thấy template, chọn Custom:
   ```nginx
   location / {
       try_files $uri $uri/ /index.php?$query_string;
   }
   ```
4. PHP → 8.4 → **Configuration file**: đặt các giá trị php.ini theo bảng ở trên, rồi restart PHP 8.4.
5. Site → **Config File**: bên trong khối `server { }` có sẵn, thêm `client_max_body_size 100m;` `(verify; aaPanel's global default may be lower)` và proxy Reverb. Reverb cần CẢ `/app/` (WebSocket) và `/apps/` (REST event publishing); thiếu `/apps/` làm broadcast thất bại âm thầm trong khi WebSocket trông vẫn đang kết nối:
   ```nginx
   client_max_body_size 100m;

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
6. Site → **SSL** → tab kiểu "Other certificate" `(verify label)`: dán Origin certificate (PEM) và private key, rồi lưu. (Let's Encrypt HTTP-01 phía sau đám mây cam cùng Always Use HTTPS có thể thất bại; hãy dùng Origin certificate.)
7. Firewall: dùng firewall của aaPanel (Security) `(verify)`: cho phép 80 và 443 (và cổng SSH của bạn); không bao giờ mở 8080, 3306 hay 6379. Không dùng `ufw` ở đây.

### Hướng B: VPS thuần (server sạch)

1. Cài Origin certificate (thuộc root, key để riêng tư):
   ```bash
   sudo mkdir -p /etc/ssl/cloudflare
   sudo nano /etc/ssl/cloudflare/embed.example.com.pem
   sudo nano /etc/ssl/cloudflare/embed.example.com.key
   sudo chown root:root /etc/ssl/cloudflare/embed.example.com.pem /etc/ssl/cloudflare/embed.example.com.key
   sudo chmod 600 /etc/ssl/cloudflare/embed.example.com.key
   ```
2. Tạo `/etc/nginx/sites-available/hls-r2-studio`. Kiểm tra `nginx -v`: với nginx 1.25.1+ bạn có thể thêm `http2 on;` dưới dòng `listen 443 ssl;`; các phiên bản cũ hơn dùng `listen 443 ssl http2;` `(verify)`. HTTP/2 ở đây là tùy chọn (Cloudflare tới origin vẫn chạy được mà không cần nó `(verify)`).
   ```nginx
   server {
       listen 80;
       server_name embed.example.com;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl;
       server_name embed.example.com;

       ssl_certificate     /etc/ssl/cloudflare/embed.example.com.pem;
       ssl_certificate_key /etc/ssl/cloudflare/embed.example.com.key;
       ssl_protocols TLSv1.2 TLSv1.3;

       root /var/www/hls-r2-studio/public;
       index index.php;

       client_max_body_size 100m;

       location / {
           try_files $uri $uri/ /index.php?$query_string;
       }

       location ~ \.php$ {
           fastcgi_pass unix:/run/php/php8.4-fpm.sock;
           fastcgi_index index.php;
           include fastcgi_params;
           fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
           fastcgi_read_timeout 300s;
       }

       location ~ /\.(?!well-known).* {
           deny all;
       }

       # Reverb needs BOTH /app/ (WebSocket from the browser) and /apps/ (REST requests the
       # server uses to publish events). Missing /apps/ makes broadcasts fail silently even
       # though the WebSocket looks connected.
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
   Hãy xóa site mặc định của distro (dòng `rm` bên dưới) để nó không trả lời cho các host khác; đây là bố cục chuẩn của nginx cài bằng apt trên Debian/Ubuntu `(verify)`, và `-f` giúp lệnh an toàn nếu file không tồn tại.
   ```bash
   sudo ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. Giới hạn PHP: sửa `/etc/php/8.4/fpm/php.ini` với các giá trị trong bảng ở trên, rồi:
   ```bash
   sudo systemctl restart php8.4-fpm
   ```
4. Firewall. **Cho phép SSH trước**: bật `ufw` mà không có nó sẽ khóa bạn ra khỏi server.
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Không bao giờ mở 8080 (Reverb), 3306 hay 6379. Để chỉ nhận web traffic từ Cloudflare, xem phần hardening tùy chọn ở mục 11.

## 10. Dịch vụ chạy nền

App cần ba tiến trình chạy dài hạn, không cái nào do aaPanel quản lý. Hãy tạo các unit file với giá trị theo hướng của bạn:

| | Hướng A: aaPanel | Hướng B: VPS thuần |
|---|---|---|
| `<USER>` | `www` | `www-data` |
| `<APP_DIR>` | `/www/wwwroot/embed.example.com` | `/var/www/hls-r2-studio` |
| `<PHP_BIN>` | `/www/server/php/84/bin/php` | `/usr/bin/php8.4` |
| `systemctl` | chạy bằng root | thêm tiền tố `sudo` |

`After=` liệt kê các unit mysql và redis chỉ để sắp xếp thứ tự; các unit không tồn tại trên hệ thống của bạn (unit MySQL là `mysql` hoặc `mariadb`; MySQL/Redis của aaPanel có thể không có systemd unit) sẽ bị bỏ qua.

Queue worker, `/etc/systemd/system/hls-r2-studio-queue@.service` (là template, nên có thể chạy nhiều instance):

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service mariadb.service redis-server.service

[Service]
User=<USER>
WorkingDirectory=<APP_DIR>
ExecStart=<PHP_BIN> artisan queue:work --sleep=3 --tries=1 --timeout=172800 --max-time=172800
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Reverb, `/etc/systemd/system/hls-r2-studio-reverb.service` (một instance):

```ini
[Unit]
Description=HLS R2 Studio Reverb (WebSocket)
After=network.target

[Service]
User=<USER>
WorkingDirectory=<APP_DIR>
ExecStart=<PHP_BIN> artisan reverb:start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Scheduler (dọn dẹp hằng ngày), `/etc/systemd/system/hls-r2-studio-scheduler.service` (một instance):

```ini
[Unit]
Description=HLS R2 Studio Scheduler
After=network.target mysql.service mariadb.service redis-server.service

[Service]
User=<USER>
WorkingDirectory=<APP_DIR>
ExecStart=<PHP_BIN> artisan schedule:work
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
sudo systemctl enable --now hls-r2-studio-reverb hls-r2-studio-scheduler
```

- `--timeout=172800` (48 giờ) khớp với timeout thực của job (xem `TRANSCODE_TIMEOUT_MULTIPLIER` trong [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa)); `DB_QUEUE_RETRY_AFTER=176400` phải luôn lớn hơn, nếu không worker thứ hai sẽ nhận một job vẫn đang chạy. Không có `--timeout`, Laravel kill job sau 60 giây. `--timeout` cần `pcntl`.
- **Cấu hình số lượng:** mỗi worker chạy một ffmpeg tại một thời điểm và ffmpeg mặc định dùng mọi core. Trên VPS nhỏ (ví dụ 4 vCPU dùng chung với PHP-FPM và MySQL) hãy chạy 1-2 worker, đặt `FFMPEG_THREADS` khoảng số core CPU / số worker, và giữ `FFMPEG_NICE=10`. Có thể thêm `Nice=10` và `CPUQuota=250%` (giá trị ví dụ) dưới `[Service]`; không bắt buộc khi `FFMPEG_NICE` là đủ.
- Giữ `REVERB_SERVER_HOST=127.0.0.1`: Reverb lắng nghe cục bộ và chỉ truy cập được thông qua Nginx.

## 11. Cấu hình Cloudflare

Nhãn trên dashboard `(verify)` khác nhau giữa các phiên bản. Hãy làm các bước này sau khi origin đã chạy được qua HTTPS (mục 9).

1. **DNS và WebSockets**: `embed.example.com` ở trạng thái Proxied (mục 0). Network → **WebSockets** phải bật (mặc định bật) cho Reverb `(verify)`.
2. **SSL/TLS → Overview**: đặt **Full (strict)** (chỉ sau khi đã cài Origin certificate), và SSL/TLS → Edge Certificates → bật **Always Use HTTPS**. Lý do: không bị redirect loop, đường truyền tới origin được mã hóa.
3. **Cache Rule cho trang embed** (Rules → Cache Rules): hostname equals `embed.example.com` và URI path starts with `/embed/` → Cache eligibility **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**. Lý do: Cloudflare mặc định không cache HTML, và app gửi `Cache-Control: public, max-age=60, s-maxage=300` không kèm cookie (response có `Set-Cookie` hoặc `private/no-cache/no-store/max-age=0` không bao giờ được cache). Hệ quả: thay đổi allowlist hoặc việc xóa video có thể mất tới 5 phút mới hiện trên trang đã cache (1 phút trên trình duyệt).
4. **Cache Rule cho domain R2**: hostname equals `cdn.example.com` → **Eligible for cache**; Edge TTL **Ignore cache-control header and use this TTL** = **1 day**; Browser TTL **Override origin and use this TTL** = **2 hours** (mức nhỏ nhất mà danh sách của gói Free cho chọn; "Respect origin" cũng dùng được). Lý do: `.m3u8` và `.ts` không nằm trong các extension được Cloudflare cache mặc định, nên mọi segment sẽ đều chạm tới R2. Video đã xóa hoặc bị gỡ vẫn có thể được phục vụ từ edge tối đa bằng TTL; trên gói free, purge chỉ hoạt động theo từng URL.
5. **Không challenge traffic của iframe**: nếu người xem thấy trang challenge hoặc khung trống trong iframe, hãy thêm một WAF custom rule với action **Skip** cho URI path starts with `/embed/`, `/apps/` hoặc `/app/` (và cho domain R2), hoặc hạ security level cho các path đó. Lý do: iframe không thể giải challenge `(verify)`.
   - `/apps/` và `/app/` cũng quan trọng: `config/broadcasting.php` publish broadcast event bằng `REVERB_HOST`/`REVERB_PORT`/`REVERB_SCHEME`, nên chính VPS gọi `https://embed.example.com:443/apps/...` qua Cloudflare rồi quay lại Nginx `/apps/` (không gọi trực tiếp tới `127.0.0.1:8080`). Cloudflare không được challenge hay chặn các request server-to-server này.
   - Under Attack mode và Bot Fight Mode có thể chặn chúng, và Bot Fight Mode không thể bị bỏ qua bằng WAF custom rule `(verify)`. Nếu live progress ngừng trong khi WebSocket vẫn kết nối, hãy tắt các chế độ đó cho zone và thử lại `(verify)`.
6. **Hotlink rule cho domain R2** (Security → WAF → Custom rules, action **Block**), expression `(verify the syntax in the dashboard)`:
   ```
   (http.host eq "cdn.example.com" and http.referer ne "" and not http.referer contains "embed.example.com")
   ```
   - Request có **Referer rỗng phải vẫn được cho phép**: phát HLS native của Safari/iOS thường không gửi Referer, nên chặn Referer rỗng sẽ làm hỏng việc phát trên iPhone.
   - Rule này chỉ ngăn player của website khác, không ngăn được script không gửi Referer.
   - Sau khi bật, hãy test phát video trên iPhone và trình duyệt desktop.
7. **CORS của R2 bucket** (R2 → bucket → Settings → CORS policy) để embed origin có thể GET các file HLS `(verify the format in the dashboard)`:
   ```json
   [{"AllowedOrigins":["https://embed.example.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
   Lý do: player lấy playlist và segment qua cross-origin.
8. **Hardening tùy chọn, chỉ nhận web traffic từ Cloudflare** `(verify)`. Lý do: ngăn kẻ tấn công vượt qua Cloudflare bằng IP của origin. VPS thuần dùng `ufw` (SSH vẫn được cho phép): xóa các rule chung, rồi cho phép các dải IP Cloudflare đã công bố:
   ```bash
   sudo ufw delete allow 80/tcp
   sudo ufw delete allow 443/tcp
   for ip in $(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6); do sudo ufw allow from "$ip" to any port 80,443 proto tcp; done
   ```
   Kiểm tra site vẫn tải được. Các dải IP hiếm khi thay đổi; chạy lại thỉnh thoảng. Trên aaPanel hãy dùng firewall của panel thay thế.

## 12. Cài đặt trong app, smoke test, dọn index Google

1. **Embed allowlist**: đăng nhập tại `https://embed.example.com/login` → Settings → **Embed protection** → Allowed domains: thêm `www.example.com` và `example.com` (mỗi dòng một domain; chấp nhận dạng `*.example.com` và `https://host:port`). Để trống nghĩa là website nào cũng có thể nhúng player. Site của chính app luôn được cho phép, nên preview trong dashboard hoạt động.
2. **Smoke test**:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://embed.example.com/up
   curl -sI https://embed.example.com/login
   ```
   - (a) `/up` trả về 200; `/login` hiển thị `x-robots-tag: noindex, nofollow, noarchive`.
   - (b) Upload một video ngắn và theo dõi các giai đoạn (upload, merge, transcode, R2 upload) hoàn tất. Progress phải cập nhật trực tiếp: có kết nối `wss://embed.example.com/app/...` với status 101 trong dev tools của trình duyệt, và thanh progress thực sự chạy (điều này cũng chứng minh đường publish `/apps/` qua Cloudflare hoạt động).
   - (c) Sau đó kiểm tra embed URL (cần một video đã sẵn sàng), và phát trên desktop và iPhone:
     ```bash
     curl -sI https://embed.example.com/embed/<video-id>
     ```
     Kết quả không có `Set-Cookie`, có `Cache-Control: public, max-age=60, s-maxage=300`, `X-Robots-Tag: noindex, nofollow`, và ở request thứ hai có `cf-cache-status: HIT`.
   - (d) Throttling: gửi liên tiếp 6 lần đăng nhập sai và kỳ vọng HTTP 429 ở lần thứ 6 (giới hạn là 5 mỗi phút mỗi IP), sau đó xác nhận một mạng/IP khác vẫn đăng nhập được.
3. **Gỡ các trang đã bị index khỏi Google**: app gửi `X-Robots-Tag: noindex, nofollow, noarchive` trên mọi response (trang embed giữ `noindex, nofollow` riêng của nó) và các layout có thẻ meta `robots`.
   - Giữ `robots.txt` ở trạng thái mở. **Không** thêm `Disallow: /`: Google phải tải được các trang để thấy noindex, nếu không nó sẽ giữ nguyên các URL trong danh sách.
   - Để gỡ nhanh hơn, hãy xác minh domain trong Google Search Console, rồi Removals → New request (gỡ tạm thời). Nếu không, Google sẽ loại chúng ở lần crawl tiếp theo (từ vài ngày đến vài tuần).

## Cập nhật / deploy lại khi có code mới

```bash
cd <APP_DIR>
git pull
```

Sau đó, theo thứ tự này, chỉ làm những gì thay đổi cần:

**Quy tắc chung:** mọi thay đổi đối với `.env` hoặc bất kỳ `config/*.php` nào cũng cần `config:clear` VÀ restart queue worker, Reverb và scheduler, vì các tiến trình chạy dài hạn đó giữ config trong bộ nhớ (bao gồm cả `config/cache.php`). Các dòng trong bảng dưới là những trường hợp cụ thể.

| Lệnh | Chỉ cần khi |
|---|---|
| `<PHP> /usr/bin/composer install --no-dev -o` (VPS thuần: `composer install --no-dev -o`) | `composer.json` / `composer.lock` thay đổi |
| `npm ci` | `package.json` / `package-lock.json` thay đổi |
| `npm run build` | `resources/css`, `resources/js`, bất kỳ `.blade.php` nào, hoặc bất kỳ giá trị `REVERB_*` nào thay đổi |
| `<PHP> artisan migrate --force` | Có migration mới trong `database/migrations/` |
| `<PHP> artisan config:clear` | Một file `config/*.php` hoặc `.env` thay đổi |
| Restart các **queue worker**: `sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2` | `app/Jobs/TranscodeVideoJob.php` hoặc code xử lý queue, `app/Services/*`, `app/Support/FfmpegCommand.php`, `config/videos.php` hoặc `config/services.php` thay đổi |
| Restart **Reverb**: `sudo systemctl restart hls-r2-studio-reverb` | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` hoặc bất kỳ giá trị `REVERB_*` nào thay đổi |
| Restart **scheduler**: `sudo systemctl restart hls-r2-studio-scheduler` | `routes/console.php` hoặc `app/Console/Commands/*` thay đổi |
| Restart **PHP-FPM** (VPS thuần: `sudo systemctl restart php8.4-fpm`; aaPanel: restart PHP 8.4 trong panel) | `php.ini` thay đổi |
| `sudo chown -R <USER>:<USER> storage bootstrap/cache` và `sudo chmod -R 775 storage bootstrap/cache` | **Luôn luôn, làm cuối cùng** (artisan chạy bằng root có thể đã tạo file thuộc root) |

Nếu bạn không chắc một lệnh có cần hay không, cứ chạy hết; không gây hại gì.

Restart queue sẽ làm gián đoạn video đang được transcode (systemd dừng nó sau stop timeout, mặc định 90 giây `(verify)`, và `--tries=1` nghĩa là job không được thử lại). Hãy restart worker khi không có video nào đang xử lý; `<PHP> artisan queue:restart` là cách nhẹ nhàng hơn: worker thoát sau khi xong job hiện tại và systemd khởi động lại chúng.

## Vận hành

| Tác vụ | Lệnh |
|---|---|
| Trạng thái service | `sudo systemctl status hls-r2-studio-queue@1 hls-r2-studio-reverb hls-r2-studio-scheduler` |
| Log của service | `sudo journalctl -u hls-r2-studio-queue@1 -f` (tương tự cho `hls-r2-studio-reverb`, `hls-r2-studio-scheduler`) |
| Log của app | `<APP_DIR>/storage/logs/laravel-YYYY-MM-DD.log` (channel daily, giữ 14 ngày) |
| Health | `curl -s -o /dev/null -w "%{http_code}\n" https://embed.example.com/up` (kỳ vọng 200) |
| Redis | `redis-cli ping` (kỳ vọng `PONG`); nếu nó ngừng hoạt động, app chuyển sang cache database |
| Ổ đĩa | Dashboard hiển thị mức sử dụng đĩa; hãy theo dõi, upload bị từ chối khi dung lượng trống dưới 2x kích thước file + 256 MB |

**Dọn dẹp hằng ngày** chạy từ scheduler service (`routes/console.php`); bạn cũng có thể chạy từng lệnh bằng tay (bằng `<USER>` để quyền sở hữu `storage/` luôn đúng, ví dụ `sudo -u <USER> <PHP> artisan ...`):

| Lệnh | Dọn |
|---|---|
| `uploads:cleanup-abandoned` | Các thư mục upload chunk bị bỏ dở (`UPLOAD_ABANDONED_TTL_HOURS`) |
| `videos:cleanup-orphaned-tmp` | Các thư mục temp transcode bị crash hoặc kẹt (`TRANSCODE_ORPHANED_TTL_HOURS`) |
| `videos:cleanup-orphaned-uploads` | Các file gốc mồ côi (`UPLOAD_ORPHANED_TTL_HOURS`; không làm gì khi `KEEP_ORIGINAL_UPLOAD=true`) |

**Backup.** Video nằm trên R2 và hướng dẫn này không backup chúng. Hãy backup database hằng ngày và giữ các bản sao ngoài server. Đặt thông tin đăng nhập trong một option file riêng tư thay vì trên command line (`~/.my.cnf` của user chạy cron, `chmod 600`):

```ini
[client]
user=hls_app
password=<strong-password>
```

```bash
sudo mkdir -p /var/backups/hls-r2-studio
sudo crontab -e
```

```cron
0 3 * * * mysqldump --single-transaction --no-tablespaces hls_r2_studio | gzip > /var/backups/hls-r2-studio/db-$(date +\%F).sql.gz
30 3 * * * find /var/backups/hls-r2-studio -name 'db-*.sql.gz' -mtime +14 -delete
```

(Crontab cần escape `%` thành `\%`. Cron job của root đọc `/root/.my.cnf`.) Hãy cũng giữ một bản sao `.env` và private key của Origin certificate (`/etc/ssl/cloudflare/embed.example.com.key`, hoặc key bạn đã dán vào aaPanel) ngoài server; lưu chúng trong password manager, không lưu trong repository.

## Các lỗi thường gặp khi deploy

Bảng đầy đủ và Q&A: [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa). Các triệu chứng riêng của deploy:

| Triệu chứng | Nguyên nhân có thể |
|---|---|
| Cloudflare 521 / 526 | Origin không lắng nghe trên 443, hoặc thiếu Origin certificate (mục 9), trong khi SSL mode là Full (strict) |
| HTTP 500 sau khi cài hoặc cập nhật | File thuộc root trong `storage/` (mục 8) |
| Live progress không bao giờ cập nhật, console hiển thị `localhost:8080` | Frontend được build trước khi `.env` có giá trị `REVERB_*` cuối cùng: sửa `.env`, chạy `npm run build` |
| WebSocket kết nối nhưng broadcast không bao giờ tới (`Pusher error: 404`) | Nginx thiếu `location /apps/` |
| Live progress có kết nối (WebSocket 101) nhưng cập nhật không bao giờ tới | Việc publish event (VPS → Cloudflare → Nginx `/apps/`) bị một rule Cloudflare chặn, hoặc Nginx thiếu `location /apps/` |
| Upload thất bại với 413 | `client_max_body_size` hoặc giới hạn body 100 MB của Cloudflare thấp hơn `UPLOAD_CHUNK_SIZE_MB` |
| Trang trắng `open_basedir restriction in effect` (aaPanel) | "Anti-XSS attack" vẫn đang bật |
| Mọi trang trừ `/` đều 404 (aaPanel) | URL rewrite chưa được bật |
| Video kẹt ở "Processing", log có `Job timed out` | Queue worker thiếu `--timeout=172800` |
