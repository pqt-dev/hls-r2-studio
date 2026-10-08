# HLS R2 Studio

**English** | [Tiếng Việt](README.vi.md)

Internal video management app: upload a video → transcode it to HLS with FFmpeg → store it on Cloudflare R2 → play it via HLS.js.

## Features

- Admin login and an overview dashboard (server CPU/RAM/Disk + video statistics)
- Chunk upload for large files (single or multiple files)
- FFmpeg HLS transcoding with adjustable resolution (480p/720p/1080p), segment length (2–15 s) and FPS (15–60 or original)
- Storage on Cloudflare R2, playback with HLS.js
- Live transcode progress via Reverb (WebSocket) and an upload log page
- Settings page (password, R2 config, processing options, timezone, embed domains)
- Playback error reports from public pages via `POST /api/reports`

## Tech Stack

- Laravel 13 (`^13.17`), PHP 8.4+, MySQL
- FFmpeg / FFprobe
- Cloudflare R2 (S3-compatible storage)
- Laravel Reverb (`^1.12`) for WebSocket
- HLS.js (player), Vite 8 + Tailwind CSS 4 (assets)

## Quick Start

**Prerequisites**

- PHP 8.4+
- Composer 2.2+
- Node.js + npm
- MySQL
- FFmpeg / FFprobe
- A Cloudflare R2 account

**1. Clone and install**

```bash
composer install
npm install && npm run build
cp .env.example .env
php artisan key:generate
```

**2. Edit `.env`** (fill only these keys; generate each `REVERB_*` value with `openssl rand -hex 16`)

```env
DB_HOST=127.0.0.1
DB_DATABASE=hls_r2_studio
DB_USERNAME=<MySQL user>
DB_PASSWORD=<MySQL password>

R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<bucket name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<public video URL>

REVERB_APP_ID=<random>
REVERB_APP_KEY=<random>
REVERB_APP_SECRET=<random>

APP_URL=http://localhost:8000
```

**3. Create the database, migrate, create the admin**

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
php artisan migrate
php artisan admin:create admin --email=admin@example.com   # prompts for a hidden password (min 8 chars)
```

**4. Run** (5 processes, one terminal each)

```bash
PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload   # web server
php artisan queue:work --name=worker-1   # REQUIRED: without a queue worker chunks are never merged and videos never transcoded
php artisan queue:work --name=worker-2   # second worker so a new upload can start while another video is transcoding
php artisan schedule:work                # optional: daily cleanup of leftover files
php artisan reverb:start                 # optional: live transcode progress (otherwise reload to see progress)
```

**5. Open** `http://localhost:8000/login`

**Important notes**

- R2 public URL: the code does not make the bucket public. Set a public bucket (custom domain or `r2.dev`) in Cloudflare, then enter it in `R2_URL` (or the Settings page).
- Reports from another domain: add that domain to `CORS_ALLOWED_ORIGINS` in `.env`.
- `DB_QUEUE_RETRY_AFTER` (`176400`) must stay greater than the queue worker `--timeout` (`172800`).

## Production / Deploy

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): plain VPS (Nginx + PHP-FPM + systemd), aaPanel, and updating/redeploying with new code
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): common errors, data structure, Q&A (rate limits, `FORCE_HTTPS`, `TRUSTED_PROXIES`, CORS, advanced env options)

## Project Structure

```
app/                  # Console commands, Events, Http, Jobs, Models, Providers, Services, Support
bootstrap/            # Framework bootstrap
config/               # App config (videos.php, reverb.php, filesystems.php, ...)
database/migrations/  # Database schema
public/               # Web root
resources/            # css, js, views (Blade)
routes/               # web.php, api.php, console.php
storage/              # Logs, temp files, framework cache
tests/                # PHPUnit tests
```
