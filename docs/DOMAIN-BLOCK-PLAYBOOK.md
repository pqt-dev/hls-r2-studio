> English | [Tiếng Việt](DOMAIN-BLOCK-PLAYBOOK.vi.md)

# Domain Block Playbook

> Related: [DEPLOYMENT.md](DEPLOYMENT.md) (server and Cloudflare setup), [TROUBLESHOOTING.md](TROUBLESHOOTING.md) (errors, Q&A). Back to the [README](../README.md).

## Summary

**Prepare (do it before a block)**

Embed site, B to C (section 2.1):

1. Buy domain `C` (not `.vn`) and add it to Cloudflare on the same account as R2.
2. Cloudflare: DNS record of type A for `C` to the same VPS IP (Proxied), Origin CA certificate, SSL Full (strict), Cache Rule `/embed/*`, WAF Skip rule for `/embed/`, `/apps/` and `/app/`.
3. aaPanel: add `C` to the EXISTING site (Domain Manager); do not clone the site.
4. R2 (Cloudflare): attach `cdn.C` to the same bucket and add `https://C` to the CORS `AllowedOrigins`.
5. Write down (do not apply yet) the standby `.env` values: `APP_URL`, `REVERB_*`, `REVERB_ALLOWED_ORIGINS`, `R2_URL`.
6. Test on WP Staging: set `HLS_EMBED_HOST` to `https://C` and open `https://C/embed/ID`.

FIFU and main site (sections 2.3 and 2.4):

1. Install or check WP-CLI (`wp --info`) and run it as the site user, not root.
2. Dry-run `wp search-replace` to learn where the cdn host and the WordPress domain are stored.
3. Buy domain `D`, add it to Cloudflare, and verify both properties in Search Console.
4. Rehearse the whole switch on WP Staging and time it.

General (section 4): keep a copy of the WPCode snippet "HLS Embed shortcode" outside WordPress; have someone in Vietnam test `A`, `B` and `cdn.B` regularly.

**Response (when blocked)**

If embed domain `B` is blocked (`cdn.B` goes with it) (sections 2.1, 2.2 and 2.3):

1. Confirm the block from a network in Vietnam.
2. VPS `.env`: apply the standby values (`APP_URL`, `REVERB_*`, `REVERB_ALLOWED_ORIGINS`, `R2_URL` to `https://cdn.C`).
3. Run `config:clear` and `npm run build` (because of `REVERB_*`), then restart the queue workers, Reverb and the scheduler.
4. Check `https://C/up`, a playlist and a segment on `cdn.C`, and that there are no CORS errors.
5. WPCode snippet "HLS Embed shortcode": change `HLS_EMBED_HOST` to `https://C`.
6. Purge caches (caching plugin and Cloudflare).
7. FIFU: back up with `wp db export`, dry-run, then the real run of `wp search-replace 'https://cdn.B' 'https://cdn.C' --skip-columns=guid`, purge caches, check thumbnails.

If WordPress domain `A` is blocked (section 2.4):

1. Add `D` to the existing WordPress site and configure Cloudflare for `D`.
2. `wp db export`, then dry-run and real run of `wp search-replace` for `https://A` and `http://A` to `D`, and check the Site Address.
3. Dashboard: add `D` to the Embed allowlist (Dashboard Settings page), add `D` to `CORS_ALLOWED_ORIGINS` and `REPORT_ALLOWED_HOSTS` in `.env`, then `config:clear` and restart the services.
4. Purge caches, 301 redirect `A` to `D`, Search Console Change of Address.

Last (section 3): announce the new domain on channels you own, only after everything is verified. A 301 redirect helps only Googlebot and VPN users, not users in Vietnam.

Details are in sections 1 to 6 below.

This playbook is for the admin who runs the WordPress site and this dashboard. It explains how to prepare standby domains before a block and how to switch to them after a block, step by step.

Assumption: a block means users in Vietnam cannot reach a domain. The main WordPress domain and the embed domain may be blocked at the same time, so each can be switched on its own.

Anything not verified against this repository is marked `Verify:`. Cloudflare, aaPanel, WPCode, WordPress and plugin labels change between versions, so check them on the real screen. Never paste `.env` contents, passwords or keys into tickets or chat.

## 1. Hosts and where to change them

**Placeholders** (used everywhere below):

