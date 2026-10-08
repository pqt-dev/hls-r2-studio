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

        // Each upload limiter has its own key, so chunk requests never consume the init or activity-log budget.
        foreach (['upload-init' => 'init', 'upload-chunk' => 'chunk', 'activity-log' => 'activity_log'] as $name => $configKey) {
            RateLimiter::for($name, function (Request $request) use ($name, $configKey) {
                $maxAttempts = (int) config('videos.upload_rate_limits.'.$configKey);

                return Limit::perMinute($maxAttempts)->by($name.':'.($request->user()?->getAuthIdentifier() ?? $request->ip()));
            });
        }
    }
}
