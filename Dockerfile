# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build frontend assets (Vite/Tailwind) with Node
# ---------------------------------------------------------------------------
FROM node:20-alpine AS assets

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js ./
COPY resources ./resources
COPY public ./public

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: PHP application (php-fpm)
# ---------------------------------------------------------------------------
FROM php:8.4-fpm

WORKDIR /var/www/html

# System packages: FFmpeg/FFprobe for transcoding, plus build deps for the
# PHP extensions this app actually needs (sqlite DB, mbstring core, curl for
# the AWS SDK/Guzzle client talking to Cloudflare R2, pcntl for queue:work).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsqlite3-dev \
        libonig-dev \
        libcurl4-openssl-dev \
        unzip \
        git \
    && ffmpeg -version \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 \
    && docker-php-ext-install -j"$(nproc)" pdo pdo_sqlite pdo_mysql mbstring curl pcntl \
    && apt-get purge -y --auto-remove libsqlite3-dev libonig-dev libcurl4-openssl-dev git \
    && rm -rf /var/lib/apt/lists/*

# Composer, copied from the official image (no installer script download).
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Upload/runtime php.ini overrides.
COPY docker/php/uploads.ini /usr/local/etc/php/conf.d/uploads.ini

# Application source.
COPY . .

# Freshly built frontend assets from the Node stage.
COPY --from=assets /app/public/build ./public/build

RUN composer install --no-dev --optimize-autoloader --no-interaction

# public/ is replaced at runtime by a named volume shared with the nginx
# container (nginx has no access to this image's filesystem). Keep a copy of
# the built public/ directory outside the mount point so the entrypoint can
# seed/refresh the shared volume on every container start.
RUN cp -a /var/www/html/public /var/www/public-src

RUN chown -R www-data:www-data /var/www/html \
    && chmod -R 775 storage bootstrap/cache

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 9000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["php-fpm"]