| Placeholder | Meaning |
|---|---|
| `A` | Main WordPress site domain, for example `wp-site.com` |
| `B` | Embed domain = this Laravel dashboard, for example `mediadomain.com` (embed route `/embed/{id}`) |
| `cdn.B` | Cloudflare R2 custom domain that serves the HLS files (`.m3u8`, `.ts`); a subdomain of `B`, equal to `R2_URL`. When `B` is blocked, `cdn.B` is blocked too |
| `C` | Standby embed domain (bought in advance, not `.vn`); `cdn.C` is its R2 custom domain |
| `D` | Standby WordPress domain (bought in advance, not `.vn`) |
| `<project path>` | Project directory on the VPS (`<APP_DIR>` in [DEPLOYMENT.md](DEPLOYMENT.md)) |
| `<PHP>`, `<USER>` | PHP CLI and service user, as defined in [DEPLOYMENT.md](DEPLOYMENT.md) |
| `<wp path>` | WordPress directory on the server that hosts the WordPress site |
| `<WP_USER>` | System user that owns the WordPress files (the user WP-CLI must run as) |
| `<wp staging path>` | WordPress directory of the WP Staging copy |

Replace every placeholder (`A`, `B`, `C`, `D`, `cdn.B`, `cdn.C`, `<project path>`, `<wp path>`, `<wp staging path>`, `<WP_USER>`, ...) with the real value before running any command or query; copying them literally is wrong (for example `LIKE '%A%'` would match unrelated rows and `https://A` is not a real host).

**Where to change what** (every step below states its place explicitly and follows this table):

