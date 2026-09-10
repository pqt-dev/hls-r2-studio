#!/bin/sh
set -e

# public/ is mounted from a named volume shared with the nginx container.
# Seed/refresh it from the image's built copy on every start so nginx always
# serves the assets baked into this image (and so a fresh, empty volume gets
# populated correctly regardless of container startup order).
cp -a /var/www/public-src/. /var/www/html/public/

# Named volumes (storage/, database/) are created empty/root-owned on first
# run; make sure the php-fpm/queue worker user can write to them.
chown -R www-data:www-data \
    /var/www/html/storage \
    /var/www/html/bootstrap/cache \
    /var/www/html/database \
    /var/www/html/public

exec "$@"
