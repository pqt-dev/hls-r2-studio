<?php
/**
 * Plugin Name: HLS Embed
 * Description: [hls_embed_vl id="123"] shortcode that renders the HLS Studio embed iframe. The embed host lives in ONE constant (HLS_EMBED_HOST), so posts never store the domain.
 * Version: 1.0.0
 *
 * After updating this file, purge all page caches (caching plugin and Cloudflare).
 *
 * INSTALL
 *   1. Copy this file to wp-content/mu-plugins/hls-embed.php (create the mu-plugins folder if missing).
 *      Must-use plugins load automatically; there is nothing to activate.
 *   2. Add this line to wp-config.php ABOVE the "That's all, stop editing!" comment:
 *
 *          define( 'HLS_EMBED_HOST', 'https://embed-site.com' );
 *
 *      https only, no path; a trailing slash is stripped.
 *      Replace embed-site.com with your embed site's host; if the constant is missing or invalid the shortcode
 *      renders only an HTML comment and logs an error.
 *   3. In posts use the shortcode (also works inside Gutenberg "Custom HTML" blocks):
 *
 *          [hls_embed_vl id="ab12cd34ef56"]
 *
 *      The id is the video public id used in the embed URL (dashboard "Copy shortcode" button).
 *      New videos have a 12-char [a-z0-9] id; legacy numeric ids still work, e.g. [hls_embed_vl id="123"].
 *
 * CHANGING THE DOMAIN LATER
 *   Edit the HLS_EMBED_HOST constant only. Then PURGE all page caches (caching plugin and
 *   Cloudflare), otherwise visitors keep receiving HTML that contains the old host.
 *   No search-replace of post_content is needed: posts no longer contain the host.
 *
 * OPTIONAL ATTRIBUTES
 *   [hls_embed_vl id="123" ratio="4 / 3" autoplay="1" muted="1"]
 *   - ratio:    "W / H" (1-4 digits each, both > 0). Default and fallback for invalid values: 16 / 9.
 *   - autoplay: only the literal "1" is honoured, anything else is ignored.
 *   - muted:    only the literal "1" is honoured, anything else is ignored.
 *   The iframe src gets ?autoplay=1&muted=1 exactly like the dashboard iframe (autoplay first, then muted).
 *   Note: WordPress esc_url() writes the "&" in the src attribute as "&#038;". That is valid HTML and
 *   browsers decode it back to "&", so the URL meaning is identical to the dashboard markup.
 *
 * ONE-TIME MIGRATION OF EXISTING POSTS (raw iframe -> shortcode) with WP-CLI
 *   Run on a STAGING COPY first, then on a few real posts, then everywhere.
 *
 *   # 1. ALWAYS back up the database first
 *   wp db export backup-before-hls-shortcode.sql
 *
 *   # 2. Define helpers in a bash shell. Replace HOST with the host currently stored in the posts, with every dot escaped as \. for the regex.
 *   HOST='embed-site\.com'
 *   PRE='<iframe src="https://'$HOST'/embed/([a-z0-9]+)'
 *   SEP='(?:&|&amp;|&#038;)'
 *   S169='" style="width:100%; aspect-ratio:16 / 9'
 *   SANY='" style="width:100%; aspect-ratio:([0-9]+ / [0-9]+)'
 *   TAIL='; max-height:75vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>'
 *   QAM='\?autoplay=1'$SEP'muted=1'
 *   run() { wp search-replace --regex --regex-delimiter='~' "$1" "$2" wp_posts --include-columns=post_content "${@:3}"; }
 *
 *   # 3. DRY RUN first (changes nothing, reports counts), then the real run: same commands without --dry-run.
 *   #    ORDER MATTERS: the 16 / 9 commands first, the generic-ratio commands last
 *   #    (the generic ratio would also match 16 / 9 and produce a redundant ratio="16 / 9").
 *   # 16 / 9, ratio omitted ($1 = id)
 *   run "$PRE$S169$TAIL"                  '[hls_embed_vl id="$1"]' --dry-run
 *   run "$PRE$QAM$S169$TAIL"              '[hls_embed_vl id="$1" autoplay="1" muted="1"]' --dry-run
 *   run "$PRE"'\?autoplay=1'"$S169$TAIL"  '[hls_embed_vl id="$1" autoplay="1"]' --dry-run
 *   run "$PRE"'\?muted=1'"$S169$TAIL"     '[hls_embed_vl id="$1" muted="1"]' --dry-run
 *   # other ratios ($1 = id, $2 = ratio)
 *   run "$PRE$SANY$TAIL"                  '[hls_embed_vl id="$1" ratio="$2"]' --dry-run
 *   run "$PRE$QAM$SANY$TAIL"              '[hls_embed_vl id="$1" ratio="$2" autoplay="1" muted="1"]' --dry-run
 *   run "$PRE"'\?autoplay=1'"$SANY$TAIL"  '[hls_embed_vl id="$1" ratio="$2" autoplay="1"]' --dry-run
 *   run "$PRE"'\?muted=1'"$SANY$TAIL"     '[hls_embed_vl id="$1" ratio="$2" muted="1"]' --dry-run
 *
 *   Notes:
 *   - The regexes match only the exact iframe the dashboard "Copy" button produces. Iframes edited by hand
 *     (extra attributes, different order, other query params) are NOT matched and stay manual.
 *   - The "&" between autoplay and muted is matched as "&", "&amp;" or "&#038;" (forms WordPress may store).
 *   - Gutenberg Custom HTML blocks wrap content in <!-- wp:html --> ... <!-- /wp:html --> comments.
 *     Verify on staging that the shortcode renders inside those blocks before running on production.
 *   - Revisions live in wp_posts too and will be rewritten as well; limit the scope if undesired.
 *   - After the real run, purge page caches.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Resolve and validate the configured embed host.
 *
 * @return string Host without trailing slash, or '' when missing/invalid.
 */
