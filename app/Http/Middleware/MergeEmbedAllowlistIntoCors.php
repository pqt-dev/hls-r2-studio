<?php

namespace App\Http\Middleware;

use App\Models\Setting;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class MergeEmbedAllowlistIntoCors
{
    public const CORS_ORIGINS_ATTRIBUTE = 'embed_allowlist_cors_origins';

    public const CORS_PATTERNS_ATTRIBUTE = 'embed_allowlist_cors_patterns';

    public const REPORT_HOSTS_ATTRIBUTE = 'embed_allowlist_report_hosts';

    /**
     * Config keys holding the env-only CORS values, snapshotted on first use
     * so every request merges onto the same base (idempotent, no build-up of
     * stale origins when the config repository outlives a request).
     */
    private const BASE_ORIGINS_KEY = 'cors.embed_allowlist_base_allowed_origins';

    private const BASE_PATTERNS_KEY = 'cors.embed_allowlist_base_allowed_origins_patterns';

    /**
     * Merge the embed allowlist from the Settings page into the CORS config
     * for api/* requests, before HandleCors reads it. Prepended to the global
     * stack so other routes never touch the database because of this.
     * The derived values are also stored on the request for the report API.
     */
    public function handle(Request $request, Closure $next): Response
    {
        if (! $request->is('api/*')) {
            return $next($request);
        }

        $config = app('config');

        if (! $config->has(self::BASE_ORIGINS_KEY)) {
            $config->set(self::BASE_ORIGINS_KEY, (array) $config->get('cors.allowed_origins', []));
            $config->set(self::BASE_PATTERNS_KEY, (array) $config->get('cors.allowed_origins_patterns', []));
        }

        // One primary-key lookup; a missing table or row means env-only behaviour.
        $text = Setting::findWithoutCreating()?->embed_allowed_domains;

        $origins = Setting::embedAllowlistCorsOrigins($text);
        $patterns = Setting::embedAllowlistCorsPatterns($text);

        $config->set('cors.allowed_origins', array_values(array_unique([...$config->get(self::BASE_ORIGINS_KEY), ...$origins])));
        $config->set('cors.allowed_origins_patterns', array_values(array_unique([...$config->get(self::BASE_PATTERNS_KEY), ...$patterns])));

        $request->attributes->set(self::CORS_ORIGINS_ATTRIBUTE, $origins);
        $request->attributes->set(self::CORS_PATTERNS_ATTRIBUTE, $patterns);
        $request->attributes->set(self::REPORT_HOSTS_ATTRIBUTE, Setting::embedAllowlistReportHosts($text));

        return $next($request);
    }
}
