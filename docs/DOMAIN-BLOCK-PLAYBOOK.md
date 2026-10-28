> English | [Tiếng Việt](DOMAIN-BLOCK-PLAYBOOK.vi.md)

# Domain Block Playbook

> Related: [DEPLOYMENT.md](DEPLOYMENT.md) (server and Cloudflare setup), [TROUBLESHOOTING.md](TROUBLESHOOTING.md) (errors, Q&A). Back to the [README](../README.md).

How to prepare standby domains and switch to them when a domain is blocked. A block means users in Vietnam cannot reach a domain. Each host can be blocked on its own, so each section works alone. Never paste `.env` contents, passwords or keys into tickets or chat.

## Names and where to change what

| Name | Role |
|---|---|
| `main-site.com` / `new-main-site.com` | WordPress site: current / standby |
| `embed-site.com` / `new-embed-site.com` | This dashboard and the iframe host (`/embed/ID`): current / standby |
| `cdn.embed-site.com` / `cdn.new-embed-site.com` | R2 custom domain serving `.m3u8` and `.ts`: current / standby. It is a subdomain of the embed domain, so it is blocked together with it |

Server: one aaPanel VPS runs both sites, and you work over SSH as root. Dashboard: `/www/wwwroot/embed-site.com`. WordPress: `/www/wwwroot/main-site.com`. PHP CLI: `/www/server/php/84/bin/php`. Site user: `www`. WP Staging copy: `/www/wwwroot/main-site.com/staging` (Verify the real path once; aaPanel and plugin labels also change between versions).

Backups: this playbook relies on the automatic backups of aaPanel and does not create any.

| Setting | Where |
|---|---|
| `HLS_EMBED_HOST` | WPCode snippet "HLS Embed shortcode" on the WordPress site |
| `APP_URL`, `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME`, `REVERB_ALLOWED_ORIGINS`, `R2_URL` (optional extras, empty by default: `CORS_ALLOWED_ORIGINS`, `REPORT_ALLOWED_HOSTS`) | `.env` of the dashboard (aaPanel > Files, or SSH `nano`) |
| Embed allowlist (main site domains: allowed to frame the player, to send reports via CORS, and accepted as report hosts) | Dashboard Settings > Embed protection > Embed allowlist. It is in the database, NOT in `.env` |
| R2 CORS policy, R2 custom domain | Cloudflare > R2 > the bucket > Settings |
| Cache and Redirect rules, DNS, SSL mode, Origin certificate | Cloudflare, in the zone of that domain |
| Add a domain, install the certificate | aaPanel > Website > the existing site |
| Absolute URLs of FIFU images and of WordPress itself | WordPress database, with `wp search-replace` |

## Embed site (`embed-site.com` to `new-embed-site.com`)

Posts store only the shortcode, so the embed host changes in one place (`HLS_EMBED_HOST`).

### Prepare

1. Buy `new-embed-site.com` (not `.vn`), add it as a zone in the same Cloudflare account as R2, and add a DNS record of type A to the VPS IP, Proxied.
2. aaPanel: Website > the existing dashboard site > Domain Manager > add the domain (never clone the site). In Cloudflare create a NEW Origin CA certificate for it, paste it in the site's SSL tab, and only then set Cloudflare SSL to Full (strict), or you get 521/526. Also add the Cloudflare rules for the new zone: steps 1, 3 and 5 of [DEPLOYMENT.md section 11](DEPLOYMENT.md#11-cloudflare-settings).
3. Cloudflare > R2 > the bucket > Settings: attach `cdn.new-embed-site.com` to the same bucket, and in the CORS policy add `https://new-embed-site.com` (keep the old origin). Verify: one bucket can have several custom domains.

   ```json
   [{"AllowedOrigins":["https://embed-site.com","https://new-embed-site.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
4. Test on WP Staging: set `HLS_EMBED_HOST` to `https://new-embed-site.com`, purge staging caches, open a post with `[hls_embed_vl id="N"]`, then check the headers. Playback can return 403 until `R2_URL` changes (hotlink rule); the iframe itself must load. Verify: whether embed page assets depend on `APP_URL` (DevTools > Network: any request to `embed-site.com`?).

   ```bash
   curl -sI https://new-embed-site.com/embed/ID
   ```
