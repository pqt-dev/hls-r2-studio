/**
 * HLS Migrate for WPCode: one-time conversion of raw HLS embed iframes in post_content into [hls_embed_vl ...] shortcodes.
 *
 * HOW TO USE
 *   Run staging first and back up the database before anything else.
 *   WPCode -> Add Snippet -> Add Your Custom Code (New Snippet) -> PHP Snippet,
 *   Location "Admin Only", paste this whole file, then switch to Active and Save.
 *   Open Tools -> HLS Migrate (administrators with manage_options only), tick "Include revisions" if wanted, click Scan.
 *   Scan is read-only: it writes only one transient (hls_migrate_scanned_{user_id}, 1 hour) that unlocks Apply.
 *   Apply needs the "I have backed up the database" checkbox. Before changing a post the original content is saved
 *   once in post meta _hls_migrate_backup; "Restore this post" puts it back and removes the meta.
 *   Only iframes exactly as produced by the dashboard Copy button are converted; anything else is listed as "Not matched".
 *   When finished: purge all page caches (caching plugin and Cloudflare), then deactivate and delete this snippet.
 */

if ( ! function_exists( 'hls_migrate_meta_key' ) ) {
	/**
	 * Post meta key that holds the original content backup.
	 *
	 * @return string
	 */
	function hls_migrate_meta_key() {
		return '_hls_migrate_backup';
	}
}

if ( ! function_exists( 'hls_migrate_per_page' ) ) {
	/**
	 * Number of posts processed per scan page.
	 *
	 * @return int
	 */
	function hls_migrate_per_page() {
		return 50;
	}
}

if ( ! function_exists( 'hls_migrate_pattern' ) ) {
	/**
	 * Regex matching exactly the iframe produced by the dashboard's buildEmbedIframeCode().
	 *
	 * @return string
	 */
	function hls_migrate_pattern() {
		return '~<iframe\s+src="https://[A-Za-z0-9.-]+(?::[0-9]+)?/embed/(?P<id>[0-9]{1,18})'
			. '(?:\?(?P<q>autoplay=1(?:(?:&amp;|&\#038;|&)muted=1)?|muted=1))?"'
			. '\s+style="\s*width:\s*100%;\s*aspect-ratio:\s*(?P<w>[0-9]{1,4})\s*/\s*(?P<h>[0-9]{1,4})\s*;'
			. '\s*max-height:\s*75vh;\s*border:\s*0;\s*"'
			. '\s+allowfullscreen\s+allow="autoplay;\s*fullscreen"\s*>\s*</iframe>~';
	}
}

if ( ! function_exists( 'hls_migrate_convert_details' ) ) {
	/**
	 * Convert matching iframes and report each old/new pair.
	 *
	 * @param string $content Post content.
	 * @return array array( string $new_content, int $count, array $pairs ) where each pair is array( old, new ).
	 */
	function hls_migrate_convert_details( $content ) {
		$pairs = array();

		$new = preg_replace_callback(
			hls_migrate_pattern(),
			function ( $m ) use ( &$pairs ) {
				$w = (int) $m['w'];
				$h = (int) $m['h'];

				// Zero ratio is not a valid dashboard output: leave the iframe untouched (reported as unmatched).
				if ( $w <= 0 || $h <= 0 ) {
					return $m[0];
				}

				$q = isset( $m['q'] ) ? $m['q'] : '';

				$shortcode = '[hls_embed_vl id="' . $m['id'] . '"';
				if ( 16 !== $w || 9 !== $h ) {
					$shortcode .= ' ratio="' . $w . ' / ' . $h . '"';
				}
				if ( 0 === strpos( $q, 'autoplay=1' ) ) {
					$shortcode .= ' autoplay="1"';
				}
				if ( false !== strpos( $q, 'muted=1' ) ) {
					$shortcode .= ' muted="1"';
				}
				$shortcode .= ']';

				$pairs[] = array( $m[0], $shortcode );

				return $shortcode;
			},
			(string) $content
		);

		if ( null === $new ) {
			return array( (string) $content, 0, array() );
		}

		return array( $new, count( $pairs ), $pairs );
	}
}

