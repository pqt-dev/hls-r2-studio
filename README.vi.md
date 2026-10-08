# HLS R2 Studio

[English](README.md) | **Tiếng Việt**

Ứng dụng quản lý video nội bộ: upload video → băm sang HLS bằng FFmpeg → lưu trên Cloudflare R2 → phát qua HLS.js.

## Chức năng chính

- Đăng nhập admin và dashboard tổng quan (CPU/RAM/Disk server + thống kê video)
- Upload file lớn bằng chunk-upload (đơn lẻ hoặc nhiều file)
- Băm HLS bằng FFmpeg, tuỳ chỉnh độ phân giải (480p/720p/1080p), độ dài segment (2–15 giây), FPS (15–60 hoặc giữ gốc)
- Lưu lên Cloudflare R2, phát bằng HLS.js
- Tiến độ transcode theo thời gian thực qua Reverb (WebSocket) và trang nhật ký upload
- Trang Cài đặt (mật khẩu, cấu hình R2, tuỳ chọn xử lý, múi giờ, domain được embed)
- Nhận báo lỗi phát video từ trang public qua `POST /api/reports`

## Công nghệ

- Laravel 13 (`^13.17`), PHP 8.4+, MySQL
- FFmpeg / FFprobe
- Cloudflare R2 (lưu trữ tương thích S3)
- Laravel Reverb (`^1.12`) cho WebSocket
- HLS.js (player), Vite 8 + Tailwind CSS 4 (asset)

## Cài đặt nhanh

**Yêu cầu**

- PHP 8.4+
- Composer 2.2+
- Node.js + npm
- MySQL
- FFmpeg / FFprobe
- Tài khoản Cloudflare R2

**1. Clone và cài đặt**

```bash
composer install
npm install && npm run build
cp .env.example .env
php artisan key:generate
```

**2. Sửa `.env`** (chỉ điền các key sau; sinh mỗi giá trị `REVERB_*` bằng `openssl rand -hex 16`)

```env
DB_HOST=127.0.0.1
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user MySQL>
DB_PASSWORD=<password MySQL>

R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<tên bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<URL public phát video>

REVERB_APP_ID=<ngẫu nhiên>
REVERB_APP_KEY=<ngẫu nhiên>
REVERB_APP_SECRET=<ngẫu nhiên>

APP_URL=http://localhost:8000
```

**3. Tạo database, migrate, tạo admin**

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
php artisan migrate
php artisan admin:create admin --email=admin@example.com   # sẽ hỏi password (ẩn ký tự, tối thiểu 8 ký tự)
```

**4. Chạy** (5 tiến trình, mỗi cái một terminal)

```bash
PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload   # web server
php artisan queue:work --name=worker-1   # BẮT BUỘC: thiếu queue worker thì chunk không được ghép và video không bao giờ được transcode
php artisan queue:work --name=worker-2   # worker thứ hai để upload mới chạy được khi video khác đang transcode
php artisan schedule:work                # không bắt buộc: dọn rác tự động hàng ngày
php artisan reverb:start                 # không bắt buộc: tiến độ transcode live (thiếu thì tự reload để xem)
```

**5. Mở** `http://localhost:8000/login`

**Lưu ý quan trọng**

- URL public R2: code không tự public hoá bucket. Hãy cấu hình bucket public (custom domain hoặc `r2.dev`) trên Cloudflare rồi điền vào `R2_URL` (hoặc trang Cài đặt).
- Report từ domain khác: thêm domain đó vào `CORS_ALLOWED_ORIGINS` trong `.env`.
- `DB_QUEUE_RETRY_AFTER` (`176400`) phải luôn lớn hơn `--timeout` của queue worker (`172800`).

## Production / Deploy

Các tài liệu dưới đây viết bằng tiếng Anh:

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): VPS thuần (Nginx + PHP-FPM + systemd), aaPanel, cập nhật/deploy lại khi có code mới
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): lỗi thường gặp, cấu trúc dữ liệu, Q&A (rate limit, `FORCE_HTTPS`, `TRUSTED_PROXIES`, CORS, tuỳ chọn env nâng cao)

## Cấu trúc project

```
app/                  # Console commands, Events, Http, Jobs, Models, Providers, Services, Support
bootstrap/            # Khởi tạo framework
config/               # Cấu hình app (videos.php, reverb.php, filesystems.php, ...)
database/migrations/  # Schema database
public/               # Web root
resources/            # css, js, views (Blade)
routes/               # web.php, api.php, console.php
storage/              # Log, file tạm, cache framework
tests/                # PHPUnit tests
```

## Deploy lại khi có code mới

### Cập nhật / deploy lại khi có code mới (VPS thuần)

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

### Cập nhật / deploy lại khi có code mới (aaPanel)

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
