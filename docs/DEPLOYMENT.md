> English | [Tiếng Việt](DEPLOYMENT.vi.md)

# Deployment Guide

> Back to the [README](../README.md). Local development is in the README; errors, Q&A and data structure are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

This guide takes a fresh VPS to a live, Cloudflare-fronted install, in order. The application behaviour comes from this repository; the infrastructure steps (apt, Nginx, aaPanel UI, Cloudflare dashboard) are environment-specific, and anything not verified against the repo or vendor docs is marked `(verify)`. UI labels change between aaPanel and Cloudflare versions.

**Placeholders** (used everywhere below):

| Placeholder | Meaning | Plain VPS | aaPanel |
|---|---|---|---|
| `embed.example.com` | App and embed domain (this server) | same | same |
| `cdn.example.com` | R2 public custom domain (= `R2_URL`) | same | same |
| `www.example.com` | The WordPress site that embeds the player | same | same |
| `<APP_DIR>` | Project directory | `/var/www/hls-r2-studio` | `/www/wwwroot/embed.example.com` |
| `<PHP>` | PHP CLI to run `artisan` and `composer` with | `php` | `/www/server/php/84/bin/php` |
| `<USER>` | Service user (PHP-FPM, queue, Reverb, scheduler) | `www-data` | `www` |
| `<git-repo-url>` | Your repository URL | same | same |

Open a root shell first (`sudo -i`); every command in this guide assumes root (the `sudo` prefixes are harmless as root). A non-root deploy user (owning `<APP_DIR>`) is not covered here.

## Choose your path

| Your server | Use |
|---|---|
| Already runs aaPanel | **Path A: aaPanel**. Never use the plain path on the same server. |
| Clean VPS, nothing installed (Ubuntu/Debian) | **Path B: Plain VPS** |

Why not mix them:

- aaPanel already owns Nginx (ports 80/443), PHP (`/www/server/php/84`, its own `php.ini`, extensions and FPM user `www`), MySQL (3306), Redis (App Store), SSL, the firewall and the website configs.
- `apt install nginx php8.4-fpm` on an aaPanel server creates a second Nginx fighting for ports 80/443 and a different PHP CLI and `php.ini`. `ufw` conflicts with the panel firewall. aaPanel regenerates or ignores hand-edited `/etc/nginx` files (verify).
- The reverse also holds: installing aaPanel on a server already configured by hand overwrites its Nginx/PHP setup (verify).

What aaPanel manages (Path A): Nginx, PHP versions/extensions/`php.ini`, MySQL/MariaDB, Redis, sites/SSL/rewrite, firewall, cron, file manager.
What it does **not** manage for this app: queue workers, Reverb, scheduler (use systemd units, section 10), Node.js, FFmpeg, Composer updates, the app `.env`, Cloudflare/R2.

## Go-live runbook (in order)