if ( ! function_exists( 'hls_migrate_convert' ) ) {
	/**
	 * Pure conversion of raw HLS iframes into shortcodes.
	 *
	 * @param string $content Post content.
	 * @return array array( string $new_content, int $count ).
	 */
	function hls_migrate_convert( $content ) {
		$result = hls_migrate_convert_details( $content );

		return array( $result[0], $result[1] );
	}
}

if ( ! function_exists( 'hls_migrate_find_unmatched' ) ) {
	/**
	 * Find iframes whose src is /embed/<digits> but that do not match the exact pattern.
	 * Matching iframes are converted first, so already converted content yields nothing for them.
	 * Other iframes (e.g. YouTube with a non-numeric id) are ignored.
	 *
	 * @param string $content Post content.
	 * @return array List of iframe opening tags.
	 */
	function hls_migrate_find_unmatched( $content ) {
		$result = hls_migrate_convert_details( $content );
		$found  = array();

		if ( preg_match_all( '~<iframe\b[^>]*?\bsrc\s*=\s*(["\'])[^"\'>]*?/embed/[0-9]+(?:[?#/]|\1)[^>]*>~i', $result[0], $matches ) ) {
			$found = $matches[0];
		}

		return $found;
	}
}

if ( ! function_exists( 'hls_migrate_count_unmatched' ) ) {
	/**
	 * Count unmatched /embed/ iframes.
	 *
	 * @param string $content Post content.
	 * @return int
	 */
	function hls_migrate_count_unmatched( $content ) {
		return count( hls_migrate_find_unmatched( $content ) );
	}
}

if ( ! function_exists( 'hls_migrate_truncate' ) ) {
	/**
	 * Truncate text for display.
	 *
	 * @param string $text   Text.
	 * @param int    $length Max length.
	 * @return string
	 */
	function hls_migrate_truncate( $text, $length = 260 ) {
		$text = (string) $text;

		if ( function_exists( 'mb_strlen' ) && function_exists( 'mb_substr' ) ) {
			return mb_strlen( $text ) > $length ? mb_substr( $text, 0, $length ) . '...' : $text;
		}

		return strlen( $text ) > $length ? substr( $text, 0, $length ) . '...' : $text;
	}
}

if ( ! function_exists( 'hls_migrate_scope_sql' ) ) {
	/**
	 * Build the post type/status WHERE fragment (without prepare).
	 *
	 * @param bool $include_revisions Include revisions.
	 * @return array array( string $sql, array $args ).
	 */
	function hls_migrate_scope_sql( $include_revisions ) {
		global $wpdb;

		$args = array( 'post', 'page', 'publish', 'private', 'draft', 'pending', 'future' );
		$sql  = '( ( post_type IN (%s,%s) AND post_status IN (%s,%s,%s,%s,%s) )';

		if ( $include_revisions ) {
			$sql .= " OR ( post_type = 'revision' AND post_status = 'inherit' )";
		}

		$sql .= ' )';

		return array( $sql, $args );
	}
}

if ( ! function_exists( 'hls_migrate_query_page' ) ) {
	/**
	 * Read one batch of posts whose content contains "/embed/".
	 *
	 * @param int  $paged             Page number (1-based).
	 * @param bool $include_revisions Include revisions.
	 * @return array array( array $rows, int $total ).
	 */
	function hls_migrate_query_page( $paged, $include_revisions ) {
		global $wpdb;

		$per_page = hls_migrate_per_page();
		$like     = '%' . $wpdb->esc_like( '/embed/' ) . '%';
		list( $scope, $args ) = hls_migrate_scope_sql( $include_revisions );

		$count_sql = "SELECT COUNT(*) FROM {$wpdb->posts} WHERE {$scope} AND post_content LIKE %s";
		$total     = (int) $wpdb->get_var( $wpdb->prepare( $count_sql, array_merge( $args, array( $like ) ) ) );

		$rows_sql = "SELECT ID, post_title, post_type, post_status, post_content FROM {$wpdb->posts} WHERE {$scope} AND post_content LIKE %s ORDER BY ID ASC LIMIT %d OFFSET %d";
		$rows     = $wpdb->get_results(
			$wpdb->prepare( $rows_sql, array_merge( $args, array( $like, $per_page, max( 0, ( $paged - 1 ) * $per_page ) ) ) )
		);

		return array( is_array( $rows ) ? $rows : array(), $total );
	}
}

