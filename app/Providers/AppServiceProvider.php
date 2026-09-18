<?php

namespace App\Providers;

use App\Models\Setting;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\URL;
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
        if (env('FORCE_HTTPS', config('app.env') === 'production')) {
            URL::forceScheme('https');
        }

        Carbon::macro('toDisplay', function (string $format = 'd/m/Y H:i') {
            static $timezone = null;

            if ($timezone === null) {
                $timezone = Setting::current()->display_timezone ?: config('app.timezone');
            }

            return $this->clone()->timezone($timezone)->format($format);
        });
    }
}
