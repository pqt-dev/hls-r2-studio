# WordPress snippets

Three files that are pasted into the WordPress site. They are not part of the Laravel runtime.

- `hls-embed.php`: mu-plugin version of the `[hls_embed_vl]` shortcode (copy to `wp-content/mu-plugins/`).
- `hls-embed.wpcode.php`: the same shortcode for the WPCode plugin (PHP Snippet, Run Everywhere).
- `hls-migrate.wpcode.php`: one-time converter of old raw iframes to shortcodes.

Notes:

- `HLS_EMBED_HOST` defaults to the placeholder `https://embed-site.com` and must be replaced with your real embed site URL (https, no path).
- Embed ids are 1-32 chars `[a-z0-9]`; legacy numeric ids are still valid.
- Purge all page caches (caching plugin and Cloudflare) after any change to these snippets or to the host.
