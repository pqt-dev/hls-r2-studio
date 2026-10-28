> [English](DEPLOYMENT.md) | Tiếng Việt

# Hướng dẫn Deploy

> Quay lại [README](../README.vi.md). Phần phát triển local nằm trong README; lỗi, Q&A và cấu trúc dữ liệu nằm trong [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md).

Đưa một VPS mới thành bản cài đặt chạy thật phía sau Cloudflare, theo đúng thứ tự. Luồng chính dùng aaPanel; VPS thuần nằm ở [phụ lục](#phụ-lục-vps-thuần-không-dùng-aapanel). Nhãn giao diện và một số tùy chọn trên dashboard khác nhau giữa các phiên bản aaPanel/Cloudflare; hãy đối chiếu trên màn hình thật. Không bao giờ dán key, token, nội dung `.env` hoặc private key vào ticket hay chat.

| Placeholder | Ý nghĩa |
|---|---|
| `embed-site.com` | Domain của app và embed (server này) |
| `cdn.embed-site.com` | Custom domain public của R2 (= `R2_URL`) |
| `main-site.com` | Website WordPress nhúng player (có thể trả lời trên cả `main-site.com` và `www.main-site.com`; cả hai đều đưa vào Embed allowlist) |
| `<git-repo-url>` | URL repository của bạn |

Giá trị aaPanel dùng bên dưới: thư mục dashboard `/www/wwwroot/embed-site.com`, PHP CLI `/www/server/php/84/bin/php`, user `www`. Làm việc trong root shell (`sudo -i`) nên không cần `sudo`.

## Chọn hướng deploy

- Server đã chạy aaPanel: làm theo hướng dẫn này; không bao giờ cài thêm bộ thuần (`apt install nginx`, `ufw`) bên cạnh nó.
- VPS Ubuntu/Debian sạch, không có panel: dùng [phụ lục](#phụ-lục-vps-thuần-không-dùng-aapanel); không bao giờ cài aaPanel lên server đã cấu hình tay.

## Go-live runbook (theo thứ tự)

| # | Bước | Mục |
|---|---|---|
| 0 | Tài khoản: Cloudflare, cấu hình VPS, R2 bucket + token + custom domain, Origin certificate | [0](#0-chuẩn-bị-và-tài-khoản) |
| 1 | Phần mềm server: PHP 8.4, Composer, Node 22, FFmpeg | [1](#1-phần-mềm-trên-server) |
| 2 | Database và user riêng | [2](#2-database) |
| 3 | Redis | [3](#3-redis) |
| 4 | Lấy code, `composer install` | [4](#4-lấy-code-và-cài-php-dependencies) |
| 5 | Tạo và điền đầy đủ `.env` | [5](#5-cấu-hình-env) |
| 6 | `key:generate`, `migrate --force`, `admin:create` | [6](#6-app-key-tạo-bảng-database-tạo-admin) |
| 7 | `npm ci`, `npm run build` (sau khi xong `.env`) | [7](#7-build-frontend-assets) |
| 8 | Quyền file (sau mỗi lệnh artisan chạy bằng root) | [8](#8-quyền-thư-mục) |
| 9 | Web server, giới hạn upload, Origin certificate | [9](#9-web-server-và-ssl) |
| 10 | Dịch vụ queue, Reverb và scheduler | [10](#10-dịch-vụ-chạy-nền) |
| 11 | Cloudflare: WebSockets, Full (strict), các rule | [11](#11-cấu-hình-cloudflare) |
| 12 | Embed allowlist, smoke test, dọn index Google | [12](#12-cài-đặt-trong-app-smoke-test-dọn-index-google) |

Sau go-live: [Cập nhật](#cập-nhật--deploy-lại-khi-có-code-mới), [Vận hành](#vận-hành), [Các lỗi thường gặp khi deploy](#các-lỗi-thường-gặp-khi-deploy).

## 0. Chuẩn bị và tài khoản

VPS: tối thiểu 2 vCPU / 4 GB, khuyến nghị 4 vCPU / 8 GB; ổ đĩa khoảng 2x dung lượng video lớn nhất nhân với số lượt upload đồng thời, cộng OS (upload bị từ chối khi dung lượng trống dưới 2x kích thước file + 256 MB).

1. Thêm domain vào Cloudflare. DNS: `A` `embed-site.com` trỏ tới IP của VPS, **Proxied**. Giữ nguyên chế độ SSL/TLS cho đến mục 11.
2. R2: tạo bucket, kết nối custom domain `cdn.embed-site.com` (Settings > Custom Domains). `R2_URL` phải là domain này, không bao giờ dùng `r2.dev`.
3. R2 > Manage API tokens: token **Object Read & Write** giới hạn cho bucket này. Ghi lại Access Key ID, Secret Access Key và S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. SSL/TLS > Origin Server > Create Certificate: **RSA**, hostname `embed-site.com`, 15 năm. Copy certificate và private key ngay (key chỉ hiển thị một lần); cài ở mục 9.
5. Xác định origin WordPress: site có thể trả lời trên cả `main-site.com` và `www.main-site.com` (cả hai đều đưa vào Embed allowlist, mục 12).

## 1. Phần mềm trên server

1. App Store > PHP: cài **PHP-8.4** (nếu đường dẫn khác, tìm bằng `ls /www/server/php/`).
2. PHP > 8.4 > Install extensions: bật `fileinfo`, `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath`, `redis`, rồi restart PHP 8.4 (`pcntl` bắt buộc cho `--timeout` của queue).
3. Cập nhật Composer (bản cài sẵn thường quá cũ), rồi cài Node 22 LTS, FFmpeg và git (Debian/Ubuntu):

   ```bash
   /www/server/php/84/bin/php /usr/bin/composer self-update
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt install -y nodejs ffmpeg git unzip
   ```
4. Kiểm tra:

   ```bash
   /www/server/php/84/bin/php -v
   /www/server/php/84/bin/php -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
   node -v
   ffmpeg -version
   ffprobe -version
   ffmpeg -encoders | grep libx264
   ```

Kỳ vọng: PHP 8.4+, đủ bốn extension, Node `^20.19.0 || >=22.12.0` (dùng 22 LTS), có `libx264`, Composer 2.2+ (`composer -V`). Build cần internet đi ra ngoài (Vite tải một font).

## 2. Database

Cần **MySQL 8.0.16+ hoặc MariaDB 10.6+** (migration dùng `CHECK` được thực thi thật, cột `STORED` với `SHA2()`, prefix index; utf8mb4). aaPanel > Database > Add database: tên `hls_r2_studio`, charset utf8mb4, user riêng và mật khẩu mạnh (access: local). Không bao giờ dùng `root` trong `.env`.

## 3. Redis

App Store: cài **Redis**, lắng nghe trên `127.0.0.1`, tự khởi động cùng hệ thống; nếu đặt mật khẩu, dùng nó trong `REDIS_PASSWORD`. Redis giữ bộ đếm rate-limit, key dedup của Activity Log và lock của scheduler; với `CACHE_STORE=failover`, app chuyển sang cache database nếu Redis ngừng hoạt động.

## 4. Lấy code và cài PHP dependencies

Clone vào thư mục tạm rồi di chuyển vào đúng chỗ (clone vào thư mục do panel tạo sẽ lỗi `destination path '.' already exists`). `rm -rf` xóa thư mục đích: chỉ chạy khi thư mục đó chỉ chứa file do panel sinh ra.

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf embed-site.com
mv hls-temp embed-site.com
cd embed-site.com
/www/server/php/84/bin/php /usr/bin/composer install --no-dev -o
```

## 5. Cấu hình `.env`

Mục 4-8 chạy từ `/www/wwwroot/embed-site.com`. **Điền đầy đủ `.env` trước mục 6 và 7.** `.env.example` có giá trị mặc định cho development (`APP_ENV=local`, `DB_HOST=mysql`, `REVERB_HOST=localhost`, ...): đổi mọi key bên dưới; để trống `APP_KEY` và giữ các key còn lại ở mặc định.

```bash
cp .env.example .env
nano .env
```

```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://embed-site.com
FORCE_HTTPS=true
SESSION_SECURE_COOKIE=true
# Only Cloudflare IP ranges may set X-Forwarded-For (per-IP throttling depends on it)
TRUSTED_PROXIES=cloudflare
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=hls_app
DB_PASSWORD=<strong-password>
# Must stay greater than the queue worker --timeout (172800)
DB_QUEUE_RETRY_AFTER=176400
CACHE_STORE=failover
REDIS_CLIENT=phpredis
# REDIS_PASSWORD=<redis-password>   (only if Redis has a password)
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=<bucket-name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=https://cdn.embed-site.com
# REVERB_HOST/PORT/SCHEME are the PUBLIC address the browser uses
REVERB_APP_ID=<generated>
REVERB_APP_KEY=<generated>
REVERB_APP_SECRET=<generated>
REVERB_HOST=embed-site.com
REVERB_PORT=443
REVERB_SCHEME=https
# Where reverb:start binds; Nginx proxies to it. Never expose it directly.
REVERB_SERVER_HOST=127.0.0.1
REVERB_SERVER_PORT=8080
# Hostname only, NOT a URL
REVERB_ALLOWED_ORIGINS=embed-site.com
# Chunk must stay <= ~90 MB (Cloudflare caps a request body at 100 MB on Free/Pro)
UPLOAD_MAX_SIZE_MB=2048
UPLOAD_CHUNK_SIZE_MB=8
FFMPEG_NICE=10
FFMPEG_THREADS=2
```

`CORS_ALLOWED_ORIGINS` và `REPORT_ALLOWED_HOSTS` là phần bổ sung tùy chọn (mặc định rỗng); các domain của site chính nằm trong Embed allowlist (mục 12).

Tạo các giá trị Reverb bằng `openssl rand -hex 10` (`REVERB_APP_ID`), `openssl rand -hex 20` (`REVERB_APP_KEY`), `openssl rand -hex 32` (`REVERB_APP_SECRET`). `FFMPEG_THREADS` khoảng số core CPU / số worker. Chỉ đặt `FFMPEG_BINARY`/`FFPROBE_BINARY` khi `which ffmpeg`/`which ffprobe` không trả về gì.

- **Redis failover im lặng:** cấu hình Redis sai KHÔNG gây lỗi, app chỉ dùng cache database. Luôn chạy bước kiểm tra Redis ở mục 6. Không có Redis: `CACHE_STORE=database` và bỏ các dòng `REDIS_*`.
- **Mọi thay đổi `REVERB_*` sau này đều cần `npm run build` lại:** giá trị được nhúng vào JavaScript, và bản build với giá trị mặc định sẽ gửi `localhost:8080` tới trình duyệt (live progress hỏng âm thầm).
- Sau mỗi lần sửa `.env`, chạy `/www/server/php/84/bin/php artisan config:clear` và restart các dịch vụ (mục 10); chúng giữ config trong bộ nhớ.

## 6. App key, tạo bảng database, tạo admin

```bash
/www/server/php/84/bin/php artisan key:generate
/www/server/php/84/bin/php artisan migrate --force
/www/server/php/84/bin/php artisan admin:create admin --email=admin@example.com
```

- `--force` là bắt buộc ở production. `admin:create` hỏi mật khẩu ẩn (tối thiểu 8); chạy lại với cùng username sẽ đặt lại mật khẩu.
- Kiểm tra Redis (bỏ qua nếu `CACHE_STORE=database`): lệnh đầu in `pong`, lệnh thứ hai phải liệt kê key (`REDIS_CACHE_DB` mặc định là 1, nên dùng `-n 1`). Nếu rỗng, app KHÔNG dùng Redis: kiểm tra `REDIS_*`, extension PHP và `redis-cli ping`.

  ```bash
  /www/server/php/84/bin/php artisan tinker --execute="Cache::put('ping','pong',60); echo Cache::get('ping');"
  redis-cli -n 1 keys '*'
  ```

## 7. Build frontend assets

Chỉ sau khi `.env` đã hoàn chỉnh. Cần Node 22 và internet đi ra ngoài.

```bash
npm ci
npm run build
```

## 8. Quyền thư mục

Artisan chạy bằng root có thể tạo file thuộc root trong `storage/` mà PHP-FPM không ghi được (HTTP 500). Chạy bước này ở cuối mỗi lần cài và mỗi lần cập nhật, sau mọi lệnh artisan bằng root. Nếu không chắc `www` là user PHP-FPM, kiểm tra bằng `ps aux | grep php-fpm`.

```bash
chown -R www:www storage bootstrap/cache
chmod -R 775 storage bootstrap/cache
chown root:www .env
chmod 640 .env
```

## 9. Web server và SSL

Cài **Origin certificate lên origin trước**, và chỉ sau đó mới đặt Cloudflare là Full (strict) (mục 11), nếu không sẽ gặp 521/526. Upload được chia chunk nên mỗi giới hạn chỉ cần lớn hơn `UPLOAD_CHUNK_SIZE_MB`.

| Thiết lập | Giá trị |
|---|---|
| Nginx `client_max_body_size` | `100m` |
| php.ini `upload_max_filesize` | `100M` |
| php.ini `post_max_size` | `100M` |
| php.ini `max_execution_time` | `300` |
| php.ini `memory_limit` | `512M` |

aaPanel quản lý Nginx; không chạy `apt install nginx`.

1. **Website > Add site**: domain `embed-site.com`, PHP **8.4**, thư mục site `/www/wwwroot/embed-site.com/public` (không phải thư mục gốc project).
2. Site > **Directory**: **tắt** "Anti-XSS attack" (open_basedir), nếu không sẽ gặp trang trắng kèm `open_basedir restriction in effect`.
3. Site > **URL rewrite**: template **Laravel** (Laravel5), nếu không mọi trang trừ `/` đều 404. Nếu không thấy, chọn Custom:

   ```nginx
   location / {
       try_files $uri $uri/ /index.php?$query_string;
   }
   ```
4. PHP > 8.4 > **Configuration file**: đặt các giá trị php.ini theo bảng, restart PHP 8.4.
5. Site > **Config File**: bên trong khối `server { }` có sẵn, thêm các dòng dưới (`client_max_body_size` toàn cục của aaPanel có thể thấp hơn). Reverb cần CẢ `/app/` (WebSocket) và `/apps/` (publish event); thiếu `/apps/` thì broadcast thất bại âm thầm.

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
6. Site > **SSL** > tab "Other certificate" `(verify label)`: dán Origin certificate và private key. Dùng nó thay cho Let's Encrypt (HTTP-01 có thể thất bại phía sau đám mây cam).
7. aaPanel > Security: cho phép 80, 443 và cổng SSH; không bao giờ mở 8080, 3306 hay 6379. Không dùng `ufw` ở đây.

## 10. Dịch vụ chạy nền

Ba tiến trình chạy dài hạn, không do aaPanel quản lý. `After=` chỉ để sắp xếp thứ tự; unit không tồn tại trên hệ thống sẽ bị bỏ qua.

Queue worker, `/etc/systemd/system/hls-r2-studio-queue@.service` (template, nên chạy được nhiều instance):

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service mariadb.service redis-server.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/embed-site.com
ExecStart=/www/server/php/84/bin/php artisan queue:work --sleep=3 --tries=1 --timeout=172800 --max-time=172800
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Reverb, `/etc/systemd/system/hls-r2-studio-reverb.service`:

```ini
[Unit]
Description=HLS R2 Studio Reverb (WebSocket)
After=network.target

[Service]
User=www
WorkingDirectory=/www/wwwroot/embed-site.com
ExecStart=/www/server/php/84/bin/php artisan reverb:start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Scheduler (dọn dẹp hằng ngày), `/etc/systemd/system/hls-r2-studio-scheduler.service`:

```ini
[Unit]
Description=HLS R2 Studio Scheduler
After=network.target mysql.service mariadb.service redis-server.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/embed-site.com
ExecStart=/www/server/php/84/bin/php artisan schedule:work
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Bật và khởi động:

```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
systemctl enable --now hls-r2-studio-reverb hls-r2-studio-scheduler
```

- `--timeout=172800` (48 giờ) khớp với timeout của job (`TRANSCODE_TIMEOUT_MULTIPLIER`, xem [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa)); `DB_QUEUE_RETRY_AFTER` phải luôn lớn hơn, và không có `--timeout` thì Laravel kill job sau 60 giây.
- Mỗi worker chạy một ffmpeg dùng mọi core: trên VPS nhỏ hãy chạy 1-2 worker, đặt `FFMPEG_THREADS` khoảng số core / số worker và giữ `FFMPEG_NICE=10`.

## 11. Cấu hình Cloudflare

Làm sau khi origin đã chạy được qua HTTPS (mục 9).

1. **WebSockets**: `embed-site.com` ở trạng thái Proxied (mục 0); Network > **WebSockets** bật (mặc định).
2. **SSL/TLS > Overview**: **Full (strict)**, chỉ sau khi đã cài Origin certificate. Edge Certificates: bật **Always Use HTTPS**.
3. **Cache Rule, trang embed** (Rules > Cache Rules): hostname equals `embed-site.com` và URI path starts with `/embed/` > **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**. App gửi `Cache-Control: public, max-age=60, s-maxage=300` không kèm cookie; thay đổi allowlist hoặc việc xóa video có thể mất tới 5 phút mới hiện.
4. **Cache Rule, domain R2**: hostname equals `cdn.embed-site.com` > **Eligible for cache**; Edge TTL **Ignore cache-control header and use this TTL** = **1 day**; Browser TTL **Override origin and use this TTL** = **2 hours** (nhỏ nhất của gói Free; "Respect origin" cũng dùng được). Video đã xóa vẫn có thể nằm ở edge tối đa bằng TTL; gói Free chỉ purge theo từng URL.
5. **Không challenge traffic của iframe và Reverb**: WAF custom rule, action **Skip**, cho URI path starts with `/embed/`, `/apps/` hoặc `/app/` (và domain R2). VPS publish event tới `https://embed-site.com:443/apps/...` qua Cloudflare. Under Attack mode và Bot Fight Mode vẫn có thể chặn chúng, và Bot Fight Mode không thể bị bỏ qua bằng WAF rule `(verify)`: nếu live progress ngừng trong khi WebSocket vẫn kết nối, hãy tắt chúng cho zone.
6. **Hotlink rule, domain R2** (Security > WAF > Custom rules, action **Block**), expression `(verify the syntax in the dashboard)`. **Referer rỗng phải vẫn được cho phép** (HLS native của Safari/iOS không gửi Referer); test trên iPhone và trình duyệt desktop.

   ```
   (http.host eq "cdn.embed-site.com" and http.referer ne "" and not http.referer contains "embed-site.com")
   ```
7. **CORS của R2 bucket** (R2 > bucket > Settings > CORS policy) `(verify the format in the dashboard)`:

   ```json
   [{"AllowedOrigins":["https://embed-site.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
8. **Hardening tùy chọn**: trong firewall của aaPanel chỉ cho phép cổng web từ các dải IP Cloudflare (`https://www.cloudflare.com/ips-v4`, `ips-v6`) và kiểm tra site vẫn tải được. VPS thuần: xem [phụ lục](#phụ-lục-vps-thuần-không-dùng-aapanel).

## 12. Cài đặt trong app, smoke test, dọn index Google

1. **Embed allowlist**: đăng nhập tại `https://embed-site.com/login` > Settings > **Embed protection** > Embed allowlist: thêm `main-site.com` và `www.main-site.com` (mỗi dòng một domain; chấp nhận `*.main-site.com` và `https://host:port`). Cùng danh sách này cũng cho phép các site đó gửi báo cáo phát video (CORS) và quy định host được chấp nhận trong báo cáo (nếu để trống thì site nào cũng nhúng được player và host nào cũng được chấp nhận; nếu không, báo cáo chỉ được nhận từ các host trong danh sách). Danh sách nằm trong database: không cần sửa `.env`, `config:clear` hay restart (trang embed đã cache có thể mất tới 5 phút mới cập nhật). Site của chính app luôn được cho phép.
2. **Smoke test**:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://embed-site.com/up
   curl -sI https://embed-site.com/login
   curl -sI https://embed-site.com/embed/<video-id>
   ```
   - `/up` trả về 200; `/login` có `x-robots-tag: noindex, nofollow, noarchive`.
   - `/embed/<video-id>` (cần video đã sẵn sàng): không có `Set-Cookie`, có `Cache-Control: public, max-age=60, s-maxage=300`, và `cf-cache-status: HIT` ở request thứ hai.
   - Upload một video ngắn: các giai đoạn hoàn tất và progress chạy trực tiếp (`wss://embed-site.com/app/...` status 101 trong dev tools, điều này cũng chứng minh `/apps/` qua Cloudflare hoạt động). Phát embed trên desktop và iPhone.
   - 6 lần đăng nhập sai liên tiếp cho HTTP 429 ở lần thứ 6 (5 mỗi phút mỗi IP).
3. **Google**: mọi response đều có `X-Robots-Tag: noindex, nofollow, noarchive`.
   - Giữ `robots.txt` ở trạng thái mở; **không** thêm `Disallow: /` (Google phải tải được trang để thấy noindex).
   - Để gỡ nhanh hơn: Google Search Console > Removals > New request; nếu không sẽ mất vài ngày đến vài tuần.

## Cập nhật / deploy lại khi có code mới

```bash
cd /www/wwwroot/embed-site.com
git pull
```

Sau đó, theo thứ tự này, chỉ làm những gì thay đổi cần (không chắc thì cứ chạy hết). Mọi thay đổi `.env` hoặc `config/*.php` cần `config:clear` VÀ restart queue worker, Reverb và scheduler.

| Lệnh | Chỉ cần khi |
|---|---|
| `/www/server/php/84/bin/php /usr/bin/composer install --no-dev -o` | `composer.json` / `composer.lock` thay đổi |
| `npm ci` | `package.json` / `package-lock.json` thay đổi |
| `npm run build` | `resources/css`, `resources/js`, bất kỳ `.blade.php` nào, hoặc bất kỳ giá trị `REVERB_*` nào thay đổi |
| `/www/server/php/84/bin/php artisan migrate --force` | Có migration mới trong `database/migrations/` |
| `/www/server/php/84/bin/php artisan config:clear` | Một file `config/*.php` hoặc `.env` thay đổi |
| Restart các **queue worker**: `systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2` | `app/Jobs/TranscodeVideoJob.php` hoặc code xử lý queue, `app/Services/*`, `app/Support/FfmpegCommand.php`, `config/videos.php` hoặc `config/services.php` thay đổi |
| Restart **Reverb**: `systemctl restart hls-r2-studio-reverb` | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` hoặc bất kỳ giá trị `REVERB_*` nào thay đổi |
| Restart **scheduler**: `systemctl restart hls-r2-studio-scheduler` | `routes/console.php` hoặc `app/Console/Commands/*` thay đổi |
| Restart **PHP-FPM**: restart PHP 8.4 trong panel | `php.ini` thay đổi |
| `chown -R www:www storage bootstrap/cache` và `chmod -R 775 storage bootstrap/cache` | **Luôn luôn, làm cuối cùng** |

Restart queue làm gián đoạn video đang transcode (`--tries=1`, không thử lại); hãy restart khi không có video nào đang xử lý, hoặc dùng `/www/server/php/84/bin/php artisan queue:restart` (worker thoát sau khi xong job hiện tại và systemd khởi động lại chúng).

## Vận hành

| Tác vụ | Lệnh |
|---|---|
| Trạng thái service | `systemctl status hls-r2-studio-queue@1 hls-r2-studio-reverb hls-r2-studio-scheduler` |
| Log của service | `journalctl -u hls-r2-studio-queue@1 -f` (tương tự cho `hls-r2-studio-reverb`, `hls-r2-studio-scheduler`) |
| Log của app | `/www/wwwroot/embed-site.com/storage/logs/laravel-YYYY-MM-DD.log` (daily, giữ 14 ngày) |
| Health | `curl -s -o /dev/null -w "%{http_code}\n" https://embed-site.com/up` (kỳ vọng 200) |
| Redis | `redis-cli ping` (kỳ vọng `PONG`) |
| Ổ đĩa | Hiển thị trong dashboard; upload bị từ chối khi dung lượng trống dưới 2x kích thước file + 256 MB |

Scheduler chạy dọn dẹp hằng ngày; muốn chạy tay thì dùng user của site, ví dụ `sudo -u www /www/server/php/84/bin/php artisan uploads:cleanup-abandoned`. Ba lệnh: `uploads:cleanup-abandoned`, `videos:cleanup-orphaned-tmp`, `videos:cleanup-orphaned-uploads`.

**Backup.** Video nằm trên R2; backup database hằng ngày và giữ bản sao ngoài server. Đặt thông tin đăng nhập trong `/root/.my.cnf` (`chmod 600`):

```ini
[client]
user=hls_app
password=<strong-password>
```

```bash
mkdir -p /var/backups/hls-r2-studio
crontab -e
```

```cron
0 3 * * * mysqldump --single-transaction --no-tablespaces hls_r2_studio | gzip > /var/backups/hls-r2-studio/db-$(date +\%F).sql.gz
30 3 * * * find /var/backups/hls-r2-studio -name 'db-*.sql.gz' -mtime +14 -delete
```

Giữ một bản sao `.env` và private key của Origin certificate ngoài server trong password manager, không bao giờ lưu trong repository.

## Các lỗi thường gặp khi deploy

Bảng đầy đủ và Q&A: [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa). Riêng cho deploy:

| Triệu chứng | Nguyên nhân có thể |
|---|---|
| Cloudflare 521 / 526 | Origin không ở cổng 443 hoặc thiếu Origin certificate (mục 9) trong khi SSL mode là Full (strict) |
| HTTP 500 sau khi cài hoặc cập nhật | File thuộc root trong `storage/` (mục 8) |
| Live progress không cập nhật, console hiển thị `localhost:8080` | Build trước khi `.env` có giá trị `REVERB_*` cuối cùng: sửa `.env`, chạy `npm run build` |
| WebSocket kết nối nhưng cập nhật không tới (`Pusher error: 404`) | Nginx thiếu `location /apps/`, hoặc một rule Cloudflare chặn VPS > Cloudflare > `/apps/` |
| Báo cáo từ site chính lỗi CORS hoặc "The page URL host is not allowed" | Domain chưa có trong Embed allowlist (mục 12) |
| Upload thất bại với 413 | `client_max_body_size` hoặc giới hạn body của Cloudflare thấp hơn `UPLOAD_CHUNK_SIZE_MB` |
| Trang trắng `open_basedir restriction in effect` | "Anti-XSS attack" vẫn đang bật (mục 9) |
| Mọi trang trừ `/` đều 404 | URL rewrite chưa được bật (mục 9) |
| Video kẹt ở "Processing", log có `Job timed out` | Queue worker thiếu `--timeout=172800` |

## Phụ lục: VPS thuần (không dùng aaPanel)

Chỉ cho Ubuntu/Debian sạch; mọi thứ không được liệt kê đều giống luồng chính. Chạy bằng root hoặc với `sudo`. Thay các giá trị sau trong luồng chính:

| Mục | aaPanel (luồng chính) | VPS thuần |
|---|---|---|
| Thư mục dashboard | `/www/wwwroot/embed-site.com` | `/var/www/hls-r2-studio` |
| PHP CLI | `/www/server/php/84/bin/php` | `php` (`/usr/bin/php8.4` trong unit file) |
| User | `www` | `www-data` |
| Composer | `.../php /usr/bin/composer ...` | `composer ...` |
| Restart PHP-FPM | trong panel | `systemctl restart php8.4-fpm` |

Phần mềm (PHP 8.4 cần PPA; Debian: dùng repository sury). Nếu `php -v` không phải 8.4: `update-alternatives --set php /usr/bin/php8.4`.

```bash
apt update && apt install -y software-properties-common git unzip curl
add-apt-repository -y ppa:ondrej/php
apt update
apt install -y php8.4-cli php8.4-fpm php8.4-mysql php8.4-mbstring php8.4-curl php8.4-xml php8.4-bcmath php8.4-redis nginx ffmpeg mysql-server redis-server
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
```

Database: `mysql` (Debian: `mariadb-server`), rồi chạy SQL dưới đây tại prompt. Redis: trong `/etc/redis/redis.conf` đặt `bind 127.0.0.1 ::1`, `maxmemory 256mb`, `maxmemory-policy allkeys-lru`, rồi `systemctl enable --now redis-server`. Không bao giờ mở 3306, 6379 hay 8080.

```sql
CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hls_app'@'127.0.0.1' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON hls_r2_studio.* TO 'hls_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Code đặt tại `/var/www/hls-r2-studio` (`git clone <git-repo-url> hls-r2-studio` trong `/var/www`). File Origin certificate (thuộc root, key `chmod 600`):

```bash
mkdir -p /etc/ssl/cloudflare
# paste into /etc/ssl/cloudflare/embed-site.com.pem and embed-site.com.key
chmod 600 /etc/ssl/cloudflare/embed-site.com.key
```

Nginx, `/etc/nginx/sites-available/hls-r2-studio` (giới hạn PHP: sửa `/etc/php/8.4/fpm/php.ini` theo bảng ở mục 9):

```nginx
server {
    listen 443 ssl;
    server_name embed-site.com;
    ssl_certificate     /etc/ssl/cloudflare/embed-site.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/embed-site.com.key;
    root /var/www/hls-r2-studio/public;
    index index.php;
    client_max_body_size 100m;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300s;
    }

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

Bật site và firewall cơ bản (**cho phép SSH trước**, nếu không `ufw enable` sẽ khóa bạn ra ngoài):

```bash
ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Hardening tùy chọn chỉ nhận traffic từ Cloudflare (mục 11 bước 8); sau đó hãy kiểm tra site vẫn tải được:

```bash
ufw delete allow 80/tcp
ufw delete allow 443/tcp
for ip in $(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6); do ufw allow from "$ip" to any port 80,443 proto tcp; done
```