if ( ! function_exists( 'hls_migrate_fetch_rows' ) ) {
	/**
	 * Read specific posts (same scope rules as the scan) by id.
	 *
	 * @param int[] $ids               Post ids.
	 * @param bool  $include_revisions Include revisions.
	 * @return array
	 */
	function hls_migrate_fetch_rows( $ids, $include_revisions ) {
		global $wpdb;

		$ids = array_values( array_unique( array_filter( array_map( 'absint', (array) $ids ) ) ) );
		if ( ! $ids ) {
			return array();
		}

		list( $scope, $args ) = hls_migrate_scope_sql( $include_revisions );
		$placeholders         = implode( ',', array_fill( 0, count( $ids ), '%d' ) );

		$sql  = "SELECT ID, post_title, post_type, post_status, post_content FROM {$wpdb->posts} WHERE {$scope} AND ID IN ({$placeholders}) ORDER BY ID ASC";
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, array_merge( $args, $ids ) ) );

		return is_array( $rows ) ? $rows : array();
	}
}

if ( ! function_exists( 'hls_migrate_backup_rows' ) ) {
	/**
	 * Read posts that currently have a backup meta (first batch only).
	 *
	 * @return array
	 */
	function hls_migrate_backup_rows() {
		global $wpdb;

		$sql  = "SELECT p.ID, p.post_title, p.post_type, p.post_status FROM {$wpdb->posts} p INNER JOIN {$wpdb->postmeta} m ON m.post_id = p.ID WHERE m.meta_key = %s ORDER BY p.ID ASC LIMIT %d";
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, hls_migrate_meta_key(), hls_migrate_per_page() ) );

		return is_array( $rows ) ? $rows : array();
	}
}

if ( ! function_exists( 'hls_migrate_transient_key' ) ) {
	/**
	 * Transient key that records "a Scan ran for this user".
	 *
	 * @return string
	 */
	function hls_migrate_transient_key() {
		return 'hls_migrate_scanned_' . get_current_user_id();
	}
}

if ( ! function_exists( 'hls_migrate_write_content' ) ) {
	/**
	 * Write post_content directly (no kses, no revision, no save_post hooks) and clear the post cache.
	 *
	 * @param int    $id      Post id.
	 * @param string $content New content.
	 * @return bool
	 */
	function hls_migrate_write_content( $id, $content ) {
		global $wpdb;

		$result = $wpdb->update( $wpdb->posts, array( 'post_content' => $content ), array( 'ID' => (int) $id ), array( '%s' ), array( '%d' ) );

		if ( false === $result ) {
			return false;
		}

		clean_post_cache( (int) $id );

		return true;
	}
}

if ( ! function_exists( 'hls_migrate_apply_rows' ) ) {
	/**
	 * Apply the conversion to the given post rows.
	 *
	 * @param array $rows Rows from hls_migrate_fetch_rows().
	 * @return array Stats: posts, iframes, unmatched, errors.
	 */
	function hls_migrate_apply_rows( $rows ) {
		$stats = array(
			'posts'     => 0,
			'iframes'   => 0,
			'unmatched' => 0,
			'errors'    => 0,
		);

		foreach ( $rows as $row ) {
			$id                  = (int) $row->ID;
			list( $new, $count ) = hls_migrate_convert( $row->post_content );

			if ( 0 === $count || $new === $row->post_content ) {
				continue;
			}

			// Keep the very first original: never overwrite an existing backup. wp_slash() offsets add_post_meta()'s unslash.
			if ( ! metadata_exists( 'post', $id, hls_migrate_meta_key() ) ) {
				add_post_meta( $id, hls_migrate_meta_key(), wp_slash( $row->post_content ), true );
			}
			if ( ! metadata_exists( 'post', $id, hls_migrate_meta_key() ) ) {
				++$stats['errors'];
				continue;
			}

			if ( ! hls_migrate_write_content( $id, $new ) ) {
				++$stats['errors'];
				continue;
			}

			++$stats['posts'];
			$stats['iframes']   += $count;
			$stats['unmatched'] += hls_migrate_count_unmatched( $new );
		}

		return $stats;
	}
}