function hls_embed_get_host() {
	if ( ! defined( 'HLS_EMBED_HOST' ) || ! is_string( HLS_EMBED_HOST ) ) {
		return '';
	}

	$url = esc_url_raw( untrailingslashit( trim( HLS_EMBED_HOST ) ), array( 'https' ) );

	if ( '' === $url || ! wp_http_validate_url( $url ) ) {
		return '';
	}

	if ( 'https' !== wp_parse_url( $url, PHP_URL_SCHEME ) ) {
		return '';
	}

	return untrailingslashit( $url );
}

/**
 * Log a configuration/input problem once per request.
 *
 * @param string $message Static message (never user input).
 */
function hls_embed_log_once( $message ) {
	static $logged = false;

	if ( ! $logged ) {
		$logged = true;
		error_log( 'hls-embed: ' . $message );
	}
}

/**
 * [hls_embed_vl id="123"] shortcode handler.
 *
 * @param array|string $atts Shortcode attributes.
 * @return string
 */
function hls_embed_shortcode( $atts ) {
	$atts = shortcode_atts(
		array(
			'id'       => '',
			'ratio'    => '16 / 9',
			'autoplay' => '',
			'muted'    => '',
		),
		$atts,
		'hls_embed_vl'
	);
	$id   = is_scalar( $atts['id'] ) ? (string) $atts['id'] : '';
	$host = hls_embed_get_host();

	if ( '' === $host ) {
		hls_embed_log_once( 'HLS_EMBED_HOST is missing or not a valid https URL.' );
		return '<!-- hls-embed: invalid configuration -->';
	}

	// Video ids are public ids, 1-32 chars [a-z0-9] (route /embed/{video}); legacy numeric ids still match.
	if ( ! preg_match( '/^[a-z0-9]{1,32}$/', $id ) ) {
		hls_embed_log_once( 'invalid video id.' );
		return '<!-- hls-embed: invalid configuration -->';
	}

	// Ratio "W / H"; invalid values silently fall back to the default. Output is rebuilt from the parsed integers.
	$ratio = '16 / 9';
	if ( is_scalar( $atts['ratio'] ) && preg_match( '/^([0-9]{1,4}) ?\/ ?([0-9]{1,4})$/', (string) $atts['ratio'], $m ) && (int) $m[1] > 0 && (int) $m[2] > 0 ) {
		$ratio = (int) $m[1] . ' / ' . (int) $m[2];
	}

	// Same params and order as the dashboard's buildEmbedIframeCode(); only the literal "1" enables a flag.
	$params = array();
	if ( is_scalar( $atts['autoplay'] ) && '1' === (string) $atts['autoplay'] ) {
		$params[] = 'autoplay=1';
	}
	if ( is_scalar( $atts['muted'] ) && '1' === (string) $atts['muted'] ) {
		$params[] = 'muted=1';
	}

	$src = $host . '/embed/' . $id . ( $params ? '?' . implode( '&', $params ) : '' );

	// Same markup as the dashboard's buildEmbedIframeCode(). esc_url() writes "&" as "&#038;" (equivalent in HTML).
	return '<iframe src="' . esc_url( $src ) . '" style="width:100%; aspect-ratio:' . esc_attr( $ratio ) . '; max-height:75vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>';
}
add_shortcode( 'hls_embed_vl', 'hls_embed_shortcode' );
