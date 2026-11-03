<?php

use App\Http\Controllers\Api\App\AuthController as AppAuthController;
use App\Http\Controllers\Api\App\ConfigController as AppConfigController;
use App\Http\Controllers\Api\App\VideoController as AppVideoController;
use App\Http\Controllers\Api\ReportController;
use App\Http\Middleware\NoStoreResponse;
use Illuminate\Support\Facades\Route;

Route::post('/reports', [ReportController::class, 'store'])
    ->middleware(['throttle:5,10', 'throttle:report-page-url'])
    ->name('api.reports.store');

// Desktop app API: bearer tokens only (Sanctum), never cookies or sessions.
Route::prefix('app')->name('api.app.')->middleware(NoStoreResponse::class)->group(function () {
    Route::post('/login', [AppAuthController::class, 'login'])->middleware('throttle:app-login')->name('login');

    Route::middleware(['auth:sanctum', 'throttle:app-api'])->group(function () {
        Route::post('/logout', [AppAuthController::class, 'logout'])->name('logout');
        Route::get('/config', [AppConfigController::class, 'show'])->name('config');
        Route::post('/videos', [AppVideoController::class, 'store'])->name('videos.store');
    });
});
