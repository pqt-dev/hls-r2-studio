> English | [Tiếng Việt](DEPLOYMENT.vi.md)

# Deployment Guide

> Back to the [README](../README.md). Local development is in the README; errors, Q&A and data structure are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

From a fresh VPS to a live, Cloudflare-fronted install, in order. The main flow uses aaPanel; a plain VPS is in the [appendix](#appendix-plain-vps-no-aapanel). UI labels and some dashboard options differ between aaPanel/Cloudflare versions; check them on the real screen. Never paste keys, tokens, `.env` contents or the private key into tickets or chat.

| Placeholder | Meaning |
|---|---|
| `embed-site.com` | App and embed domain (this server) |
| `cdn.embed-site.com` | R2 public custom domain (= `R2_URL`) |
| `main-site.com` | WordPress site that embeds the player (may answer on both `main-site.com` and `www.main-site.com`; both go into the Embed allowlist) |
| `<git-repo-url>` | Your repository URL |

aaPanel values used below: dashboard dir `/www/wwwroot/embed-site.com`, PHP CLI `/www/server/php/84/bin/php`, user `www`. Work in a root shell (`sudo -i`), so no `sudo` is needed.

## Choose your path

- Server already runs aaPanel: follow this guide; never add the plain stack (`apt install nginx`, `ufw`) next to it.
- Clean Ubuntu/Debian VPS without a panel: use the [appendix](#appendix-plain-vps-no-aapanel); never install aaPanel over a hand-configured server.

## Go-live runbook (in order)

| # | Step | Section |
|---|---|---|
| 0 | Accounts: Cloudflare, VPS size, R2 bucket + token + custom domain, Origin certificate | [0](#0-prerequisites-and-accounts) |
| 1 | Server software: PHP 8.4, Composer, Node 22, FFmpeg | [1](#1-server-software) |
| 2 | Database and dedicated user | [2](#2-database) |
| 3 | Redis | [3](#3-redis) |
| 4 | Get the code, `composer install` | [4](#4-get-the-code-and-install-php-dependencies) |
| 5 | Create and fully fill `.env` | [5](#5-configure-env) |
| 6 | `key:generate`, `migrate --force`, `admin:create` | [6](#6-app-key-database-tables-admin-user) |
| 7 | `npm ci`, `npm run build` (after `.env`) | [7](#7-build-the-frontend-assets) |
| 8 | File permissions (after every root-run artisan command) | [8](#8-file-permissions) |
| 9 | Web server, upload limits, Origin certificate | [9](#9-web-server-and-ssl) |
| 10 | Queue, Reverb and scheduler services | [10](#10-background-services) |
| 11 | Cloudflare: WebSockets, Full (strict), rules | [11](#11-cloudflare-settings) |
| 12 | Embed allowlist, smoke tests, Google cleanup | [12](#12-app-settings-smoke-tests-google-cleanup) |

After go-live: [Updating](#updating--redeploying-with-new-code), [Operations](#operations), [Troubleshooting pointers](#troubleshooting-pointers).

## 0. Prerequisites and accounts

VPS: 2 vCPU / 4 GB minimum, 4 vCPU / 8 GB recommended; disk about 2x the largest video times concurrent uploads, plus OS (uploads are rejected below 2x file size + 256 MB free).

1. Add the domain to Cloudflare. DNS: `A` `embed-site.com` to the VPS IP, **Proxied**. Leave SSL/TLS mode unchanged until section 11.
2. R2: create the bucket, connect the custom domain `cdn.embed-site.com` (Settings > Custom Domains). `R2_URL` must be this domain, never `r2.dev`.
3. R2 > Manage API tokens: **Object Read & Write** token limited to this bucket. Note the Access Key ID, Secret Access Key and S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. SSL/TLS > Origin Server > Create Certificate: **RSA**, hostname `embed-site.com`, 15 years. Copy the certificate and private key now (the key is shown once); install them in section 9.
5. Know your WordPress origin(s): the site may answer on both `main-site.com` and `www.main-site.com` (both go into the Embed allowlist, section 12).

## 1. Server software

1. App Store > PHP: install **PHP-8.4** (find the path with `ls /www/server/php/` if it differs).
2. PHP > 8.4 > Install extensions: enable `fileinfo`, `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath`, `redis`, then restart PHP 8.4 (`pcntl` is required for the queue `--timeout`).
3. Update Composer (the preinstalled one is often too old), then install Node 22 LTS, FFmpeg and git (Debian/Ubuntu):

   ```bash
   /www/server/php/84/bin/php /usr/bin/composer self-update
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt install -y nodejs ffmpeg git unzip
   ```
4. Verify:

   ```bash
   /www/server/php/84/bin/php -v
   /www/server/php/84/bin/php -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
   node -v
   ffmpeg -version
   ffprobe -version
   ffmpeg -encoders | grep libx264
   ```

Expect PHP 8.4+, all four extensions listed, Node `^20.19.0 || >=22.12.0` (use 22 LTS), `libx264` listed, Composer 2.2+ (`composer -V`). The build needs outbound internet (Vite downloads a font).

## 2. Database

Needs **MySQL 8.0.16+ or MariaDB 10.6+** (the migrations use enforced `CHECK`, a `STORED` column with `SHA2()`, a prefix index; utf8mb4). aaPanel > Database > Add database: name `hls_r2_studio`, charset utf8mb4, a dedicated user and strong password (access: local). Never use `root` in `.env`.

## 3. Redis

App Store: install **Redis**, listening on `127.0.0.1`, started on boot; if you set a password, use it in `REDIS_PASSWORD`. It holds rate-limit counters, Activity Log dedup keys and scheduler locks; with `CACHE_STORE=failover` the app falls back to the database cache if Redis is down.

## 4. Get the code and install PHP dependencies

Clone into a temp directory and move it into place (cloning into the panel-created directory fails: `destination path '.' already exists`). `rm -rf` deletes the target: run it only if it holds nothing but panel-generated files.

```bash
cd /www/wwwroot
git clone <git-repo-url> hls-temp
rm -rf embed-site.com
mv hls-temp embed-site.com
cd embed-site.com
/www/server/php/84/bin/php /usr/bin/composer install --no-dev -o
```

## 5. Configure `.env`

Sections 4-8 run from `/www/wwwroot/embed-site.com`. **Fill `.env` completely before sections 6 and 7.** `.env.example` has development defaults (`APP_ENV=local`, `DB_HOST=mysql`, `REVERB_HOST=localhost`, ...): change every key below; leave `APP_KEY` empty and keep other keys at their defaults.

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

`CORS_ALLOWED_ORIGINS` and `REPORT_ALLOWED_HOSTS` are optional extras (default empty); the main site domains go in the Embed allowlist (section 12).

Generate the Reverb values with `openssl rand -hex 10` (`REVERB_APP_ID`), `openssl rand -hex 20` (`REVERB_APP_KEY`), `openssl rand -hex 32` (`REVERB_APP_SECRET`). `FFMPEG_THREADS` is about CPU cores / workers. Set `FFMPEG_BINARY`/`FFPROBE_BINARY` only if `which ffmpeg`/`which ffprobe` returns nothing.

- **Redis failover is silent:** a wrong Redis setting is NOT an error, the app just uses the database cache. Always run the Redis check in section 6. No Redis: `CACHE_STORE=database` and drop `REDIS_*`.
- **Any later `REVERB_*` change needs `npm run build` again:** the values are baked into the JavaScript, and a build with the defaults ships `localhost:8080` to browsers (live progress silently breaks).
- After every `.env` edit run `/www/server/php/84/bin/php artisan config:clear` and restart the services (section 10); they keep the config in memory.

## 6. App key, database tables, admin user

```bash
/www/server/php/84/bin/php artisan key:generate
/www/server/php/84/bin/php artisan migrate --force
/www/server/php/84/bin/php artisan admin:create admin --email=admin@example.com
```

- `--force` is mandatory in production. `admin:create` prompts for a hidden password (min 8); running it again for the same username resets the password.
- Redis check (skip if `CACHE_STORE=database`): the first prints `pong`, the second must list keys (`REDIS_CACHE_DB` defaults to 1, hence `-n 1`). Empty means the app is NOT using Redis: check `REDIS_*`, the PHP extension and `redis-cli ping`.

  ```bash
  /www/server/php/84/bin/php artisan tinker --execute="Cache::put('ping','pong',60); echo Cache::get('ping');"
  redis-cli -n 1 keys '*'
  ```

## 7. Build the frontend assets

Only after `.env` is final. Needs Node 22 and outbound internet.

```bash
npm ci
npm run build
```

## 8. File permissions

Root-run artisan can create root-owned files in `storage/` that PHP-FPM cannot write (HTTP 500). Run this at the end of every install and update, after all root-run artisan commands. If unsure that `www` is the PHP-FPM user, check with `ps aux | grep php-fpm`.

```bash
chown -R www:www storage bootstrap/cache
chmod -R 775 storage bootstrap/cache
chown root:www .env
chmod 640 .env
```

## 9. Web server and SSL

Install the **Origin certificate on the origin first**, and only then set Cloudflare to Full (strict) (section 11), or you get 521/526. Uploads are chunked, so each limit only has to exceed `UPLOAD_CHUNK_SIZE_MB`.

| Setting | Value |
|---|---|
| Nginx `client_max_body_size` | `100m` |
| php.ini `upload_max_filesize` | `100M` |
| php.ini `post_max_size` | `100M` |
| php.ini `max_execution_time` | `300` |
| php.ini `memory_limit` | `512M` |

aaPanel owns Nginx; do not run `apt install nginx`.

1. **Website > Add site**: domain `embed-site.com`, PHP **8.4**, site directory `/www/wwwroot/embed-site.com/public` (not the project root).
2. Site > **Directory**: turn **off** "Anti-XSS attack" (open_basedir), or you get a blank page with `open_basedir restriction in effect`.
3. Site > **URL rewrite**: template **Laravel** (Laravel5), or every page except `/` is 404. If missing, choose Custom:

   ```nginx
   location / {
       try_files $uri $uri/ /index.php?$query_string;
   }
   ```
4. PHP > 8.4 > **Configuration file**: set the php.ini values from the table, restart PHP 8.4.
5. Site > **Config File**: inside the existing `server { }` add the lines below (aaPanel's global `client_max_body_size` may be lower). Reverb needs BOTH `/app/` (WebSocket) and `/apps/` (event publishing); without `/apps/` broadcasts fail silently.

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
6. Site > **SSL** > "Other certificate" tab `(verify label)`: paste the Origin certificate and private key. Use it instead of Let's Encrypt (HTTP-01 can fail behind the orange cloud).
7. aaPanel > Security: allow 80, 443 and your SSH port; never open 8080, 3306 or 6379. No `ufw` here.

## 10. Background services

Three long-running processes, not managed by aaPanel. `After=` is ordering only; units missing on your system are ignored.

Queue worker, `/etc/systemd/system/hls-r2-studio-queue@.service` (template, so several instances can run):

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

Scheduler (daily cleanup), `/etc/systemd/system/hls-r2-studio-scheduler.service`:

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

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now hls-r2-studio-queue@1 hls-r2-studio-queue@2
systemctl enable --now hls-r2-studio-reverb hls-r2-studio-scheduler
```

- `--timeout=172800` (48 h) matches the job timeout (`TRANSCODE_TIMEOUT_MULTIPLIER`, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa)); `DB_QUEUE_RETRY_AFTER` must stay greater, and without `--timeout` Laravel kills jobs after 60 s.
- Each worker runs one ffmpeg that uses all cores: on a small VPS run 1-2 workers, set `FFMPEG_THREADS` to about cores / workers and keep `FFMPEG_NICE=10`.

## 11. Cloudflare settings

After the origin works over HTTPS (section 9).

1. **WebSockets**: `embed-site.com` is Proxied (section 0); Network > **WebSockets** on (default).
2. **SSL/TLS > Overview**: **Full (strict)**, only after the Origin certificate is installed. Edge Certificates: **Always Use HTTPS** on.
3. **Cache Rule, embed page** (Rules > Cache Rules): hostname equals `embed-site.com` and URI path starts with `/embed/` > **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**. The app sends `Cache-Control: public, max-age=60, s-maxage=300` with no cookies; allowlist changes or a video deletion can take up to 5 minutes to show.
4. **Cache Rule, R2 domain**: hostname equals `cdn.embed-site.com` > **Eligible for cache**; Edge TTL **Ignore cache-control header and use this TTL** = **1 day**; Browser TTL **Override origin and use this TTL** = **2 hours** (smallest on Free; "Respect origin" also works). A deleted video can stay on the edge up to the TTL; Free purge is per URL only.
5. **Do not challenge iframe or Reverb traffic**: WAF custom rule, action **Skip**, for URI path starts with `/embed/`, `/apps/` or `/app/` (and the R2 domain). The VPS publishes events to `https://embed-site.com:443/apps/...` through Cloudflare. Under Attack mode and Bot Fight Mode can still block them, and Bot Fight Mode cannot be skipped by WAF rules `(verify)`: if live progress stops while the WebSocket connects, turn them off for the zone.
6. **Hotlink rule, R2 domain** (Security > WAF > Custom rules, action **Block**), expression `(verify the syntax in the dashboard)`. An **empty Referer must stay allowed** (Safari/iOS native HLS sends none); test on an iPhone and a desktop browser.

   ```
   (http.host eq "cdn.embed-site.com" and http.referer ne "" and not http.referer contains "embed-site.com")
   ```
7. **R2 bucket CORS** (R2 > bucket > Settings > CORS policy) `(verify the format in the dashboard)`:

   ```json
   [{"AllowedOrigins":["https://embed-site.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
8. **Optional hardening**: in the aaPanel firewall allow web ports only from Cloudflare's ranges (`https://www.cloudflare.com/ips-v4`, `ips-v6`) and check the site still loads. Plain VPS: see the [appendix](#appendix-plain-vps-no-aapanel).

## 12. App settings, smoke tests, Google cleanup

1. **Embed allowlist**: log in at `https://embed-site.com/login` > Settings > **Embed protection** > Embed allowlist: add `main-site.com` and `www.main-site.com` (one per line; `*.main-site.com` and `https://host:port` accepted). The same list also lets those sites send playback reports (CORS) and sets the accepted report hosts (if it is empty, any website can frame the player and any report host is accepted; otherwise reports are accepted only from listed hosts). It is stored in the database: no `.env` edit, `config:clear` or restart needed (cached embed pages can take up to 5 minutes to update). The app's own site is always allowed.
2. **Smoke tests**:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://embed-site.com/up
   curl -sI https://embed-site.com/login
   curl -sI https://embed-site.com/embed/<video-id>
   ```
   - `/up` is 200; `/login` has `x-robots-tag: noindex, nofollow, noarchive`.
   - `/embed/<video-id>` (needs a ready video): no `Set-Cookie`, `Cache-Control: public, max-age=60, s-maxage=300`, and `cf-cache-status: HIT` on the second request.
   - Upload a short video: stages complete and progress moves live (`wss://embed-site.com/app/...` status 101 in dev tools, which also proves `/apps/` through Cloudflare). Play the embed on desktop and iPhone.
   - 6 wrong logins in a row give HTTP 429 on the 6th (5 per minute per IP).
3. **Google**: every response carries `X-Robots-Tag: noindex, nofollow, noarchive`.
   - Keep `robots.txt` open; do **not** add `Disallow: /` (Google must fetch pages to see the noindex).
   - To speed up removal: Google Search Console > Removals > New request; otherwise it takes days to weeks.

## Updating / redeploying with new code

```bash
cd /www/wwwroot/embed-site.com
git pull
```

Then, in this order, only what the change needs (if unsure, run them all). Any `.env` or `config/*.php` change needs `config:clear` AND a restart of queue workers, Reverb and scheduler.

| Command | Only needed when |
|---|---|
| `/www/server/php/84/bin/php /usr/bin/composer install --no-dev -o` | `composer.json` / `composer.lock` changed |
| `npm ci` | `package.json` / `package-lock.json` changed |
| `npm run build` | `resources/css`, `resources/js`, any `.blade.php`, or any `REVERB_*` value changed |
| `/www/server/php/84/bin/php artisan migrate --force` | New migration in `database/migrations/` |
| `/www/server/php/84/bin/php artisan config:clear` | A `config/*.php` file or `.env` changed |
| Restart the **queue workers**: `systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2` | `app/Jobs/TranscodeVideoJob.php` or queue-processing code, `app/Services/*`, `app/Support/FfmpegCommand.php`, `config/videos.php` or `config/services.php` changed |
| Restart **Reverb**: `systemctl restart hls-r2-studio-reverb` | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` or any `REVERB_*` value changed |
| Restart the **scheduler**: `systemctl restart hls-r2-studio-scheduler` | `routes/console.php` or `app/Console/Commands/*` changed |
| Restart **PHP-FPM**: restart PHP 8.4 in the panel | `php.ini` changed |
| `chown -R www:www storage bootstrap/cache` and `chmod -R 775 storage bootstrap/cache` | **Always, last** |

A queue restart interrupts the video being transcoded (`--tries=1`, no retry); restart when none is processing, or use `/www/server/php/84/bin/php artisan queue:restart` (workers exit after their current job and systemd restarts them).

## Operations

| Task | Command |
|---|---|
| Service status | `systemctl status hls-r2-studio-queue@1 hls-r2-studio-reverb hls-r2-studio-scheduler` |
| Service logs | `journalctl -u hls-r2-studio-queue@1 -f` (same for `hls-r2-studio-reverb`, `hls-r2-studio-scheduler`) |
| App log | `/www/wwwroot/embed-site.com/storage/logs/laravel-YYYY-MM-DD.log` (daily, 14 days kept) |
| Health | `curl -s -o /dev/null -w "%{http_code}\n" https://embed-site.com/up` (expect 200) |
| Redis | `redis-cli ping` (expect `PONG`) |
| Disk | Shown in the dashboard; uploads are rejected below 2x file size + 256 MB free |

The scheduler runs the daily cleanup; to run one by hand use the site user, e.g. `sudo -u www /www/server/php/84/bin/php artisan uploads:cleanup-abandoned`. The three commands: `uploads:cleanup-abandoned`, `videos:cleanup-orphaned-tmp`, `videos:cleanup-orphaned-uploads`.

**Backups.** Videos live on R2; back up the database daily and keep copies off the server. Put credentials in `/root/.my.cnf` (`chmod 600`):

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

Keep an off-server copy of `.env` and the Origin private key in a password manager, never in the repository.

## Troubleshooting pointers

Full table and Q&A: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa). Deployment-specific:

| Symptom | Likely cause |
|---|---|
| Cloudflare 521 / 526 | Origin not on 443 or Origin certificate missing (section 9) while SSL mode is Full (strict) |
| HTTP 500 after install or update | Root-owned files in `storage/` (section 8) |
| Live progress never updates, console shows `localhost:8080` | Built before `.env` had the final `REVERB_*`: fix `.env`, run `npm run build` |
| WebSocket connects but updates never arrive (`Pusher error: 404`) | Nginx lacks `location /apps/`, or a Cloudflare rule blocks VPS > Cloudflare > `/apps/` |
| Reports from the main site fail with a CORS error or "The page URL host is not allowed" | The domain is missing from the Embed allowlist (section 12) |
| Upload fails with 413 | `client_max_body_size` or Cloudflare's body cap is below `UPLOAD_CHUNK_SIZE_MB` |
| Blank page `open_basedir restriction in effect` | "Anti-XSS attack" still on (section 9) |
| Everything except `/` is 404 | URL rewrite not enabled (section 9) |
| Video stuck on "Processing", log has `Job timed out` | Queue worker lacks `--timeout=172800` |

## Appendix: Plain VPS (no aaPanel)

Clean Ubuntu/Debian only; everything not listed is the same as the main flow. Run as root or with `sudo`. Substitute in the main flow:

| Item | aaPanel (main flow) | Plain VPS |
|---|---|---|
| Dashboard dir | `/www/wwwroot/embed-site.com` | `/var/www/hls-r2-studio` |
| PHP CLI | `/www/server/php/84/bin/php` | `php` (`/usr/bin/php8.4` in unit files) |
| User | `www` | `www-data` |
| Composer | `.../php /usr/bin/composer ...` | `composer ...` |
| Restart PHP-FPM | in the panel | `systemctl restart php8.4-fpm` |

Software (PHP 8.4 needs the PPA; Debian: use the sury repository). If `php -v` is not 8.4: `update-alternatives --set php /usr/bin/php8.4`.

```bash
apt update && apt install -y software-properties-common git unzip curl
add-apt-repository -y ppa:ondrej/php
apt update
apt install -y php8.4-cli php8.4-fpm php8.4-mysql php8.4-mbstring php8.4-curl php8.4-xml php8.4-bcmath php8.4-redis nginx ffmpeg mysql-server redis-server
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
```

Database: `mysql` (Debian: `mariadb-server`), then at the prompt run the SQL below. Redis: in `/etc/redis/redis.conf` set `bind 127.0.0.1 ::1`, `maxmemory 256mb`, `maxmemory-policy allkeys-lru`, then `systemctl enable --now redis-server`. Never open 3306, 6379 or 8080.

```sql
CREATE DATABASE hls_r2_studio CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hls_app'@'127.0.0.1' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON hls_r2_studio.* TO 'hls_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Code goes to `/var/www/hls-r2-studio` (`git clone <git-repo-url> hls-r2-studio` in `/var/www`). Origin certificate files (root-owned, key `chmod 600`):

```bash
mkdir -p /etc/ssl/cloudflare
# paste into /etc/ssl/cloudflare/embed-site.com.pem and embed-site.com.key
chmod 600 /etc/ssl/cloudflare/embed-site.com.key
```

Nginx, `/etc/nginx/sites-available/hls-r2-studio` (PHP limits: edit `/etc/php/8.4/fpm/php.ini` with the section 9 table):

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

Enable the site and the basic firewall (**allow SSH first**, or `ufw enable` locks you out):

```bash
ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Optional Cloudflare-only hardening (section 11 step 8); verify the site still loads afterwards:

```bash
ufw delete allow 80/tcp
ufw delete allow 443/tcp
for ip in $(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6); do ufw allow from "$ip" to any port 80,443 proto tcp; done
```