if ( ! function_exists( 'hls_migrate_restore_post' ) ) {
	/**
	 * Restore one post from its backup meta, then delete the meta.
	 *
	 * @param int $id Post id.
	 * @return bool
	 */
	function hls_migrate_restore_post( $id ) {
		$id = absint( $id );

		if ( ! $id || ! metadata_exists( 'post', $id, hls_migrate_meta_key() ) ) {
			return false;
		}

		$backup = get_post_meta( $id, hls_migrate_meta_key(), true );
		if ( ! is_string( $backup ) || '' === $backup ) {
			return false;
		}

		if ( ! hls_migrate_write_content( $id, $backup ) ) {
			return false;
		}

		delete_post_meta( $id, hls_migrate_meta_key() );

		return true;
	}
}

if ( ! function_exists( 'hls_migrate_register_menu' ) ) {
	/**
	 * Register Tools -> HLS Migrate.
	 */
	function hls_migrate_register_menu() {
		add_management_page( 'HLS Migrate', 'HLS Migrate', 'manage_options', 'hls-migrate', 'hls_migrate_render_page' );
	}
}

if ( ! function_exists( 'hls_migrate_notice' ) ) {
	/**
	 * Print an admin notice.
	 *
	 * @param string $type    success|warning|error|info.
	 * @param string $message Plain text message.
	 */
	function hls_migrate_notice( $type, $message ) {
		echo '<div class="notice notice-' . esc_attr( $type ) . '"><p>' . esc_html( $message ) . '</p></div>';
	}
}

if ( ! function_exists( 'hls_migrate_row_header' ) ) {
	/**
	 * Print the title/id/type/status/edit-link cells of a table row.
	 *
	 * @param object $row Post row.
	 */
	function hls_migrate_row_header( $row ) {
		$id    = (int) $row->ID;
		$title = '' !== (string) $row->post_title ? $row->post_title : '(no title)';
		$link  = get_edit_post_link( $id, 'raw' );

		echo '<td>' . esc_html( $title );
		if ( $link ) {
			echo ' &ndash; <a href="' . esc_url( $link ) . '">Edit</a>';
		}
		echo '</td>';
		echo '<td>' . esc_html( (string) $id ) . '</td>';
		echo '<td>' . esc_html( $row->post_type . ' / ' . $row->post_status ) . '</td>';
	}
}

