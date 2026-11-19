<?php

use App\Http\Controllers\Api\App\AuthController as AppAuthController;
use App\Http\Controllers\Api\App\ConfigController as AppConfigController;
use App\Http\Controllers\Api\App\LogController as AppLogController;
use App\Http\Controllers\Api\App\OverviewController as AppOverviewController;
use App\Http\Controllers\Api\App\R2Controller as AppR2Controller;
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
        Route::get('/r2', [AppR2Controller::class, 'show'])->name('r2.show');
        Route::put('/r2', [AppR2Controller::class, 'update'])->name('r2.update');
        Route::post('/r2/test', [AppR2Controller::class, 'test'])->middleware('throttle:10,1')->name('r2.test');
        Route::get('/videos', [AppVideoController::class, 'index'])->name('videos.index');
        Route::post('/videos', [AppVideoController::class, 'store'])->name('videos.store');

        // Literal paths come before {video}; the numeric constraint also keeps "status" and "bulk-destroy" away from it.
        Route::get('/videos/status', [AppVideoController::class, 'status'])->name('videos.status');
        Route::delete('/videos/bulk-destroy', [AppVideoController::class, 'bulkDestroy'])->name('videos.bulk-destroy');

        Route::middleware('throttle:20,1')->group(function () {
            Route::post('/videos/{video}/image', [AppVideoController::class, 'storeImage'])->whereNumber('video')->name('videos.image.store');
        });
        Route::delete('/videos/{video}/image', [AppVideoController::class, 'destroyImage'])->whereNumber('video')->name('videos.image.destroy');
        Route::get('/videos/{video}/status-log', [AppVideoController::class, 'statusLog'])->whereNumber('video')->name('videos.status-log');
        Route::get('/videos/{video}', [AppVideoController::class, 'show'])->whereNumber('video')->name('videos.show');
        Route::put('/videos/{video}', [AppVideoController::class, 'update'])->whereNumber('video')->name('videos.update');
        Route::delete('/videos/{video}', [AppVideoController::class, 'destroy'])->whereNumber('video')->name('videos.destroy');

        Route::get('/overview', [AppOverviewController::class, 'show'])->name('overview');
        Route::get('/logs', [AppLogController::class, 'index'])->name('logs.index');
    });
});
