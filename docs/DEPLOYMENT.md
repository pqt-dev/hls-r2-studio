# Deployment Guide

> Back to the [README](../README.md). This guide holds the full production setup (plain VPS and aaPanel) moved out of the README. Troubleshooting, data structure and Q&A are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Installation

> **Note:** The application behaviour described in this README is derived from the source code. The infrastructure steps below (systemd unit names/files, Nginx config, aaPanel UI steps and toggles, Let's Encrypt/certbot, Node setup) are environment-specific, are not defined in this repository, and cannot be verified from the code. aaPanel's UI may differ between versions. If something does not match your environment, see the [Common Errors, Fixes, and Q&A](TROUBLESHOOTING.md#common-errors-fixes-and-qa) section.

> **Does your VPS already have a management panel (aaPanel, cPanel, Plesk...)?**
> - **Already has aaPanel** → follow the [Deploying with aaPanel](#deploying-with-aapanel) section — simpler, no need to install Nginx/PHP-FPM manually.
> - **A "blank" VPS with nothing installed** → follow the [Plain VPS Installation](#plain-vps-installation-no-panel) section right below.

### Redis (cache and rate limiting)

Used by both deployment paths. Rate-limit counters, the Activity Log dedup keys and scheduler locks live in Redis, expire on their own, and add no MySQL load or table growth. With `CACHE_STORE=failover` the app falls back to the database cache table if Redis is down. Sessions and the queue stay on the database. Install Redis before (or right after) setting the `.env` values shown in each path below.

**Plain VPS:**

```bash
sudo apt install -y redis-server php8.4-redis
```

(Match the PHP version in the package name to the one you use.) Then edit `/etc/redis/redis.conf`:

```conf
bind 127.0.0.1 ::1
maxmemory 256mb
maxmemory-policy allkeys-lru
```

`allkeys-lru` can evict keys under memory pressure, which is acceptable for a cache. Then:

```bash
sudo systemctl enable --now redis-server
```

```bash
redis-cli ping
```

It should answer `PONG`. Do NOT open port 6379 in ufw or any firewall.

**aaPanel:** App Store → install **Redis** (confirm it listens on `127.0.0.1` and is set to start on boot). Then **PHP** → **8.4** → **Install extensions** → enable `redis` → restart PHP 8.4. If the aaPanel Redis has a password, set it as `REDIS_PASSWORD` in `.env`.

**`.env`:** `CACHE_STORE=failover` and `REDIS_CLIENT=phpredis` (already included in the `.env` examples below). Set `CACHE_STORE=database` instead if you do not use Redis.

**After changing it**, clear the config cache:

```bash
php artisan config:clear
```

Then restart PHP-FPM and the long-running processes, which keep the old config: on a plain VPS `sudo systemctl restart php8.4-fpm hls-r2-studio-queue@1 hls-r2-studio-queue@2 hls-r2-studio-reverb hls-r2-studio-scheduler`; on aaPanel restart PHP 8.4 in the panel and `systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2 hls-r2-studio-reverb hls-r2-studio-scheduler` (or the equivalent supervisor processes if you run them that way).

**Verify:**

```bash
php artisan tinker --execute="Cache::put('ping','pong',60); echo Cache::get('ping');"
```

It should print `pong`. Then:

```bash
redis-cli -n 1 keys '*'
```

should list keys (Redis DB 1 is `REDIS_CACHE_DB`).

### Plain VPS Installation (No Panel)

**Requirements**: PHP 8.4+ (required — `composer.lock` pins some Symfony packages that need PHP >= 8.4), Composer 2.2+ (run `composer self-update` if you get a `composer-runtime-api` error), Node.js + npm, MySQL, FFmpeg/FFprobe, a Cloudflare R2 account.

**1. Install dependencies**

```bash
composer install
npm install && npm run build
cp .env.example .env
php artisan key:generate
```

**2. Configure `.env`** — one key per line, do not combine them:

```env
# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<MySQL user>
DB_PASSWORD=<MySQL password>

# Cloudflare R2
R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<bucket name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<public video URL, e.g. https://cdn.your-domain.com or an r2.dev URL>

# Domain/HTTPS (must be changed for production)
APP_ENV=production
APP_DEBUG=false
APP_URL=https://your-real-domain

# Trust only Cloudflare's IP ranges for X-Forwarded-For (site proxied by Cloudflare); otherwise set your proxy IP
TRUSTED_PROXIES=cloudflare

# Cache and rate-limit counters in Redis, falling back to the database if Redis is down (see "Redis (cache and rate limiting)" above)
CACHE_STORE=failover
REDIS_CLIENT=phpredis

# Run ffmpeg at low CPU priority so the web app stays responsive (0 disables); optional encoder thread limit per job
FFMPEG_NICE=10
# FFMPEG_THREADS=2

# WebSocket (Reverb) — generate real random values for the 3 lines below, do not leave them empty
REVERB_APP_ID=<random number>
REVERB_APP_KEY=<random string>
REVERB_APP_SECRET=<random string>
REVERB_HOST=your-real-domain
REVERB_PORT=443
REVERB_SCHEME=https
```

> Generate the 3 values above using one of these 2 methods:
> ```bash
> php artisan tinker --execute="echo Str::random(20);"   # REVERB_APP_KEY
> php artisan tinker --execute="echo Str::random(32);"   # REVERB_APP_SECRET
> php artisan tinker --execute="echo random_int(100000, 999999);"   # REVERB_APP_ID
> ```
> or without `tinker`:
> ```bash
> openssl rand -hex 10   # REVERB_APP_ID
> openssl rand -hex 20   # REVERB_APP_KEY
> openssl rand -hex 32   # REVERB_APP_SECRET
> ```
> No registration is needed anywhere — you only need 3 different values that are random enough for the Reverb client/server to handshake with each other.

> Only fill in `FFMPEG_BINARY`/`FFPROBE_BINARY` if `which ffmpeg`/`which ffprobe` returns nothing (not available in `$PATH`).

**3. Create the database and initialize**

```bash
mysql -u root -p -e "CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
php artisan migrate
php artisan admin:create admin --email=admin@example.com
```
> The `admin:create` command will prompt for a password (input is hidden, minimum 8 characters) — do not pass the password directly on the command line. This command upserts by `username`: running it again with the same username changes that account's password instead of creating a duplicate.

**4. Trial run (dev)** — requires **5 parallel processes** (2 queue workers):

```bash
PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload   # web server (terminal 1)
php artisan queue:work --name=worker-1   # required — without it uploaded chunks are never merged and videos are never transcoded (terminal 2)
php artisan queue:work --name=worker-2   # second worker so a new upload's merge/transcode starts while another video is transcoding (terminal 3)
php artisan schedule:work  # automatic daily cleanup; it still works without it, but junk is not cleaned automatically (terminal 4)
php artisan reverb:start   # live transcode progress display; it still works without it, but you have to reload manually to see progress (terminal 5)
```

Open `http://localhost:8000/login`.

> Merging the uploaded chunks into the original file is done by the queue worker (not by the web request) and shows as stage "Merging chunks" before "Transcoding". Both workers read the `default` queue and each picks up the next job as soon as it is free (pipeline model): with 2 workers up to 2 videos are merged/transcoded in parallel, and a new upload's merge is not stuck behind a single long transcode.

> While merging, the video shows stage "Merging chunks" and still counts as pending; a merge whose worker was killed is marked failed by `videos:cleanup-orphaned-tmp` after `TRANSCODE_ORPHANED_TTL_HOURS`.

> `php artisan serve` runs PHP's built-in server, which handles one request at a time by default. `PHP_CLI_SERVER_WORKERS=4` starts 4 workers, but Laravel only honours it together with `--no-reload` (so restart the command after changing `.env`).

**5. Real production run (replace `php artisan serve` with Nginx + PHP-FPM + systemd)**

Install Nginx + PHP-FPM (change `php8.4-fpm` to match the PHP version you installed; check with `php -v`):

```bash
sudo apt install -y nginx php8.4-fpm
sudo chown -R www-data:www-data storage bootstrap/cache
sudo chmod -R 775 storage bootstrap/cache
```

Create `/etc/nginx/sites-available/hls-r2-studio`:

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
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300s;
    }

    location ~ /\.(?!well-known).* {
        deny all;
    }

    # Reverb needs BOTH paths proxied: /app/ (WebSocket from the client) and /apps/
    # (REST requests the server uses to publish events). Missing /apps/ makes broadcasts
    # fail silently even though the WebSocket looks connected.
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

> Keep `REVERB_SERVER_HOST=127.0.0.1`/`REVERB_SERVER_PORT=8080` unchanged in `.env` (Reverb only binds locally and is not exposed directly); set `REVERB_HOST`/`PORT`/`SCHEME` to your real domain/443/https as in step 2.

Raise the upload limits in `/etc/php/8.4/fpm/php.ini` (matching `UPLOAD_MAX_SIZE_MB=2048`):

```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
```

```bash
sudo systemctl restart php8.4-fpm
sudo ufw allow 80/tcp
```

**Run the 3 background processes with systemd** (replacing the 3 manual terminals in step 4 — `serve` is still replaced by Nginx/PHP-FPM above):

Queue worker — `/etc/systemd/system/hls-r2-studio-queue@.service` (a template, so multiple instances can run):

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

> **Sizing the workers:** each queue worker runs one ffmpeg at a time, and ffmpeg uses all CPU cores by default, so on a small VPS (e.g. 4 vCPU shared with PHP-FPM and MySQL) run 1-2 workers. Cap the encoder with `FFMPEG_THREADS` (about CPU cores / number of workers, e.g. `2`) and keep `FFMPEG_NICE=10` so web requests are served first. Optionally you can instead (or additionally) throttle the whole unit by adding `Nice=10` and `CPUQuota=250%` (example) under `[Service]`; this is not required if `FFMPEG_NICE` is enough. After changing `.env` or config, restart the queue workers (restart commands above) so they pick up the new values.

> `DB_QUEUE_RETRY_AFTER` in `.env` (default `176400`) **must always be greater than** the `--timeout` above (`172800`) — otherwise another worker will pick up a job that is still running, causing duplicate processing.

Reverb (WebSocket) — `/etc/systemd/system/hls-r2-studio-reverb.service` (a single instance, no template):

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

Scheduler (daily cleanup) — `/etc/systemd/system/hls-r2-studio-scheduler.service` (a single instance):

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

To check any service: `sudo systemctl status <service-name>`; to view logs: `sudo journalctl -u <service-name> -f`.

Domain/SSL, updating the R2 CORS configuration for your real domain, and periodic backups still need to be set up on your own.

#### Updating / Redeploying with New Code (Plain VPS)

```bash
cd /path-to-project
git pull
```

| Command | Only needed when |
|---|---|
| `composer install --no-dev` | `composer.json`/`composer.lock` changed |
| `npm install` | `package.json`/`package-lock.json` changed |
| `npm run build` | `resources/css`, `resources/js`, or `.blade.php` files were modified |
| `php artisan migrate --force` | There is a new migration in `database/migrations/` |
| `php artisan config:clear` | A `config/*.php` file changed or a new variable was added to `.env` |
| Restart the queue workers (`sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`) | `app/Jobs/TranscodeVideoJob.php` or the queue-processing code was modified |
| Restart Reverb (`sudo systemctl restart hls-r2-studio-reverb`) | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, or `resources/js/echo.js` was modified |
| Restart the scheduler | Almost never needed, unless `routes/console.php` or a cleanup command in `app/Console/Commands/` was modified |

If you are not sure whether a command is needed, just run them all — it does no harm.

### Deploying with aaPanel

aaPanel manages Nginx + PHP-FPM + SSL on its own — do not run `apt install nginx` or create Nginx configuration yourself as in the plain VPS section above (it will conflict with aaPanel's Nginx).

**1. Put the code on the VPS** — clone into a temporary directory and then rename it (avoids the `destination path '.' already exists` error, since aaPanel often auto-generates a few hidden files in an empty site directory):

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf domain-name.com
mv hls-temp domain-name.com
cd domain-name.com
```

**2. Install the right PHP version** — the project needs PHP `^8.4`. If you don't have it: aaPanel → **App Store** → **PHP** tab → install **PHP-8.4** (it can be installed side by side, no need to remove the old version). From here on, use the full path to make sure you call the right version:

```bash
/www/server/php/84/bin/php -v
```
(if it differs, find the correct version directory number with `ls /www/server/php/`)

**3. Enable the required PHP extensions** — aaPanel → **PHP** → **8.4** → **Install extensions**, enable: `fileinfo` (required; without it `composer install` fails immediately), `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath` → **Restart** PHP 8.4.

**4. Update Composer** (the version preinstalled on many VPSs is too old to run Laravel 13):

```bash
/www/server/php/84/bin/php /usr/bin/composer self-update
```

**5. Install Node.js + FFmpeg** (if not already installed):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs ffmpeg
```

**6. Install dependencies + build assets**

```bash
/www/server/php/84/bin/php /usr/bin/composer install --no-dev
npm install && npm run build
```

**7. Create the database** — aaPanel → **Database** → **Add database** → set a name + create a new user/password, and note them down to fill into `.env`.

**8. Configure `.env`**

```bash
cp .env.example .env
nano .env
```

Fill in (one key per line):

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=hls_r2_studio
DB_USERNAME=<user you just created>
DB_PASSWORD=<password you just created>

R2_ACCESS_KEY_ID=<access key>
R2_SECRET_ACCESS_KEY=<secret key>
R2_BUCKET=<bucket name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_URL=<public video URL>

APP_ENV=production
APP_DEBUG=false
APP_URL=https://your-real-domain
FORCE_HTTPS=true

# Trust only Cloudflare's IP ranges for X-Forwarded-For (site proxied by Cloudflare); otherwise set your proxy IP
TRUSTED_PROXIES=cloudflare

# Cache and rate-limit counters in Redis, falling back to the database if Redis is down (see "Redis (cache and rate limiting)" above)
CACHE_STORE=failover
REDIS_CLIENT=phpredis

# Run ffmpeg at low CPU priority so the web app stays responsive (0 disables); optional encoder thread limit per job
FFMPEG_NICE=10
# FFMPEG_THREADS=2

REVERB_APP_ID=<random number>
REVERB_APP_KEY=<random string>
REVERB_APP_SECRET=<random string>
REVERB_HOST=your-real-domain
REVERB_PORT=443
REVERB_SCHEME=https
```

> Generate the 3 values above using one of these 2 methods:
> ```bash
> /www/server/php/84/bin/php artisan tinker --execute="echo Str::random(20);"   # REVERB_APP_KEY
> /www/server/php/84/bin/php artisan tinker --execute="echo Str::random(32);"   # REVERB_APP_SECRET
> /www/server/php/84/bin/php artisan tinker --execute="echo random_int(100000, 999999);"   # REVERB_APP_ID
> ```
> or without `tinker`:
> ```bash
> openssl rand -hex 10   # REVERB_APP_ID
> openssl rand -hex 20   # REVERB_APP_KEY
> openssl rand -hex 32   # REVERB_APP_SECRET
> ```
> No registration is needed anywhere — you only need 3 different values that are random enough for the Reverb client/server to handshake with each other.

**9. Generate the key, create the tables, create the admin**

```bash
/www/server/php/84/bin/php artisan key:generate
/www/server/php/84/bin/php artisan migrate --force
/www/server/php/84/bin/php artisan admin:create admin --email=admin@example.com
```

**10. Set directory permissions** (`www` is aaPanel's default PHP-FPM user — check with `ps aux | grep php-fpm` if your VPS uses a different user):

```bash
chown -R www:www storage bootstrap/cache
chmod -R 775 storage bootstrap/cache
```

**11. Create the website in aaPanel** — **Website** tab → **Add site** → enter the domain → choose **PHP 8.4** → set **Document Root** to `.../public` (not the project root directory). If the site already existed before cloning, go to the site → **Directory** → confirm that **Site directory** points to `.../public`.

**12. Turn off "Anti-XSS attack" (open_basedir)** — site → **Directory** → turn off the **Anti-XSS attack** toggle. Leaving this toggle on restricts PHP to reading only `public/`, which causes a blank page with the error `open_basedir restriction in effect`, because the actual Laravel code (`vendor/`, `storage/`...) lives in the parent directory.

**13. Enable URL rewrite** (without this step every page other than the home page returns `404`) — site → **URL rewrite** (伪静态) → choose the **Laravel5**/**Laravel** template. If it is not available, choose **Custom** and paste:

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

**14. Raise the upload limits** — aaPanel → **PHP** → **8.4** → **Configuration file**:

```ini
upload_max_filesize = 2048M
post_max_size = 2048M
max_execution_time = 300
memory_limit = 512M
```

**15. Enable SSL** — site → **SSL** tab → **Let's Encrypt** → tick the domain → **Apply** (certificates are requested and renewed automatically).

**16. Run the queue worker with systemd** (required — aaPanel does NOT manage this for you):

```bash
nano /etc/systemd/system/hls-r2-studio-queue@.service
```

```ini
[Unit]
Description=HLS R2 Studio Queue Worker #%i
After=network.target mysql.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/domain-name.com
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

> **Sizing the workers:** each queue worker runs one ffmpeg at a time, and ffmpeg uses all CPU cores by default, so on a small VPS (e.g. 4 vCPU shared with PHP-FPM and MySQL) run 1-2 workers. Cap the encoder with `FFMPEG_THREADS` (about CPU cores / number of workers, e.g. `2`) and keep `FFMPEG_NICE=10` so web requests are served first. Optionally you can instead (or additionally) throttle the whole unit by adding `Nice=10` and `CPUQuota=250%` (example) under `[Service]`; this is not required if `FFMPEG_NICE` is enough. After changing `.env` or config, restart the queue workers (`systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`) so they pick up the new values.

> `--timeout=172800` (48 hours) matches the real job timeout in the code (an x8 multiplier on video length, see `TRANSCODE_TIMEOUT_MULTIPLIER` in the [Q&A section](TROUBLESHOOTING.md#common-errors-fixes-and-qa)). `DB_QUEUE_RETRY_AFTER` in `.env` (`176400`) must always be greater than this value.

**17. Run Reverb (WebSocket) with systemd**:

```bash
nano /etc/systemd/system/hls-r2-studio-reverb.service
```

```ini
[Unit]
Description=HLS R2 Studio Reverb (WebSocket)
After=network.target

[Service]
User=www
WorkingDirectory=/www/wwwroot/domain-name.com
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

Open the site → **Config File** (配置文件) tab → add the following inside the existing `server { }` (identical to the block in the plain VPS section) — Reverb needs BOTH `/app/` (WebSocket) and `/apps/` (REST event publishing) proxied; missing `/apps/` makes broadcasts fail silently even though the WebSocket still looks connected:

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

Save — aaPanel reloads Nginx automatically, and the SSL certificate enabled in step 15 is reused as-is.

**18. Run the scheduler with systemd** (a single instance, no `@` template):

```bash
nano /etc/systemd/system/hls-r2-studio-scheduler.service
```

```ini
[Unit]
Description=HLS R2 Studio Scheduler
After=network.target mysql.service

[Service]
User=www
WorkingDirectory=/www/wwwroot/domain-name.com
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

**19. Verify** — open `https://your-real-domain/login`, log in with the admin account you just created, and try uploading a short video to confirm the whole pipeline works (upload → transcode → upload to R2 → HLS playback).

#### Updating / Redeploying with New Code (aaPanel)

```bash
cd /www/wwwroot/domain-name.com
git pull
```

| Command | Only needed when |
|---|---|
| `/www/server/php/84/bin/php /usr/bin/composer install --no-dev` | `composer.json`/`composer.lock` changed |
| `npm install` | `package.json`/`package-lock.json` changed |
| `npm run build` | `resources/css`, `resources/js`, or `.blade.php` files were modified |
| `/www/server/php/84/bin/php artisan migrate --force` | There is a new migration in `database/migrations/` |
| `/www/server/php/84/bin/php artisan config:clear` | A `config/*.php` file changed or a new variable was added to `.env` |
| Restart the queue workers (`systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2`) | `app/Jobs/TranscodeVideoJob.php` or the queue-processing code was modified |
| Restart Reverb (`systemctl restart hls-r2-studio-reverb`) | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, or `resources/js/echo.js` was modified |
| Restart the scheduler | Almost never needed, unless `routes/console.php` or a cleanup command was modified |

If you are not sure whether a command is needed, just run them all — it does no harm.

## Cloudflare and R2 setup checklist (before going live)

These are manual steps in the Cloudflare and R2 dashboards; the code does not do them. UI labels can differ between dashboard versions, so check each item against the dashboard. Items marked "(verify)" were not verified against Cloudflare's documentation.

Placeholders: `embed.example.com` = domain serving this app and the embed pages, `cdn.example.com` = R2 public custom domain used as `R2_URL`, `www.example.com` = the WordPress site.

1. **SSL/TLS mode Full (strict) and Always Use HTTPS** for the domains. Why: avoids redirect loops and unencrypted hops to the origin; the app already sets `FORCE_HTTPS`.
2. **`.env` on the VPS**: `TRUSTED_PROXIES=cloudflare`, `CACHE_STORE=failover` with Redis installed (see [Redis](#redis-cache-and-rate-limiting)), and `FFMPEG_NICE` / `FFMPEG_THREADS` (see the `.env` example in the [Plain VPS](#plain-vps-installation-no-panel) section). Then run `php artisan config:clear` and restart the queue workers. Why: real client IPs for throttling, shared rate-limit counters, and a responsive web app during transcoding.
3. **Cache Rule for the embed page** (Rules → Cache Rules): when hostname equals `embed.example.com` and URI path starts with `/embed/` → Cache eligibility **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**. Why: Cloudflare does not cache HTML by default, and the app already sends `Cache-Control: public, max-age=60, s-maxage=300` without cookies. Consequence: allowlist changes or video deletion can take up to 5 minutes to show on the cached page (1 minute in browsers).
4. **Cache Rule for the R2 domain**: hostname equals `cdn.example.com` → **Eligible for cache**; Edge TTL **Ignore cache-control header and use this TTL** = **1 day**; Browser TTL **Override** with **1 hour** (recommended; "Respect origin" also works). Why: `.m3u8` and `.ts` are not cached by Cloudflare by default (only listed extensions such as `.jpg`), so every segment would hit R2. Note: a deleted or taken-down video can still be served from the edge cache for up to the TTL; on the free plan purge works per URL only.
5. **Do not challenge iframe traffic**: if viewers see Cloudflare challenge pages or blank frames inside the iframe, add a WAF custom rule with action **Skip** for URI path starts with `/embed/` (and for the R2 domain), or lower the security level for them. Why: iframes cannot solve challenges (verify).
6. **Hotlink rule for the R2 domain** (Security → WAF → Custom rules, action **Block**), expression (verify the syntax in the dashboard):
   ```
   (http.host eq "cdn.example.com" and http.referer ne "" and not http.referer contains "embed.example.com")
   ```
   - Requests with an **empty Referer must stay allowed**: Safari/iOS native HLS playback usually sends no Referer, so blocking empty referers breaks iPhone playback.
   - This only stops other websites' players, not scripts that send no Referer.
   - After enabling it, test playback on an iPhone and a desktop browser.
7. **R2 bucket CORS** (R2 → bucket → Settings → CORS policy) allowing the embed origin to GET the HLS files (verify the format in the dashboard):
   ```json
   [{"AllowedOrigins":["https://embed.example.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
   `R2_URL` must be the custom domain, not `r2.dev` (rate limited and not for production). Why: the player fetches playlists and segments cross-origin.
8. **Embed allowlist in the app**: Settings → Embed protection → add `www.example.com` (and `*.example.com` if needed); empty means any site can frame the player. Also set `CORS_ALLOWED_ORIGINS` / `REPORT_ALLOWED_HOSTS` for the report API (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa)).
9. **Optional: only accept web traffic from Cloudflare** on the VPS firewall (verify). Why: stops attackers bypassing Cloudflare by hitting the origin IP directly. Plain VPS with ufw: remove the generic rule, then allow Cloudflare's published ranges (keep SSH allowed):
   ```bash
   sudo ufw delete allow 80/tcp
   for ip in $(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6); do sudo ufw allow from "$ip" to any port 80,443 proto tcp; done
   ```
   Verify the site still loads afterwards. The ranges change rarely; re-run occasionally. On aaPanel use the panel firewall instead.
10. **Smoke test** after going live:
    - `curl -sI https://embed.example.com/embed/<id>` shows no `Set-Cookie`, `Cache-Control: public, max-age=60, s-maxage=300`, `X-Robots-Tag: noindex, nofollow`, and (on the second request) `cf-cache-status: HIT`.
    - Play a video on desktop and on iPhone.
    - The login page still works and throttling counts per real IP.
    - `curl -sI https://embed.example.com/login` shows `x-robots-tag: noindex, nofollow, noarchive`.
11. **Remove already-indexed pages from Google**: the app sends `X-Robots-Tag: noindex, nofollow, noarchive` on every response (the embed page keeps its own `noindex, nofollow`), and the login and app layouts also carry a `robots` meta tag.
    - Keep `robots.txt` open. Do **not** add `Disallow: /`: Google must be able to fetch the pages to see the noindex, otherwise it keeps the URLs listed.
    - To speed up removal, verify domain ownership in Google Search Console, then Removals → New request (temporary removal) for the site URLs. Otherwise Google drops them on its next crawl (days to weeks).
    - Check with `curl -sI https://embed.example.com/login`: the `x-robots-tag` header must be present.