if ( ! function_exists( 'hls_migrate_render_page' ) ) {
	/**
	 * Render the Tools -> HLS Migrate page and handle Scan / Apply / Restore requests.
	 */
	function hls_migrate_render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html( 'You do not have permission to access this page.' ) );
		}

		$is_post = isset( $_SERVER['REQUEST_METHOD'] ) && 'POST' === $_SERVER['REQUEST_METHOD'];
		$source  = $is_post ? $_POST : $_GET; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Verified below.
		$scan    = false;
		$notices = array();

		$paged     = isset( $source['paged'] ) ? max( 1, absint( $source['paged'] ) ) : 1;
		$revisions = ! empty( $source['revisions'] );

		if ( $is_post && isset( $_POST['hls_do'] ) ) {
			check_admin_referer( 'hls_migrate_apply' );
			$scan = true;
			$do   = sanitize_text_field( wp_unslash( $_POST['hls_do'] ) );

			if ( preg_match( '/^restore_one:([0-9]+)$/', $do, $m ) ) {
				if ( hls_migrate_restore_post( (int) $m[1] ) ) {
					$notices[] = array( 'success', 'Post ' . (int) $m[1] . ' restored from backup and the backup meta was removed.' );
				} else {
					$notices[] = array( 'error', 'Restore failed for post ' . (int) $m[1] . ': no usable backup or database error.' );
				}
			} elseif ( preg_match( '/^(apply_one:[0-9]+|apply_selected|apply_all)$/', $do ) ) {
				if ( false === get_transient( hls_migrate_transient_key() ) ) {
					$notices[] = array( 'error', 'Apply refused: run a Scan first (the scan marker expired or is missing).' );
				} elseif ( empty( $_POST['hls_backup_ok'] ) ) {
					$notices[] = array( 'error', 'Apply refused: confirm "I have backed up the database" first.' );
				} else {
					$ids = array();
					if ( preg_match( '/^apply_one:([0-9]+)$/', $do, $m ) ) {
						$ids = array( (int) $m[1] );
					} elseif ( 'apply_selected' === $do ) {
						$ids = isset( $_POST['ids'] ) && is_array( $_POST['ids'] ) ? array_map( 'absint', wp_unslash( $_POST['ids'] ) ) : array();
					} else {
						list( $page_rows ) = hls_migrate_query_page( $paged, $revisions );
						foreach ( $page_rows as $page_row ) {
							$ids[] = (int) $page_row->ID;
						}
					}

					if ( ! $ids ) {
						$notices[] = array( 'warning', 'Nothing selected.' );
					} else {
						$stats     = hls_migrate_apply_rows( hls_migrate_fetch_rows( $ids, $revisions ) );
						$notices[] = array(
							$stats['errors'] ? 'warning' : 'success',
							sprintf(
								'Apply finished: %d post(s) changed, %d iframe(s) converted, %d unmatched iframe(s) left in changed posts, %d error(s).',
								$stats['posts'],
								$stats['iframes'],
								$stats['unmatched'],
								$stats['errors']
							),
						);
					}
				}
			}
		} elseif ( ! $is_post && ! empty( $_GET['scan'] ) ) {
			check_admin_referer( 'hls_migrate_scan' );
			$scan = true;
		}

		echo '<div class="wrap"><h1>HLS Migrate</h1>';

		hls_migrate_notice( 'warning', 'Run this on staging first and back up the database before applying. After finishing, purge all page caches (caching plugin and Cloudflare), then deactivate and delete this snippet.' );

		foreach ( $notices as $notice ) {
			hls_migrate_notice( $notice[0], $notice[1] );
		}

		// Scan form (read-only).
		echo '<form method="get" action="' . esc_url( admin_url( 'tools.php' ) ) . '">';
		echo '<input type="hidden" name="page" value="hls-migrate" /><input type="hidden" name="scan" value="1" />';
		wp_nonce_field( 'hls_migrate_scan' );
		echo '<p><label><input type="checkbox" name="revisions" value="1"' . checked( $revisions, true, false ) . ' /> Include revisions</label> ';
		echo '<button type="submit" class="button button-primary">Scan (dry run)</button></p></form>';

		if ( ! $scan ) {
			echo '</div>';
			return;
		}

		// Scan marker: the only write a Scan performs.
		set_transient( hls_migrate_transient_key(), 1, HOUR_IN_SECONDS );

		list( $rows, $total ) = hls_migrate_query_page( $paged, $revisions );
		$total_pages          = max( 1, (int) ceil( $total / hls_migrate_per_page() ) );

		$matched   = array();
		$unmatched = array();
		foreach ( $rows as $row ) {
			$details = hls_migrate_convert_details( $row->post_content );
			if ( $details[1] > 0 ) {
				$matched[] = array( $row, $details[2] );
			}
			$bad = hls_migrate_find_unmatched( $row->post_content );
			if ( $bad ) {
				$unmatched[] = array( $row, $bad );
			}
		}

		echo '<p>' . esc_html( sprintf( 'Page %d of %d. Posts containing "/embed/": %d (batch size %d).', $paged, $total_pages, $total, hls_migrate_per_page() ) ) . '</p>';

		echo '<form method="post" action="' . esc_url( admin_url( 'tools.php?page=hls-migrate' ) ) . '">';
		wp_nonce_field( 'hls_migrate_apply' );
		echo '<input type="hidden" name="paged" value="' . esc_attr( (string) $paged ) . '" />';
		if ( $revisions ) {
			echo '<input type="hidden" name="revisions" value="1" />';
		}

		echo '<p><label><input type="checkbox" id="hls-migrate-backup" name="hls_backup_ok" value="1" /> I have backed up the database</label></p>';
		echo '<p><button type="submit" name="hls_do" value="apply_selected" class="button hls-migrate-apply" disabled>Apply selected</button> ';
		echo '<button type="submit" name="hls_do" value="apply_all" class="button button-primary hls-migrate-apply" disabled>Apply all on this page</button></p>';

		echo '<h2>Matched (will be converted)</h2>';
		if ( ! $matched ) {
			echo '<p>No matching iframes on this page.</p>';
		} else {
			echo '<table class="widefat striped"><thead><tr><th></th><th>Title</th><th>ID</th><th>Type / status</th><th>Matches</th><th>Old iframe &rarr; new shortcode</th><th>Action</th></tr></thead><tbody>';
			foreach ( $matched as $item ) {
				list( $row, $pairs ) = $item;
				$id                  = (int) $row->ID;

				echo '<tr><td><input type="checkbox" name="ids[]" value="' . esc_attr( (string) $id ) . '" /></td>';
				hls_migrate_row_header( $row );
				echo '<td>' . esc_html( (string) count( $pairs ) ) . '</td><td>';
				foreach ( $pairs as $pair ) {
					echo '<div><code>' . esc_html( hls_migrate_truncate( $pair[0] ) ) . '</code><br />&rarr; <code>' . esc_html( $pair[1] ) . '</code></div><hr />';
				}
				echo '</td><td><button type="submit" name="hls_do" value="' . esc_attr( 'apply_one:' . $id ) . '" class="button hls-migrate-apply" disabled>Apply this post</button>';
				if ( metadata_exists( 'post', $id, hls_migrate_meta_key() ) ) {
					echo ' <button type="submit" name="hls_do" value="' . esc_attr( 'restore_one:' . $id ) . '" class="button">Restore this post</button>';
				}
				echo '</td></tr>';
			}
			echo '</tbody></table>';
		}

		echo '<h2>Not matched (manual)</h2>';
		if ( ! $unmatched ) {
			echo '<p>None on this page.</p>';
		} else {
			echo '<p>These /embed/ iframes differ from the exact dashboard format and are left untouched. Fix them by hand.</p>';
			echo '<table class="widefat striped"><thead><tr><th>Title</th><th>ID</th><th>Type / status</th><th>Iframe tags</th></tr></thead><tbody>';
			foreach ( $unmatched as $item ) {
				list( $row, $tags ) = $item;
				echo '<tr>';
				hls_migrate_row_header( $row );
				echo '<td>';
				foreach ( $tags as $tag ) {
					echo '<div><code>' . esc_html( hls_migrate_truncate( $tag ) ) . '</code></div>';
				}
				echo '</td></tr>';
			}
			echo '</tbody></table>';
		}

		echo '<h2>Posts with a backup (restore)</h2>';
		$backups = hls_migrate_backup_rows();
		if ( ! $backups ) {
			echo '<p>No backups stored.</p>';
		} else {
			echo '<table class="widefat striped"><thead><tr><th>Title</th><th>ID</th><th>Type / status</th><th>Action</th></tr></thead><tbody>';
			foreach ( $backups as $row ) {
				echo '<tr>';
				hls_migrate_row_header( $row );
				echo '<td><button type="submit" name="hls_do" value="' . esc_attr( 'restore_one:' . (int) $row->ID ) . '" class="button">Restore this post</button></td></tr>';
			}
			echo '</tbody></table>';
		}

		echo '</form>';

		// Pagination (each link carries a fresh scan nonce).
		if ( $total_pages > 1 ) {
			echo '<p>';
			for ( $i = 1; $i <= $total_pages; $i++ ) {
				if ( $i === $paged ) {
					echo '<strong>' . esc_html( (string) $i ) . '</strong> ';
					continue;
				}
				$url = add_query_arg(
					array(
						'page'      => 'hls-migrate',
						'scan'      => 1,
						'paged'     => $i,
						'revisions' => $revisions ? 1 : 0,
						'_wpnonce'  => wp_create_nonce( 'hls_migrate_scan' ),
					),
					admin_url( 'tools.php' )
				);
				echo '<a href="' . esc_url( $url ) . '">' . esc_html( (string) $i ) . '</a> ';
			}
			echo '</p>';
		}

		// Enable the Apply buttons only while the backup checkbox is ticked (the server enforces this too).
		echo '<script>(function(){var c=document.getElementById("hls-migrate-backup");if(!c){return;}var b=document.querySelectorAll(".hls-migrate-apply");c.addEventListener("change",function(){for(var i=0;i<b.length;i++){b[i].disabled=!c.checked;}});})();</script>';
		echo '</div>';
	}
}

add_action( 'admin_menu', 'hls_migrate_register_menu' );
