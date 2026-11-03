<?php

namespace App\Providers;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Config is not loaded yet in bootstrap/app.php, so the trusted proxy list is applied here.
        TrustProxies::at(config('app.trusted_proxies'));

        if (config('app.force_https')) {
            URL::forceScheme('https');
        }

        Carbon::macro('toDisplay', function (string $format = 'd/m/Y H:i') {
            static $timezone = null;

            if ($timezone === null) {
                $timezone = Setting::current()->display_timezone ?: config('app.timezone');
            }

            return $this->clone()->timezone($timezone)->format($format);
        });

        View::composer('layouts.app', function ($view) {
            $view->with('inProgressVideos', Video::inProgressSnapshot());
        });

        RateLimiter::for('report-page-url', function (Request $request) {
            $pageUrl = (string) $request->input('page_url', 'unknown');

            return Limit::perMinutes(10, 20)->by(sha1($pageUrl));
        });

        // Desktop app login: 5 attempts per minute per IP + username (hashed, so the key length is bounded).
        RateLimiter::for('app-login', function (Request $request) {
            $username = $request->input('username');
            $username = is_string($username) ? mb_strtolower($username) : '';

            return Limit::perMinute(5)->by('app-login:'.$request->ip().'|'.sha1($username));
        });

        // Authenticated desktop app routes: 60 requests per minute per token.
        RateLimiter::for('app-api', function (Request $request) {
            $tokenId = $request->user()?->currentAccessToken()?->id;

            return Limit::perMinute(60)->by('app-api:'.($tokenId ?? $request->user()?->getAuthIdentifier() ?? $request->ip()));
        });

        // Each upload limiter has its own key, so chunk requests never consume the init or activity-log budget.
        foreach (['upload-init' => 'init', 'upload-chunk' => 'chunk', 'activity-log' => 'activity_log'] as $name => $configKey) {
            RateLimiter::for($name, function (Request $request) use ($name, $configKey) {
                $maxAttempts = (int) config('videos.upload_rate_limits.'.$configKey);

                return Limit::perMinute($maxAttempts)->by($name.':'.($request->user()?->getAuthIdentifier() ?? $request->ip()));
            });
        }
    }
}
