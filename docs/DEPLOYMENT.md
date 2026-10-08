# Deployment Guide

> Back to the [README](../README.md). This guide holds the full production setup (plain VPS and aaPanel) moved out of the README. Troubleshooting, data structure and Q&A are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Installation

> **Note:** The application behaviour described in this README is derived from the source code. The infrastructure steps below (systemd unit names/files, Nginx config, aaPanel UI steps and toggles, Let's Encrypt/certbot, Node setup) are environment-specific, are not defined in this repository, and cannot be verified from the code. aaPanel's UI may differ between versions. If something does not match your environment, see the [Common Errors, Fixes, and Q&A](TROUBLESHOOTING.md#common-errors-fixes-and-qa) section.

> **Does your VPS already have a management panel (aaPanel, cPanel, Plesk...)?**
> - **Already has aaPanel** → follow the [Deploying with aaPanel](#deploying-with-aapanel) section — simpler, no need to install Nginx/PHP-FPM manually.
> - **A "blank" VPS with nothing installed** → follow the [Plain VPS Installation](#plain-vps-installation-no-panel) section right below.

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
