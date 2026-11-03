/**
 * HLS Embed shortcode for WPCode: [hls_embed_vl id="123" ratio="16 / 9" autoplay="1" muted="1"]
 *
 * HOW TO USE
 *   WPCode -> Add Snippet -> Add Your Custom Code (New Snippet) -> PHP Snippet,
 *   Location "Run Everywhere", paste this whole file, then switch to Active and Save.
 *   Replace the placeholder https://embed-site.com on the HLS_EMBED_HOST line right below with your embed site's https URL (https only, no path); the placeholder will not play any video.
 *   After changing the host, purge all page caches (caching plugin and Cloudflare).
 *   In posts use [hls_embed_vl id="ab12cd34ef56"] (legacy numeric ids such as id="123" still work); optional ratio="W / H", autoplay="1", muted="1".
 */
if ( ! defined( 'HLS_EMBED_HOST' ) ) { define( 'HLS_EMBED_HOST', 'https://embed-site.com' ); }

if ( ! function_exists( 'hls_embed_get_host' ) ) {
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
}

if ( ! function_exists( 'hls_embed_log_once' ) ) {
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
}

if ( ! function_exists( 'hls_embed_shortcode' ) ) {
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
}

add_shortcode( 'hls_embed_vl', 'hls_embed_shortcode' );