| # | Step | Section |
|---|---|---|
| 0 | Accounts: domain on Cloudflare, VPS sizing, R2 bucket + token + custom domain, Origin certificate, WordPress domains | [0](#0-prerequisites-and-accounts) |
| 1 | Server software: PHP 8.4, Composer, Node 22, FFmpeg, Nginx (plain) | [1](#1-server-software) |
| 2 | Database: MySQL/MariaDB, dedicated user | [2](#2-database) |
| 3 | Redis (cache and rate limiting) | [3](#3-redis) |
| 4 | Get the code, `composer install` | [4](#4-get-the-code-and-install-php-dependencies) |
| 5 | Create and fully fill `.env` | [5](#5-configure-env) |
| 6 | `key:generate`, `migrate --force`, `admin:create` | [6](#6-app-key-database-tables-admin-user) |
| 7 | `npm ci`, `npm run build` (after `.env`!) | [7](#7-build-the-frontend-assets) |
| 8 | File permissions (after every root-run artisan command) | [8](#8-file-permissions) |
| 9 | Web server, upload limits, Origin certificate (SSL) | [9](#9-web-server-and-ssl) |
| 10 | Background services: queue, Reverb, scheduler | [10](#10-background-services) |
| 11 | Cloudflare: proxied DNS, WebSockets, SSL Full (strict), rules | [11](#11-cloudflare-settings) |
| 12 | App Settings (embed allowlist), smoke tests, Google cleanup | [12](#12-app-settings-smoke-tests-google-cleanup) |

After go-live: [Updating](#updating--redeploying-with-new-code), [Operations](#operations), [Troubleshooting pointers](#troubleshooting-pointers).

## 0. Prerequisites and accounts

**VPS sizing**

| | CPU / RAM | Disk |
|---|---|---|
| Minimum | 2 vCPU / 4 GB | about 2x the largest video times concurrent uploads, plus OS |
| Recommended | 4 vCPU / 8 GB | same rule |

The app rejects an upload when free disk is below 2x the file size + 256 MB. Place the VPS region and the R2 bucket location hint close to each other and to your audience.

**Cloudflare and R2** (dashboard labels `(verify)`)

1. Add the domain to Cloudflare. Create DNS record: `A` `embed.example.com` → VPS IP, **Proxied** (orange cloud). Leave SSL/TLS mode unchanged until step 11.
2. R2 → create the bucket. Connect the custom domain `cdn.example.com` to it (Settings → Custom Domains). `R2_URL` must be this custom domain, never `r2.dev` (rate limited, not for production).
3. R2 → Manage API tokens → create an **Object Read & Write** token limited to this bucket. Note the Access Key ID, Secret Access Key and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
4. SSL/TLS → Origin Server → Create Certificate: **RSA**, hostname `embed.example.com`, validity 15 years. Copy the certificate and the private key now (the key is shown once); install them in step 9.
5. Know your WordPress origin(s), e.g. `https://www.example.com` (needed for `CORS_ALLOWED_ORIGINS`, `REPORT_ALLOWED_HOSTS` and the embed allowlist).

Never paste keys, tokens, `.env` contents or the private key into tickets or chat.

## 1. Server software

Open a root shell first (`sudo -i`); every command in this guide assumes root (the `sudo` prefixes are harmless as root). A non-root deploy user (owning `<APP_DIR>`) is not covered here.

### Path A: aaPanel

1. PHP: App Store → PHP → install **PHP-8.4** (side by side with other versions). Verify:
   ```bash
   /www/server/php/84/bin/php -v
   ```
   If it differs, find the directory with `ls /www/server/php/`.
2. Extensions: PHP → 8.4 → Install extensions → enable `fileinfo`, `pdo_mysql`, `mbstring`, `curl`, `pcntl`, `bcmath`, `redis` (the PHP page, then restart PHP 8.4). `pcntl` is required for the queue worker `--timeout`. Verify:
   ```bash
   /www/server/php/84/bin/php -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
   ```
3. Composer (preinstalled versions are often too old for Laravel 13):
   ```bash
   /www/server/php/84/bin/php /usr/bin/composer self-update
   ```
4. Node 22 LTS, FFmpeg, git (Debian/Ubuntu; on other distros use that distro's equivalents `(verify)`):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
   sudo apt install -y nodejs ffmpeg git unzip
   ```
5. Verify everything (see "Verify" below).

### Path B: Plain VPS (clean server)

PHP 8.4 is not in the default Ubuntu repos up to 24.04 (24.04 ships 8.3). Add the PPA (Debian: use the sury repository instead `(verify)`):

```bash
sudo apt update && sudo apt install -y software-properties-common git unzip curl
sudo add-apt-repository -y ppa:ondrej/php
sudo apt update
apt-cache policy php8.4-fpm
```

`apt-cache policy` must show a candidate version `(verify)`. Then:

```bash
sudo apt install -y php8.4-cli php8.4-fpm php8.4-mysql php8.4-mbstring php8.4-curl php8.4-xml php8.4-bcmath php8.4-redis
sudo apt install -y nginx ffmpeg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
```

`pcntl` and `fileinfo` come with the standard Debian/Ubuntu `php-cli`. If `php -v` is not 8.4, run `sudo update-alternatives --set php /usr/bin/php8.4` `(verify)`.

### Verify (both paths, use `<PHP>`)

```bash
<PHP> -v
<PHP> -m | grep -E 'pcntl|fileinfo|redis|pdo_mysql'
node -v
ffmpeg -version
ffprobe -version
ffmpeg -encoders | grep libx264
```

- PHP must be 8.4+ (`composer.json` requires `^8.4`); `pcntl`, `fileinfo`, `redis`, `pdo_mysql` must be listed.
- Node must satisfy `^20.19.0 || >=22.12.0` (Vite 8 / laravel-vite-plugin 3 engines); use Node 22 LTS. The build also needs outbound internet (the Vite config downloads the Bunny font).
- `libx264` must appear in the encoders; `nice` (used by `FFMPEG_NICE`) is standard on Linux.
- Composer 2.2+: `composer -V`.

## 2. Database

Requirement: **MySQL 8.0.16+ or MariaDB 10.6+** `(verify)`. The migrations use enforced `CHECK` constraints, a `STORED` generated column with `SHA2()`, and a prefix index; the charset is utf8mb4. Use a dedicated user with a strong password limited to this database; never put `root` in `.env`.

### Path A: aaPanel

aaPanel → Database → Add database: name `hls_r2_studio`, charset utf8mb4, create a user and password (access: local). Check the engine version in the panel (App Store → MySQL); if it is below the requirement, install a newer one `(verify)`.

### Path B: Plain VPS (clean server)

Ubuntu 24.04 ships MySQL 8.0 (`mysql-server`); Debian ships MariaDB (`mariadb-server`) `(verify)`:

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

MySQL listens on localhost only by default; do not open 3306 in any firewall.

## 3. Redis

Rate-limit counters, Activity Log dedup keys and scheduler locks live in Redis, expire on their own, and add no MySQL load. With `CACHE_STORE=failover` the app falls back to the database cache table if Redis is down. Sessions and the queue stay on the database.

### Path A: aaPanel

App Store → install **Redis**; confirm it listens on `127.0.0.1` and starts on boot `(verify)`. If you set a password, put it in `REDIS_PASSWORD` in `.env`. The `redis` PHP extension was enabled in section 1.

### Path B: Plain VPS (clean server)

```bash
sudo apt install -y redis-server
```

In `/etc/redis/redis.conf` make sure these are set (`allkeys-lru` may evict keys under memory pressure, which is fine for a cache):

```conf
bind 127.0.0.1 ::1
maxmemory 256mb
maxmemory-policy allkeys-lru
```

```bash
sudo systemctl enable --now redis-server
redis-cli ping
```

It must answer `PONG`. Do NOT open port 6379 in any firewall. Verification through the app is in step 6.

## 4. Get the code and install PHP dependencies

### Path A: aaPanel

Clone into a temporary directory, then move it into place (a direct clone into the panel-created site directory fails with `destination path '.' already exists` because of hidden files). The `rm -rf` deletes the target directory, so run it only if that directory holds nothing but panel-generated files `(verify)`:

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

### Path B: Plain VPS (clean server)

```bash
sudo mkdir -p /var/www && cd /var/www
sudo git clone <git-repo-url> hls-r2-studio
cd hls-r2-studio
composer install --no-dev -o
```

## 5. Configure `.env`

Commands in sections 4-8 run from `<APP_DIR>`. This is the single source of truth for production values. **Fill it completely before step 6 and step 7.**

```bash
cp .env.example .env
nano .env
```

`.env.example` ships development defaults (`APP_ENV=local`, `DB_HOST=mysql`, `FORCE_HTTPS=false`, `REVERB_HOST=localhost`, `REVERB_ALLOWED_ORIGINS=*`, `CORS_ALLOWED_ORIGINS=https://toicovl.com`, ...). Change **every** key below, one key per line. Leave `APP_KEY` empty (step 6) and keep the other keys at their defaults.

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

**Warning:** with `CACHE_STORE=failover` a wrong Redis setting is NOT an error; the app silently uses the database cache. Always run the Redis check in section 6 and confirm keys appear.

If you do not run Redis, set `CACHE_STORE=database` and omit the `REDIS_*` lines. Set `FFMPEG_BINARY`/`FFPROBE_BINARY` only if `which ffmpeg`/`which ffprobe` returns nothing.

**Generate the Reverb secrets** (any three different random values work; nothing is registered anywhere):

| Key | Command |
|---|---|
| `REVERB_APP_ID` | `openssl rand -hex 10` |
| `REVERB_APP_KEY` | `openssl rand -hex 20` |
| `REVERB_APP_SECRET` | `openssl rand -hex 32` |

> **Any change to a `REVERB_*` value later requires `npm run build` again.** `resources/js/echo.js` bakes `VITE_REVERB_*` (expanded from `${REVERB_*}`) into the JavaScript at build time; a build made with the `.env.example` defaults ships `localhost:8080` to browsers and live progress silently breaks.

After editing `.env` at any time: `<PHP> artisan config:clear`, then restart the services (section 10), because they keep the config in memory.

## 6. App key, database tables, admin user

```bash
<PHP> artisan key:generate
<PHP> artisan migrate --force
<PHP> artisan admin:create admin --email=admin@example.com
```

- `--force` is mandatory: with `APP_ENV=production` plain `migrate` refuses to run non-interactively.
- `admin:create` prompts for a hidden password (min 8 characters); do not pass it on the command line. It upserts by username: running it again with the same username resets that account's password.
- Redis check (skip if `CACHE_STORE=database`):
  ```bash
  <PHP> artisan tinker --execute="Cache::put('ping','pong',60); echo Cache::get('ping');"
  redis-cli -n 1 keys '*'
  ```
  The first prints `pong`; the second lists keys (`REDIS_CACHE_DB` defaults to 1). If `redis-cli -n 1 keys '*'` prints nothing, the app is NOT using Redis (it fell back to the database): check `REDIS_*`, the `redis` PHP extension and `redis-cli ping`. This tinker check run as root may create root-owned files in `storage/`; section 8 fixes ownership (or run it as `<USER>`).

## 7. Build the frontend assets

Only after `.env` is final (see the warning in section 5):

```bash
npm ci
npm run build
```

`npm ci` uses `package-lock.json`. Needs Node 22 and outbound internet.

## 8. File permissions

Artisan commands run as root (`migrate`, `admin:create`, `config:clear`, ...) can create root-owned files in `storage/` (for example the daily log) that PHP-FPM and the systemd services cannot write, which gives HTTP 500. So finish every install and every update with this, **after** all root-run artisan commands:

```bash
sudo chown -R <USER>:<USER> storage bootstrap/cache
sudo chmod -R 775 storage bootstrap/cache
sudo chown root:<USER> .env
sudo chmod 640 .env
```

Services run as `www-data` (plain) or `www` (aaPanel); check the real PHP-FPM user with `ps aux | grep php-fpm` if unsure.

## 9. Web server and SSL

Install the **Cloudflare Origin certificate on the origin first**, and only then switch Cloudflare to Full (strict) (step 11); the other order gives 521/526 errors. Upload limits (both paths): uploads are chunked, so each limit only has to exceed `UPLOAD_CHUNK_SIZE_MB` (8) plus a little, and the chunk must stay at most about 90 MB because of Cloudflare's 100 MB request cap. Custom cover images (max 5 MB, form upload) fit too. The total file size limit is `UPLOAD_MAX_SIZE_MB` in the app.

| Setting | Value |
|---|---|
| Nginx `client_max_body_size` | `100m` |
| php.ini `upload_max_filesize` | `100M` |
| php.ini `post_max_size` | `100M` |
| php.ini `max_execution_time` | `300` |
| php.ini `memory_limit` | `512M` |

### Path A: aaPanel

aaPanel owns Nginx; do not run `apt install nginx`.

1. **Website → Add site**: domain `embed.example.com`, PHP **8.4**, site directory `/www/wwwroot/embed.example.com/public` (not the project root). If the site existed before cloning: site → Directory → confirm the site directory is `.../public`.
2. Site → **Directory** → turn **off** "Anti-XSS attack" (open_basedir). Left on, PHP can read only `public/` and you get a blank page with `open_basedir restriction in effect`.
3. Site → **URL rewrite** → template **Laravel** (Laravel5). Without it every page except `/` is 404. If missing, choose Custom:
   ```nginx
   location / {
       try_files $uri $uri/ /index.php?$query_string;
   }
   ```
4. PHP → 8.4 → **Configuration file**: set the php.ini values from the table above, then restart PHP 8.4.
5. Site → **Config File**: inside the existing `server { }` add `client_max_body_size 100m;` `(verify; aaPanel's global default may be lower)` and the Reverb proxy. Reverb needs BOTH `/app/` (WebSocket) and `/apps/` (REST event publishing); a missing `/apps/` makes broadcasts fail silently while the WebSocket looks connected:
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
6. Site → **SSL** → the "Other certificate"-style tab `(verify label)`: paste the Origin certificate (PEM) and private key, save. (Let's Encrypt HTTP-01 behind the orange cloud with Always Use HTTPS can fail; use the Origin certificate.)
7. Firewall: use the aaPanel firewall (Security) `(verify)`: allow 80 and 443 (and your SSH port); never open 8080, 3306 or 6379. Do not use `ufw` here.

### Path B: Plain VPS (clean server)

1. Install the Origin certificate (root-owned, key private):
   ```bash
   sudo mkdir -p /etc/ssl/cloudflare
   sudo nano /etc/ssl/cloudflare/embed.example.com.pem
   sudo nano /etc/ssl/cloudflare/embed.example.com.key
   sudo chown root:root /etc/ssl/cloudflare/embed.example.com.pem /etc/ssl/cloudflare/embed.example.com.key
   sudo chmod 600 /etc/ssl/cloudflare/embed.example.com.key
   ```
2. Create `/etc/nginx/sites-available/hls-r2-studio`. Check `nginx -v`: for nginx 1.25.1+ you may add `http2 on;` under the `listen 443 ssl;` line; older versions use `listen 443 ssl http2;` `(verify)`. HTTP/2 is optional here (Cloudflare to origin works without it `(verify)`).
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
   Remove the distro default site (the `rm` line below) so it cannot answer for other hosts; this is the standard layout of Debian/Ubuntu apt nginx `(verify)`, and `-f` makes it safe if the file is absent.
   ```bash
   sudo ln -s /etc/nginx/sites-available/hls-r2-studio /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. PHP limits: edit `/etc/php/8.4/fpm/php.ini` with the values from the table above, then:
   ```bash
   sudo systemctl restart php8.4-fpm
   ```
4. Firewall. **Allow SSH first**: enabling `ufw` without it locks you out of the server.
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Never open 8080 (Reverb), 3306 or 6379. To accept web traffic only from Cloudflare, see the optional hardening in section 11.

## 10. Background services

The app needs three long-running processes, none managed by aaPanel. Create the unit files with the values for your path:

| | Path A: aaPanel | Path B: Plain VPS |
|---|---|---|
| `<USER>` | `www` | `www-data` |
| `<APP_DIR>` | `/www/wwwroot/embed.example.com` | `/var/www/hls-r2-studio` |
| `<PHP_BIN>` | `/www/server/php/84/bin/php` | `/usr/bin/php8.4` |
| `systemctl` | run as root | prefix with `sudo` |

`After=` lists mysql and redis units for ordering only; units that do not exist on your system (the MySQL unit is `mysql` or `mariadb`; aaPanel's MySQL/Redis may have no systemd unit) are ignored.

Queue worker, `/etc/systemd/system/hls-r2-studio-queue@.service` (a template, so several instances can run):

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

Reverb, `/etc/systemd/system/hls-r2-studio-reverb.service` (one instance):

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

Scheduler (daily cleanup), `/etc/systemd/system/hls-r2-studio-scheduler.service` (one instance):

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

- `--timeout=172800` (48 h) matches the real job timeout (see `TRANSCODE_TIMEOUT_MULTIPLIER` in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa)); `DB_QUEUE_RETRY_AFTER=176400` must always stay greater, otherwise a second worker picks up a job that is still running. Without `--timeout`, Laravel kills jobs after 60 s. `--timeout` needs `pcntl`.
- **Sizing:** each worker runs one ffmpeg at a time and ffmpeg uses every core by default. On a small VPS (for example 4 vCPU shared with PHP-FPM and MySQL) run 1-2 workers, set `FFMPEG_THREADS` to about CPU cores / workers, and keep `FFMPEG_NICE=10`. Optionally add `Nice=10` and `CPUQuota=250%` (example value) under `[Service]`; not required when `FFMPEG_NICE` is enough.
- Keep `REVERB_SERVER_HOST=127.0.0.1`: Reverb listens locally and is reachable only through Nginx.

## 11. Cloudflare settings

Dashboard labels `(verify)` differ between versions. Do these after the origin works over HTTPS (section 9).

1. **DNS and WebSockets**: `embed.example.com` is Proxied (section 0). Network → **WebSockets** must be on (default on) for Reverb `(verify)`.
2. **SSL/TLS → Overview**: set **Full (strict)** (only after the Origin certificate is installed), and SSL/TLS → Edge Certificates → **Always Use HTTPS** on. Why: no redirect loops, encrypted hop to the origin.
3. **Cache Rule for the embed page** (Rules → Cache Rules): hostname equals `embed.example.com` and URI path starts with `/embed/` → Cache eligibility **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**. Why: Cloudflare does not cache HTML by default, and the app sends `Cache-Control: public, max-age=60, s-maxage=300` with no cookies (responses with `Set-Cookie` or `private/no-cache/no-store/max-age=0` are never cached). Consequence: allowlist changes or a video deletion can take up to 5 minutes to show on the cached page (1 minute in browsers).
4. **Cache Rule for the R2 domain**: hostname equals `cdn.example.com` → **Eligible for cache**; Edge TTL **Ignore cache-control header and use this TTL** = **1 day**; Browser TTL **Override origin and use this TTL** = **2 hours** (the smallest option the Free plan dropdown offers; "Respect origin" also works). Why: `.m3u8` and `.ts` are not in Cloudflare's default cached extensions, so every segment would hit R2. A deleted or taken-down video can still be served from the edge for up to the TTL; on the free plan purge works per URL only.
5. **Do not challenge iframe traffic**: if viewers see challenge pages or blank frames in the iframe, add a WAF custom rule with action **Skip** for URI path starts with `/embed/`, `/apps/` or `/app/` (and for the R2 domain), or lower the security level for them. Why: iframes cannot solve challenges `(verify)`.
   - `/apps/` and `/app/` matter too: `config/broadcasting.php` publishes broadcast events using `REVERB_HOST`/`REVERB_PORT`/`REVERB_SCHEME`, so the VPS itself calls `https://embed.example.com:443/apps/...` through Cloudflare and back to Nginx `/apps/` (not directly to `127.0.0.1:8080`). Cloudflare must not challenge or block these server-to-server requests.
   - Under Attack mode and Bot Fight Mode can block them, and Bot Fight Mode cannot be skipped by WAF custom rules `(verify)`. If live progress stops while the WebSocket still connects, turn those off for the zone and retest `(verify)`.
6. **Hotlink rule for the R2 domain** (Security → WAF → Custom rules, action **Block**), expression `(verify the syntax in the dashboard)`:
   ```
   (http.host eq "cdn.example.com" and http.referer ne "" and not http.referer contains "embed.example.com")
   ```
   - Requests with an **empty Referer must stay allowed**: Safari/iOS native HLS playback usually sends no Referer, so blocking empty referers breaks iPhone playback.
   - It only stops other websites' players, not scripts that send no Referer.
   - After enabling it, test playback on an iPhone and a desktop browser.
7. **R2 bucket CORS** (R2 → bucket → Settings → CORS policy) so the embed origin can GET the HLS files `(verify the format in the dashboard)`:
   ```json
   [{"AllowedOrigins":["https://embed.example.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
   Why: the player fetches playlists and segments cross-origin.
8. **Optional hardening, accept web traffic only from Cloudflare** `(verify)`. Why: stops attackers bypassing Cloudflare through the origin IP. Plain VPS with `ufw` (SSH stays allowed): remove the generic rules, then allow Cloudflare's published ranges:
   ```bash
   sudo ufw delete allow 80/tcp
   sudo ufw delete allow 443/tcp
   for ip in $(curl -s https://www.cloudflare.com/ips-v4; echo; curl -s https://www.cloudflare.com/ips-v6); do sudo ufw allow from "$ip" to any port 80,443 proto tcp; done
   ```
   Verify the site still loads. The ranges change rarely; re-run occasionally. On aaPanel use the panel firewall instead.

## 12. App settings, smoke tests, Google cleanup

1. **Embed allowlist**: log in at `https://embed.example.com/login` → Settings → **Embed protection** → Allowed domains: add `www.example.com` and `example.com` (one per line; `*.example.com` and `https://host:port` forms are accepted). Empty means any website can frame the player. The app's own site is always allowed, so the dashboard preview works.
2. **Smoke tests**:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://embed.example.com/up
   curl -sI https://embed.example.com/login
   ```
   - (a) `/up` returns 200; `/login` shows `x-robots-tag: noindex, nofollow, noarchive`.
   - (b) Upload a short video and watch the stages (upload, merge, transcode, R2 upload) complete. Progress must update live: a `wss://embed.example.com/app/...` connection with status 101 in browser dev tools, and the progress bar really moves (this also proves the `/apps/` publishing path through Cloudflare).
   - (c) Then check the embed URL (it needs an existing ready video), and play it on desktop and iPhone:
     ```bash
     curl -sI https://embed.example.com/embed/<video-id>
     ```
     It shows no `Set-Cookie`, `Cache-Control: public, max-age=60, s-maxage=300`, `X-Robots-Tag: noindex, nofollow`, and on the second request `cf-cache-status: HIT`.
   - (d) Throttling: send 6 wrong logins in a row and expect HTTP 429 on the 6th (limit is 5 per minute per IP), then confirm another network/IP can still log in.
3. **Remove already-indexed pages from Google**: the app sends `X-Robots-Tag: noindex, nofollow, noarchive` on every response (the embed page keeps its own `noindex, nofollow`) and the layouts carry a `robots` meta tag.
   - Keep `robots.txt` open. Do **not** add `Disallow: /`: Google must fetch the pages to see the noindex, otherwise it keeps the URLs listed.
   - To speed up removal, verify the domain in Google Search Console, then Removals → New request (temporary removal). Otherwise Google drops them on its next crawl (days to weeks).

## Updating / redeploying with new code

```bash
cd <APP_DIR>
git pull
```

Then, in this order, only what the change needs:

**General rule:** any change to `.env` or any `config/*.php` also needs `config:clear` AND a restart of the queue workers, Reverb and the scheduler, because those long-running processes keep the config in memory (this includes `config/cache.php`). The rows below are the specific cases.

| Command | Only needed when |
|---|---|
| `<PHP> /usr/bin/composer install --no-dev -o` (plain: `composer install --no-dev -o`) | `composer.json` / `composer.lock` changed |
| `npm ci` | `package.json` / `package-lock.json` changed |
| `npm run build` | `resources/css`, `resources/js`, any `.blade.php`, or any `REVERB_*` value changed |
| `<PHP> artisan migrate --force` | There is a new migration in `database/migrations/` |
| `<PHP> artisan config:clear` | A `config/*.php` file or `.env` changed |
| Restart the **queue workers**: `sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2` | `app/Jobs/TranscodeVideoJob.php` or queue-processing code, `app/Services/*`, `app/Support/FfmpegCommand.php`, `config/videos.php` or `config/services.php` changed |
| Restart **Reverb**: `sudo systemctl restart hls-r2-studio-reverb` | `app/Events/*.php`, `config/reverb.php`, `config/broadcasting.php`, `resources/js/echo.js` or any `REVERB_*` value changed |
| Restart the **scheduler**: `sudo systemctl restart hls-r2-studio-scheduler` | `routes/console.php` or `app/Console/Commands/*` changed |
| Restart **PHP-FPM** (plain: `sudo systemctl restart php8.4-fpm`; aaPanel: restart PHP 8.4 in the panel) | `php.ini` changed |
| `sudo chown -R <USER>:<USER> storage bootstrap/cache` and `sudo chmod -R 775 storage bootstrap/cache` | **Always, last** (root-run artisan may have created root-owned files) |

If you are not sure whether a command is needed, run them all; it does no harm.

A queue restart interrupts the video being transcoded (systemd stops it after its stop timeout, 90 s by default `(verify)`, and `--tries=1` means the job is not retried). Restart workers when no video is processing; `<PHP> artisan queue:restart` is the graceful alternative: workers exit after their current job and systemd starts them again.

## Operations

| Task | Command |
|---|---|
| Service status | `sudo systemctl status hls-r2-studio-queue@1 hls-r2-studio-reverb hls-r2-studio-scheduler` |
| Service logs | `sudo journalctl -u hls-r2-studio-queue@1 -f` (same for `hls-r2-studio-reverb`, `hls-r2-studio-scheduler`) |
| App log | `<APP_DIR>/storage/logs/laravel-YYYY-MM-DD.log` (daily channel, 14 days kept) |
| Health | `curl -s -o /dev/null -w "%{http_code}\n" https://embed.example.com/up` (expect 200) |
| Redis | `redis-cli ping` (expect `PONG`); if it is down the app falls back to the database cache |
| Disk | The dashboard shows disk usage; watch it, uploads are rejected below 2x file size + 256 MB free |

**Daily cleanup** runs from the scheduler service (`routes/console.php`); you can also run each by hand (as `<USER>` so `storage/` ownership stays correct, e.g. `sudo -u <USER> <PHP> artisan ...`):

| Command | Cleans |
|---|---|
| `uploads:cleanup-abandoned` | Abandoned chunk upload directories (`UPLOAD_ABANDONED_TTL_HOURS`) |
| `videos:cleanup-orphaned-tmp` | Crashed or stuck transcode temp directories (`TRANSCODE_ORPHANED_TTL_HOURS`) |
| `videos:cleanup-orphaned-uploads` | Orphaned original files (`UPLOAD_ORPHANED_TTL_HOURS`; no-op when `KEEP_ORIGINAL_UPLOAD=true`) |

**Backups.** Videos live on R2 and are not backed up by this guide. Back up the database daily and keep copies off the server. Put credentials in a private option file instead of the command line (`~/.my.cnf` of the cron user, `chmod 600`):

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

(Crontab needs `%` escaped as `\%`. The root cron job reads `/root/.my.cnf`.) Also keep an off-server copy of `.env` and of the Origin certificate private key (`/etc/ssl/cloudflare/embed.example.com.key`, or the key you pasted into aaPanel); store them in a password manager, not in the repository.

## Troubleshooting pointers

Full table and Q&A: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa). Deployment-specific symptoms:

| Symptom | Likely cause |
|---|---|
| Cloudflare 521 / 526 | Origin does not listen on 443, or the Origin certificate is missing (section 9), while SSL mode is Full (strict) |
| HTTP 500 after an install or update | Root-owned files in `storage/` (section 8) |
| Live progress never updates, console shows `localhost:8080` | Frontend was built before `.env` had the final `REVERB_*` values: fix `.env`, run `npm run build` |
| WebSocket connects but broadcasts never arrive (`Pusher error: 404`) | Nginx is missing `location /apps/` |
| Live progress works (WebSocket 101) but updates never arrive | Event publishing (VPS → Cloudflare → Nginx `/apps/`) is blocked by a Cloudflare rule, or Nginx lacks `location /apps/` |
| Upload fails with 413 | `client_max_body_size` or Cloudflare's 100 MB body cap is lower than `UPLOAD_CHUNK_SIZE_MB` |
| Blank page `open_basedir restriction in effect` (aaPanel) | "Anti-XSS attack" is still on |
| Everything except `/` is 404 (aaPanel) | URL rewrite not enabled |
| Video stuck on "Processing", log has `Job timed out` | Queue worker is missing `--timeout=172800` |