| What | Where it lives | After changing it |
|---|---|---|
| `HLS_EMBED_HOST` (embed host, `https` only, no path) | WPCode snippet "HLS Embed shortcode" on the WordPress site | Purge ALL page caches (caching plugin and Cloudflare) |
| `APP_URL` | VPS `.env` of the dashboard | `config:clear`, restart services |
| `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` | VPS `.env` of the dashboard | `config:clear`, `npm run build` (baked into the JS at build time), restart Reverb |
| `REVERB_ALLOWED_ORIGINS` (hostname only, no scheme) | VPS `.env` of the dashboard | `config:clear`, restart services |
| `R2_URL` | VPS `.env` of the dashboard | `config:clear`, restart services |
| `CORS_ALLOWED_ORIGINS` (origins WITH scheme; default in code is `https://toicovl.com` if unset) | VPS `.env` of the dashboard | `config:clear`, restart services |
| `REPORT_ALLOWED_HOSTS` (hosts WITHOUT scheme) | VPS `.env` of the dashboard | `config:clear`, restart services |
| Embed allowlist (WordPress domains allowed to put the player in an iframe; sent as CSP `frame-ancestors`) | Database setting `embed_allowed_domains`, edited in the Dashboard Settings page: Settings > Embed protection > Allowed domains. NOT in `.env` | Save the form; cached embed pages can take up to 5 minutes to show it |
| R2 CORS policy, R2 custom domains | Cloudflare dashboard > R2 > the bucket > Settings (not in the repo, not in `.env`) | Test playback |
| Cache Rule for `/embed/*`, Redirect Rules, DNS, SSL mode, Origin CA certificate | Cloudflare dashboard, in the zone of the relevant domain | Follow [DEPLOYMENT.md section 9](DEPLOYMENT.md#9-web-server-and-ssl) and [section 11](DEPLOYMENT.md#11-cloudflare-settings) |
| Adding a domain to the existing site (never clone the site) | aaPanel > Website > Domain Manager (Path A), or the Nginx `server_name` (Path B), as in [DEPLOYMENT.md](DEPLOYMENT.md) | Origin CA certificate must cover the new domain; SSL mode Full (strict) |
| WordPress site URL | WordPress Settings > General (WordPress Address and Site Address), or `WP_HOME` / `WP_SITEURL` in `wp-config.php` | Purge caches |
| Absolute URLs stored in the WordPress database | Database, via WP-CLI search-replace (sections 2.3 and 2.4) | Purge caches |

"Restart services" means the general rule in [DEPLOYMENT.md "Updating"](DEPLOYMENT.md#updating--redeploying-with-new-code): after any `.env` change run `config:clear`, then restart the queue workers, Reverb and the scheduler, because they keep the config in memory. The restart commands are listed once, in section 2.1 (response, step 5).

**Why shortcodes make the embed host a one-place change.** Posts store only `[hls_embed_vl id="N" ratio="W / H" autoplay="1" muted="1"]`; they never store the embed host. The WPCode PHP snippet "HLS Embed shortcode" builds the iframe and reads the host from the single constant `HLS_EMBED_HOST`. Change that one line, purge caches, and every post uses the new host. Admins get the shortcode from the dashboard "Copy shortcode" button in the embed dialog of the videos page.

**Limits of redirects (stated once).** A 301 redirect (a Cloudflare Redirect Rule on the OLD zone, preserving path and query) does NOT help users in Vietnam when the ISP cuts the connection or DNS before HTTP is reached. It only helps Googlebot, VPN users and other networks.

## 2. Per-site playbooks

### 2.1 Embed site (domain B to standby domain C)

Role: this is the Laravel dashboard host and the iframe host. WordPress shows the player inside an iframe that points to `https://B/embed/{id}`. If `B` is blocked, the iframe stays empty, so the iframe host must move to `C`.

#### Before a block (prepare)

Do these while nothing is blocked. Nothing here changes how the live site works until the response steps.

1. Registrar: buy the standby domain `C`. Do not use `.vn`.
2. Cloudflare dashboard: add `C` as a new zone on the same Cloudflare account as the R2 bucket.
3. Cloudflare dashboard, zone `C` > DNS: add a DNS record of type A for `C` pointing to the same VPS IP as `B`, **Proxied** (orange cloud). Same origin as `B` (see [DEPLOYMENT.md section 0](DEPLOYMENT.md#0-prerequisites-and-accounts)).
4. Add `C` to the EXISTING site; never clone the site or create a second one.
   - aaPanel (Path A): Website > the existing site > Domain Manager > add `C`.
   - Plain VPS (Path B): add `C` to `server_name` in both `server` blocks of the Nginx file, then test and reload.

   Why: edit the Nginx site file (Path B only).

   ```bash
   sudo nano /etc/nginx/sites-available/hls-r2-studio
   ```

   Why: check the syntax before reloading.

   ```bash
   sudo nginx -t
   ```

   Why: apply the change.

   ```bash
   sudo systemctl reload nginx
   ```
5. Cloudflare dashboard, zone `C` > SSL/TLS > Origin Server: create an Origin CA certificate that covers `C` (add `*.C` only if you need it), install it on the origin (aaPanel site > SSL, or the Nginx certificate files), then set SSL mode **Full (strict)** and **Always Use HTTPS**. Follow [DEPLOYMENT.md section 9](DEPLOYMENT.md#9-web-server-and-ssl) and [section 11, step 2](DEPLOYMENT.md#11-cloudflare-settings). Install the certificate before switching to Full (strict), otherwise you get 521/526.
   - Verify: whether one Origin CA certificate can list hostnames from two different zones (`B` and `C`), and how aaPanel or Nginx should hold two certificates for one site. If one certificate cannot cover both, install a separate certificate for `C`.
6. Cloudflare dashboard, zone `C`: repeat the rest of [DEPLOYMENT.md section 11](DEPLOYMENT.md#11-cloudflare-settings) for the new zone:
   - WebSockets on (step 1).
   - Cache Rule for the embed page: hostname equals `C` and URI path starts with `/embed/` (step 3).
   - WAF Skip rule for `/embed/`, `/apps/` and `/app/` (step 5). `/apps/` matters because after the switch the VPS publishes Reverb events through `https://C/apps/...`.
7. Cloudflare dashboard > R2 > the bucket > Settings > Custom Domains: add `cdn.C` to the SAME bucket, next to `cdn.B`. Then, in zone `C`, add the Cache Rule for `cdn.C` ([section 11, step 4](DEPLOYMENT.md#11-cloudflare-settings)) and the hotlink rule ([section 11, step 6](DEPLOYMENT.md#11-cloudflare-settings)). The hotlink rule must allow the Referer of the embed host that will actually play the video, so on zone `C` use `C` where DEPLOYMENT.md uses the embed domain, and keep empty Referer allowed.
   - Verify once in the Cloudflare dashboard: that one bucket can have several custom domains, so `cdn.C` can be attached next to `cdn.B`, and that the zone of `C` must be on the same Cloudflare account as the bucket.
8. Cloudflare dashboard > R2 > the bucket > Settings > CORS policy: ADD `https://C` to `AllowedOrigins` and keep `https://B`. The policy format is in [DEPLOYMENT.md section 11, step 7](DEPLOYMENT.md#11-cloudflare-settings); the result looks like this:

   ```json
   [{"AllowedOrigins":["https://B","https://C"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
9. Write down the standby values for the dashboard. Write them down only; do NOT apply them yet. They go into the VPS `.env` of the dashboard at response step 2:

   | Variable | Now | Standby value |
   |---|---|---|
   | `APP_URL` | `https://B` | `https://C` |
   | `REVERB_HOST` | `B` | `C` |
   | `REVERB_PORT`, `REVERB_SCHEME` | `443`, `https` | unchanged |
   | `REVERB_ALLOWED_ORIGINS` | `B` | `C` (hostname only; comma-separated if you need both) |
   | `R2_URL` | `https://cdn.B` | `https://cdn.C` (see section 2.2) |

   `CORS_ALLOWED_ORIGINS` and `REPORT_ALLOWED_HOSTS` hold WordPress domains, so they do not change for this section (they change in section 2.4).
   - Verify: where the playback-report call to `POST /api/reports` is made from. The caller is not in this repository; if a script on the WordPress site calls `https://B/api/reports`, it must be updated to `C`.
10. Embed allowlist: keep it as is. It lists WordPress domains (Dashboard Settings > Embed protection > Allowed domains), not the embed domain. Do nothing here unless the WordPress domain changes (section 2.4).
11. Test on WP Staging (not on the live site):
    - In the staging copy of the WPCode snippet "HLS Embed shortcode", set `HLS_EMBED_HOST` to `https://C`, purge the staging caches, and open posts that contain `[hls_embed_vl id="N"]`. The iframe must load from `C`.
    - Also test the embed page directly while `APP_URL` is still `B`. Why: confirm the response headers (`content-security-policy: frame-ancestors ...`, `cache-control`):

      ```bash
      curl -sI https://C/embed/ID
      ```

    - Verify: whether embed page assets depend on `APP_URL`. In this repository `resources/views/embed/show.blade.php` loads its libraries from cdnjs and builds the playlist URL from `R2_URL`, with no `asset()`, `route()` or `@vite` call, but this was not tested in a browser. Open `https://C/embed/ID` with DevTools > Network and look for any request that goes to `B` instead of `C` (or fails).
    - Playback can be refused during this test: the page loads the playlist from `cdn.B` while the Referer is `C`, and the hotlink rule on zone `B` blocks that. If you see 403 on `cdn.B`, that is the cause. The iframe, the allowlist and the player shell are still validated; full playback is validated in the response phase once `R2_URL` points to `cdn.C`.

#### After a block (response)

1. Confirm the block: from a network in Vietnam (or a checking service), `B` and `cdn.B` do not load. Do not start the steps below for a domain that still loads.
2. VPS `.env` of the dashboard: apply the standby values from prepare step 9. Edit the file (do not print or paste it):

   ```bash
   cd <project path>
   ```

   ```bash
   nano .env
   ```

   Because `B` blocked means `cdn.B` blocked, set `R2_URL` in the same edit and then follow section 2.2 to verify it. If you set `R2_URL` now and the iframe host is still `B`, playback breaks until step 8 is done, so do steps 2 to 8 in one session.
3. VPS: reload the config.

   ```bash
   <PHP> artisan config:clear
   ```
4. VPS: rebuild the frontend, because `REVERB_HOST` changed and the browser value is baked into the JS (skip only if you did not change any `REVERB_*` value).

   ```bash
   npm run build
   ```
5. VPS: restart the long-running services (they keep the old config in memory). A queue restart interrupts a video that is being transcoded, so restart workers when no video is processing, or use the graceful `queue:restart` instead.

   ```bash
   sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2
   ```

   ```bash
   sudo systemctl restart hls-r2-studio-reverb
   ```

   ```bash
   sudo systemctl restart hls-r2-studio-scheduler
   ```

   Why: fix file ownership after root-run artisan commands ([DEPLOYMENT.md section 8](DEPLOYMENT.md#8-file-permissions)).

   ```bash
   sudo chown -R <USER>:<USER> storage bootstrap/cache
   ```

   ```bash
   sudo chmod -R 775 storage bootstrap/cache
   ```
6. Check the dashboard on `C`. Why: confirm the new host is served (expect 200):

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://C/up
   ```

   Then log in at `https://C/login` and open a page with live progress; in browser DevTools the `wss://C/app/...` connection must show status 101.
7. Embed allowlist: not changed (it lists WordPress domains).
8. WPCode snippet "HLS Embed shortcode" on the WordPress site: change the one line `HLS_EMBED_HOST` to `https://C` (https only, no path). Save and keep the snippet Active.
9. Purge ALL page caches: the caching plugin on the WordPress site, and the Cloudflare cache of the WordPress zone. Also purge the Cloudflare cache of zone `C` for `/embed/*` if you opened embed pages there before `R2_URL` was changed, because those pages are cached for up to 5 minutes and contain the old playlist host.
10. Verify from a network in Vietnam: open posts with videos and play them. The page source of a post must show iframes starting with `https://C/embed/`.

    ```bash
    curl -sI https://C/embed/ID
    ```

    Expect `cache-control: public, max-age=60, s-maxage=300` and, on the second request, `cf-cache-status: HIT`.
11. Cloudflare dashboard, zone `B` > Rules > Redirect Rules: add a 301 from `B` to `https://C`, preserving path and query. Do not match `cdn.B`. It does not help users in Vietnam (see the limits in section 1). Verify: the exact Cloudflare dashboard labels and expression syntax.

### 2.2 Custom domain (R2, `cdn.B` to `cdn.C`)

Role: `cdn.B` is the Cloudflare R2 custom domain that serves the HLS files (`.m3u8` playlists and `.ts` segments). The player on the embed page downloads them from there. It is a subdomain of `B`, so a block on `B` also blocks it.

Why only `R2_URL` changes: the database stores only RELATIVE `playlist_path` values. The full URL is built at runtime from `R2_URL` (`config/filesystems.php`, disk `r2`), and the ffmpeg playlist uses relative segment names (`segment_%03d.ts`). So switching the CDN host needs only `R2_URL`, the R2 custom domain and the R2 CORS policy. No re-upload and no database change.

#### Before a block (prepare)

1. Cloudflare dashboard > R2 > the bucket > Settings > Custom Domains: `cdn.C` must be attached to the same bucket (section 2.1, prepare step 7).
2. Cloudflare dashboard > R2 > the bucket > Settings > CORS policy: `https://C` must be in `AllowedOrigins` next to `https://B` (section 2.1, prepare step 8).
3. Cloudflare dashboard, zone `C`: the cache rule for `cdn.C` and the hotlink rule from [DEPLOYMENT.md section 11](DEPLOYMENT.md#11-cloudflare-settings) (steps 4 and 6) are in place. The TTL notes there apply unchanged: Edge TTL 1 day, Browser TTL 2 hours; a deleted video can still be served from the edge for up to the TTL, and on the free plan purge works per URL only.
4. Test the standby host with a real file. Get a real playlist path from a ready video: open its embed page, DevTools > Network, and note the `.m3u8` request path (without the host). Why: the same relative path must also work on `cdn.C`:

   ```bash
   curl -I https://cdn.C/<relative-path-to-playlist>.m3u8
   ```

   Expect `HTTP/2 200`. Verify: the exact folder layout of a video on R2 (from the Network tab) instead of assuming it.

#### After a block (response)

1. VPS `.env` of the dashboard: set `R2_URL=https://cdn.C` (done in the same edit as section 2.1, response step 2, when `B` is also blocked).
2. VPS: `config:clear` and restart the services, as in section 2.1 response steps 3 and 5. `npm run build` is not needed for `R2_URL` alone.
3. Cloudflare dashboard: purge the cache of the embed pages if they were cached with the old host (section 2.1, response step 9). Purge `cdn.C` only if you uploaded or changed files there before; on the free plan purge works per URL.
4. Verify a playlist. Why: confirm the new host serves the playlist:

   ```bash
   curl -I https://cdn.C/<relative-path-to-playlist>.m3u8
   ```

5. Verify a segment. Why: confirm segments are served too (take a segment name from the playlist; they are relative, like `segment_000.ts`):

   ```bash
   curl -I https://cdn.C/<relative-path-to-folder>/segment_000.ts
   ```

6. Open a video in a browser (embed page) with DevTools > Console and Network: there must be no CORS errors, and `.m3u8` and `.ts` requests must go to `cdn.C`. A CORS error means `https://C` is missing from the R2 CORS policy.
7. Old videos keep working: their stored paths are relative, so they resolve against the new `R2_URL` with no re-upload.

### 2.3 FIFU (follows the embed / cdn domain)

Role: the FIFU plugin (Featured Image from URL) on the WordPress site shows images that live on `cdn.B`.

**What search-replace is for here.** FIFU stores the ABSOLUTE URL of each image, such as `https://cdn.B/...`, in the WordPress database. Shortcodes cannot fix this, because those URLs are not in a shortcode. Search-replace rewrites the old host to the new host inside the database, and it must be serialized-data aware (so PHP-serialized values do not break). WP-CLI `wp search-replace` is serialized-aware and is the only tool used in this playbook for database work.

Verify: FIFU internals (which meta keys or tables hold the URL) were not inspected in this repository. Confirm them with the dry runs below before changing anything.

#### Before a block (prepare)

1. Read the WP-CLI rules once; sections 2.3 and 2.4 both follow them:
   - (a) Check that WP-CLI is installed. Why: confirm the `wp` command exists:

     ```bash
     wp --info
     ```

   - (b) Run WP-CLI as `<WP_USER>` (the system user that owns the WordPress files), never as root. If you are logged in as root, write `sudo -u <WP_USER> wp <command> --path=<wp path>`. Do NOT use `--allow-root`. The commands below are written as `wp <command> --path=<wp path>`; add the `sudo -u <WP_USER>` prefix when you are root.
   - (c) WP-CLI reads the database credentials and the table prefix from that site's `wp-config.php`, so no password is typed anywhere. To work on staging, point `--path` at `<wp staging path>` instead.
   - (d) `--all-tables-with-prefix` limits the command to the tables of that one site.
   - (e) Always run `--dry-run` first.
   - Verify: the flags used in this playbook exist in your WP-CLI version (`wp search-replace --help`: `--report-changed-only`, `--skip-columns`, `--include-columns`, `--all-tables-with-prefix`; `wp db tables --help`; `wp db export --help`).
2. Diagnostic 1 (read-only). Why: see whether FIFU has its own tables:

   ```bash
   wp db tables --all-tables-with-prefix --path=<wp path> | grep -i fifu
   ```

3. Diagnostic 2 (dry run, writes nothing). Why: the per-table and per-column counts show WHERE the cdn host is stored:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Write down the tables and columns that have matches.
4. Diagnostic 3 (dry run, writes nothing). Why: see whether the `guid` column holds the cdn host (this checks only that column):

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --include-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

5. Decide about GUIDs: leave GUIDs untouched (keep `--skip-columns=guid`) unless diagnostic 3 shows that attachment GUIDs hold the cdn URL. Verify: whether FIFU stores the cdn URL in `guid`.
6. Rehearse on WP Staging first. Staging has its own WordPress directory and database, so point `--path` at it. Why: check the counts and the thumbnails on staging before touching the live site:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp staging path>
   ```

#### After a block (response)

Run this after section 2.2 is done, so the new host `cdn.C` already serves the files. Follow the WP-CLI rules from prepare step 1.

1. Back up the database first. Why: a way back if the replace goes wrong; keep the file until everything is verified:

   ```bash
   wp db export ~/wp-before-cdn-switch.sql --path=<wp path>
   ```

2. Dry run (no changes written). Why: preview the counts on the live site:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

3. Review the counts against the prepare dry run: they must match. If they are far off, stop and re-check.
4. Real run (the same command without `--dry-run`). Why: rewrite the old cdn host to the new one in the database:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

5. Purge caches: the caching plugin, Cloudflare (WordPress zone), and any FIFU cache setting in the plugin.
6. Verify thumbnails on the home page, an archive page and a single post, and check that the Open Graph image (page source, `og:image`) points to `cdn.C`.
7. Keep the backup file until everything is verified, then delete it.

- Fallback: if WP-CLI cannot be installed on the server, the Better Search Replace plugin (installed inside that same WordPress site, it only changes that site's database) can do the same replace from the WordPress admin: Tools > Better Search Replace, dry run first, "Replace GUIDs" off.

### 2.4 Main site (WordPress, domain A to standby domain D)

Role: the WordPress site itself. This is the heaviest change and is only needed when `A` is blocked.

**What search-replace is for here.** WordPress stores absolute URLs of its own domain in posts, postmeta, options (often serialized: widgets, theme settings, page builder data) and more. Changing the WordPress domain means rewriting `https://A` to `https://D` in the database safely, with the serialized-aware WP-CLI `wp search-replace` (same tool and same WP-CLI rules as section 2.3, prepare step 1).

#### Before a block (prepare)

1. Registrar and Cloudflare dashboard: buy the standby domain `D` (not `.vn`) and add it as a zone on Cloudflare.
2. Google Search Console: make sure both properties (`A` and `D`) are verified. Verify: the requirements of the Change of Address tool for the property types.
3. Confirm WP-CLI works on the WordPress server (rules in section 2.3, prepare step 1). Why: confirm the `wp` command exists:

   ```bash
   wp --info
   ```

4. Record the current values. Why: the current Site Address (`siteurl`):

   ```bash
   wp option get siteurl --path=<wp path>
   ```

   Why: the current Home address (`home`):

   ```bash
   wp option get home --path=<wp path>
   ```

   Why: check whether the URLs are fixed in code as constants (`WP_HOME` / `WP_SITEURL`); the command does not print the password:

   ```bash
   grep -E "WP_HOME|WP_SITEURL" <wp path>/wp-config.php
   ```

5. List the places that hold absolute URLs of `A`. Why: this dry run writes nothing, and its table and column counts show where `A` is stored (posts, postmeta, options, and so on):

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

6. Note the dashboard side that references `A`: the embed allowlist (Dashboard Settings > Embed protection > Allowed domains), `CORS_ALLOWED_ORIGINS` and `REPORT_ALLOWED_HOSTS` in the VPS `.env`.
7. Rehearse the complete switch `A` to `D` on WP Staging (use `--path=<wp staging path>`) and note how long it takes.

#### After a block (response)

1. Confirm the block: from a network in Vietnam (or a checking service), `A` does not load.
2. Add `D` to the EXISTING WordPress site (never clone it): aaPanel > Website > the WordPress site > Domain Manager > add `D` (plain VPS: add `D` to `server_name` of that site in Nginx). Then, in the Cloudflare dashboard, zone `D`: DNS record `D` proxied to the same origin, Origin CA certificate covering `D` (and `*.D` if needed), SSL mode Full (strict). See [DEPLOYMENT.md section 9](DEPLOYMENT.md#9-web-server-and-ssl) and [section 11](DEPLOYMENT.md#11-cloudflare-settings).
   - Verify: until the Site Address changes (step 6), WordPress may redirect requests for `D` back to `A`.
3. Back up the database. Why: a way back if the replace goes wrong:

   ```bash
   wp db export ~/wp-before-domain-switch.sql --path=<wp path>
   ```

4. Replace the `https` form. Why: dry run first, no changes written:

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Review the counts against the prepare dry run, then do the real run. Why: rewrite `https://A` to `https://D` in the database:

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

5. Repeat for the `http` form. Why: dry run first:

   ```bash
   wp search-replace 'http://A' 'http://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Why: the real run:

   ```bash
   wp search-replace 'http://A' 'http://D' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

   If the site also used a `www.` form of `A`, run the same four commands for that host.
6. Site Address: search-replace has already rewritten `home` and `siteurl` (they are stored in the options table). Check WordPress admin on `D` > Settings > General: WordPress Address and Site Address must be `https://D`. If they are not, or if you prefer the WP-CLI way, set them. Why: set the Home address:

   ```bash
   wp option update home 'https://D' --path=<wp path>
   ```

   Why: set the Site Address:

   ```bash
   wp option update siteurl 'https://D' --path=<wp path>
   ```

   If they are fixed in code, change `WP_HOME` and `WP_SITEURL` in `wp-config.php` instead.
7. Update the dashboard:
   - Dashboard Settings page > Settings > Embed protection > Allowed domains: add `D` (database setting, not `.env`), then Save. Keep `A` until you retire it.
   - VPS `.env`: set `CORS_ALLOWED_ORIGINS` to include `https://D` (with scheme) and `REPORT_ALLOWED_HOSTS` to include `D` (without scheme), then reload:

     ```bash
     <PHP> artisan config:clear
     ```

     Restart the services as in section 2.1 response step 5. No `npm run build` is needed (no `REVERB_*` change).
8. Purge ALL page caches (caching plugin and Cloudflare for zone `D`). Cached embed pages can take up to 5 minutes to reflect the allowlist change.
9. Cloudflare dashboard, zone `A` > Rules > Redirect Rules: 301 from `A` to `https://D`, preserving path and query. It does not help users in Vietnam (see the limits in section 1). Verify: the exact Cloudflare labels and expression syntax.
10. Google Search Console: use Change of Address from `A` to `D`. Keep the redirect for at least 1 year (Google asks for at least 180 days).
11. Verify on `D`: open several posts with videos; the player must load and play (an iframe that is refused means `D` is missing from the embed allowlist), and thumbnails must load.

## 3. Telling users the new domain

This part is optional.

- Google Search Console: Change of Address for the WordPress site (section 2.4, response step 10).
- Keep the brand name and site title the same, so people can find the new domain by searching the name on Google.
- Use channels you own: fan page, Telegram or Zalo group, email list. Post the new domain there.
- Do not rely on redirects for blocked users; they do not reach the old domain (see the limits in section 1).
- Announce only after everything is verified (section 5).

## 4. Drill and monitoring

- Rehearse the whole switch once on WP Staging and time it. Update the standby lists after the drill.
- Ask someone in Vietnam, or use a checking service, to test `A`, `B` and `cdn.B` periodically.
- Keep the standby domains `C`, `cdn.C` and `D` configured but unused (zones, DNS, certificates, R2 custom domain, CORS), so a switch is only the response steps.
- Keep a copy of the WPCode snippet "HLS Embed shortcode" outside WordPress (password manager or private repository). If the snippet is lost, every shortcode shows as plain text.

## 5. One-page runbook (do in this order)

In this runbook `B` means the EMBED domain and `A` the WordPress domain. If only some hosts are blocked, run only the matching items.

| # | What | Why this order |
|---|---|---|
| 1 | `B` (embed host): section 2.1 response. Switch the VPS `.env`, services and `HLS_EMBED_HOST` to `C` | Videos are what users watch, and this needs no WordPress database change |
| 2 | cdn: section 2.2 response. `R2_URL` to `cdn.C`, verify `.m3u8` and `.ts` | `cdn.B` is a subdomain of `B` and playback needs it; it uses the same `.env` edit as item 1 |
| 3 | FIFU: section 2.3 response. Search-replace `https://cdn.B` to `https://cdn.C` | Thumbnails depend on the cdn host, so run it after the cdn works |
| 4 | Main site `A`: section 2.4 response. Switch WordPress to `D` | The heaviest change; only needed when `A` itself is blocked, so do it separately and last |
| 5 | Cache: purge the caching plugin and Cloudflare | Repeat after every host change; old pages keep the old host until purged |
| 6 | Announce: section 3 | Last, once everything is verified |

## 6. Quick reference

| Symptom | What to check |
|---|---|
| Post shows the plain text `[hls_embed_vl ...]` | The WPCode snippet is inactive or missing. Open WPCode, check the snippet "HLS Embed shortcode" is Active with location "Run Everywhere"; restore it from your outside copy if lost |
| Page source has `<!-- hls-embed: invalid configuration -->` | `HLS_EMBED_HOST` in the snippet is missing, not `https`, or invalid; or the shortcode `id` is invalid |
| Iframe is refused or blank | The embed allowlist is missing the WordPress domain (Dashboard Settings > Embed protection > Allowed domains); cached embed pages can take up to 5 minutes to update |
| Player loads but the video does not play | R2 CORS policy missing the embed origin, `R2_URL` wrong, `cdn.C` not attached to the bucket, or the hotlink rule blocking the Referer. Check the browser console and Network tab; see section 2.2 |
| Thumbnails are broken | FIFU still points to the old cdn host: section 2.3 |
| The old host is still served | Page cache not purged (caching plugin and Cloudflare) |
| Dashboard live progress stops after the switch | `REVERB_*` values wrong, `npm run build` not run, or Reverb not restarted; see [DEPLOYMENT.md troubleshooting pointers](DEPLOYMENT.md#troubleshooting-pointers) |
| Cloudflare 521 / 526 on the new domain | Origin certificate missing or SSL mode Full (strict) set too early: [DEPLOYMENT.md section 9](DEPLOYMENT.md#9-web-server-and-ssl) |
| Report API calls fail with CORS errors | `CORS_ALLOWED_ORIGINS` is missing the WordPress origin; see the Q&A in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#common-errors-fixes-and-qa) |
