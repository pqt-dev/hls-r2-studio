<?php

use App\Http\Controllers\Api\ReportController;
use Illuminate\Support\Facades\Route;

Route::post('/reports', [ReportController::class, 'store'])
    ->middleware(['throttle:5,10', 'throttle:report-page-url'])
    ->name('api.reports.store');
