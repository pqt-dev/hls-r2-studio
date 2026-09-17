<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\SettingsController;
use App\Http\Controllers\VideoController;
use Illuminate\Support\Facades\Route;

Route::middleware('guest')->group(function () {
    Route::get('/login', [AuthController::class, 'showLogin'])->name('login');
    Route::post('/login', [AuthController::class, 'login'])->name('login.attempt')->middleware('throttle:5,1');
});

Route::middleware('auth')->group(function () {
    Route::post('/logout', [AuthController::class, 'logout'])->name('logout');

    Route::get('/', [VideoController::class, 'overview'])->name('dashboard.overview');
    Route::get('/videos', [VideoController::class, 'index'])->name('videos.index');
    Route::get('/upload', [VideoController::class, 'create'])->name('videos.create');
    Route::delete('/videos/bulk-destroy', [VideoController::class, 'bulkDestroy'])->name('videos.bulk-destroy');
    Route::delete('/videos/{video}', [VideoController::class, 'destroy'])->name('videos.destroy');
    Route::get('/logs', [VideoController::class, 'logs'])->name('logs.index');

    Route::post('/uploads/init', [VideoController::class, 'initUpload'])->name('uploads.init')->middleware('throttle:30,1');
    Route::post('/uploads/{uploadId}/chunk', [VideoController::class, 'uploadChunk'])->name('uploads.chunk')->where('uploadId', '[0-9a-f-]{36}')->middleware('throttle:120,1');
    Route::post('/uploads/{uploadId}/complete', [VideoController::class, 'completeUpload'])->name('uploads.complete')->where('uploadId', '[0-9a-f-]{36}');

    Route::get('/settings', [SettingsController::class, 'edit'])->name('settings.edit');
    Route::put('/settings/r2', [SettingsController::class, 'updateR2'])->name('settings.r2');
    Route::put('/settings/transcode', [SettingsController::class, 'updateTranscode'])->name('settings.transcode');
    Route::put('/settings/display', [SettingsController::class, 'updateDisplay'])->name('settings.display');
    Route::put('/settings/password', [SettingsController::class, 'updatePassword'])->name('settings.password');
});