5. The `.env` values to switch are listed in Respond step 2.

### Respond

1. Confirm the block from a network in Vietnam.
2. Edit the dashboard `.env` (aaPanel > Files, or SSH `nano`) and set these lines. `REVERB_PORT` and `REVERB_SCHEME` stay the same. `R2_URL` changes here too, because the cdn goes down with the embed domain.

   ```env
   APP_URL=https://new-embed-site.com
   REVERB_HOST=new-embed-site.com
   REVERB_ALLOWED_ORIGINS=new-embed-site.com
   R2_URL=https://cdn.new-embed-site.com
   ```
3. Reload and restart. Restarting the queue interrupts a video being transcoded, so run this when none is processing. Artisan runs as the site user ([DEPLOYMENT.md "Operations"](DEPLOYMENT.md#operations)); `npm run build` is needed because `REVERB_*` is baked into the JS.

   ```bash
   cd /www/wwwroot/embed-site.com
   sudo -u www /www/server/php/84/bin/php artisan config:clear
   npm run build
   systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2
   systemctl restart hls-r2-studio-reverb
   systemctl restart hls-r2-studio-scheduler
   ```
4. WPCode snippet "HLS Embed shortcode" on the WordPress site: change `HLS_EMBED_HOST` to `https://new-embed-site.com`, save, keep it Active.
5. Purge ALL page caches (caching plugin and Cloudflare).
6. Verify (expect 200). Then open a post with a video from a network in Vietnam: the page source shows an iframe from `https://new-embed-site.com/embed/`.

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://new-embed-site.com/up
   ```

## Custom domain (R2): `cdn.embed-site.com` to `cdn.new-embed-site.com`

Only `R2_URL` changes: the database stores relative paths and the URL is built at runtime. No re-upload, no database change.

### Prepare

1. Attach `cdn.new-embed-site.com` and update CORS (embed Prepare step 3).
2. Cache and hotlink rules for the new host: steps 4 and 6 of [DEPLOYMENT.md section 11](DEPLOYMENT.md#11-cloudflare-settings). The hotlink rule must allow the NEW embed domain as Referer.

### Respond

1. `R2_URL` is already set in embed Respond step 2. Take the `.m3u8` path of a ready video from DevTools > Network (path only) and check it (expect 200; a `.ts` segment path is checked the same way):

   ```bash
   curl -I https://cdn.new-embed-site.com/<path>.m3u8
   ```
2. Play a video in the browser: no CORS error in the console, requests go to `cdn.new-embed-site.com`, old videos still play.

## FIFU (follows the cdn domain)

FIFU stores absolute cdn URLs in the WordPress database; shortcodes cannot fix that, `wp search-replace` rewrites them (serialized-safe). Run WP-CLI as the site user and always `--dry-run` first.

### Prepare

1. Check WP-CLI, then run the dry run. Its per-table counts show where the cdn host is stored (trust this output; FIFU internals were not inspected). Keep `--skip-columns=guid`; if a dry run with `--include-columns=guid` ever shows matches, drop that flag.

   ```bash
   sudo -u www wp --info
   ```
   ```bash
   sudo -u www wp search-replace 'https://cdn.embed-site.com' 'https://cdn.new-embed-site.com' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=/www/wwwroot/main-site.com
   ```
2. Rehearse on WP Staging: repeat the dry run with `--path=/www/wwwroot/main-site.com/staging`.

### Respond

1. Before changing the database, check in aaPanel that the latest automatic backup of the WordPress database exists.
2. Real run (after the custom domain section is done):

   ```bash
   sudo -u www wp search-replace 'https://cdn.embed-site.com' 'https://cdn.new-embed-site.com' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=/www/wwwroot/main-site.com
   ```
3. Purge caches (caching plugin, Cloudflare, FIFU cache if any). Check thumbnails on the home page, an archive page and a single post, and `og:image` in the page source.

Fallback: if WP-CLI cannot be installed, the Better Search Replace plugin installed in that same WordPress site can do the same from the admin (dry run first, "Replace GUIDs" off).

## Main site (`main-site.com` to `new-main-site.com`)

WordPress stores absolute URLs of its own domain (posts, postmeta, options, often serialized), so `wp search-replace` is used. Needed only when `main-site.com` itself is blocked.

### Prepare

1. Buy `new-main-site.com` (not `.vn`) and add it as a Cloudflare zone.
2. Search Console: verify both properties (`main-site.com` and `new-main-site.com`).
3. Dry run: the counts show where the domain is stored.

   ```bash
   sudo -u www wp search-replace 'https://main-site.com' 'https://new-main-site.com' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=/www/wwwroot/main-site.com
   ```
4. Rehearse the whole switch on WP Staging (`--path=/www/wwwroot/main-site.com/staging`) and time it.

### Respond

1. Confirm the block from a network in Vietnam.
2. aaPanel: Website > the WordPress site > Domain Manager > add the new domain (never clone the site). Then DNS, a NEW Origin certificate, SSL and Full (strict) as in embed Prepare steps 1 and 2.
3. Before changing the database, check in aaPanel that the latest automatic backup of the WordPress database exists.
4. Real run. If old `http://main-site.com` links or the `www.` form exist, run the same command with `http://main-site.com` to `http://new-main-site.com` (and the `www.` host). Search-replace already rewrites `home` and `siteurl`; check that Settings > General shows the new address.

   ```bash
   sudo -u www wp search-replace 'https://main-site.com' 'https://new-main-site.com' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=/www/wwwroot/main-site.com
   ```
5. Dashboard: add `new-main-site.com` and `www.new-main-site.com` to the Embed allowlist (Dashboard Settings > Embed protection > Embed allowlist). It is in the database and also covers report CORS and report hosts: no `.env` edit, `config:clear` or restart.
6. Purge ALL page caches. Embed pages can take up to 5 minutes to show the allowlist change.
7. Cloudflare, old zone > Redirect Rules: 301 to `https://new-main-site.com`, keep path and query. Search Console: Change of Address. Keep the redirect at least 1 year (Google asks 180 days minimum).
8. Check on the new domain: videos play, thumbnails load.

## Runbook (in this order)

If only some hosts are blocked, run only those rows.

| # | Do | Why |
|---|---|---|
| 1 | Embed site | Users watch the videos; no WordPress database change |
| 2 | Custom domain (R2) | It goes down with the embed domain; playback needs it (same `.env` edit as row 1) |
| 3 | FIFU | Thumbnails depend on the cdn host, so after the cdn works |
| 4 | Main site | Heaviest change, only needed if `main-site.com` is blocked; do it last and alone |
| 5 | Purge caches | After every host change; old pages keep the old host |
| 6 | Announce | Only when everything is verified |

## Troubleshooting

More: [DEPLOYMENT.md](DEPLOYMENT.md#troubleshooting-pointers) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa).

| Symptom | Check |
|---|---|
| Post shows plain text `[hls_embed_vl ...]` | WPCode snippet is inactive or missing (restore it from your outside copy) |
| Page source has `<!-- hls-embed: invalid configuration -->` | `HLS_EMBED_HOST` missing, not `https`, or the shortcode `id` is invalid |
| Iframe is refused or blank | Embed allowlist misses the WordPress domain (up to 5 minutes to update) |
| Player loads but video does not play | R2 CORS origin, `R2_URL`, `cdn.new-embed-site.com` not attached, or hotlink rule Referer |
| Thumbnails are broken | FIFU still uses the old cdn host: run the FIFU section |
| Old host is still shown | Page cache not purged |
| Dashboard live progress stops | `REVERB_*` wrong, `npm run build` not run, or Reverb not restarted |
| Cloudflare 521 / 526 | Origin certificate not installed, or Full (strict) set before it |

## Also do

- Announce the new domain on channels you own (fan page, Telegram or Zalo, email list) and keep the brand name the same so people can find it on Google.
- A 301 redirect (Cloudflare Redirect Rule on the old zone, keep path and query) helps only Googlebot, VPN users and other networks. It does NOT help users in Vietnam when the ISP cuts the connection first.
- Keep a copy of the WPCode snippet "HLS Embed shortcode" outside WordPress; if it is lost, every shortcode shows as plain text.
- Have someone in Vietnam test the three hosts regularly, and rehearse the whole switch once on WP Staging.
