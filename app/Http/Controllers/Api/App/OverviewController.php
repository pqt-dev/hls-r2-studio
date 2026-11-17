<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Services\VideoLogs;
use App\Support\SystemStats;
use Illuminate\Http\JsonResponse;

class OverviewController extends Controller
{
    /**
     * The numbers shown on the web overview dashboard: video counts and server CPU/RAM/disk usage.
     */
    public function show(VideoLogs $logs): JsonResponse
    {
        $counts = $logs->counts();
        $stats = SystemStats::snapshot();

        return response()->json([
            'videos' => [
                'total' => $counts['total'],
                'ready' => $counts['success'],
                'processing' => $counts['processing'],
                'failed' => $counts['error'],
            ],
            'system' => [
                'cpu_percent' => $stats['cpuPercent'],
                'cpu_cores' => $stats['cpuCores'],
                'load_avg_1min' => $stats['loadAvg1min'],
                'ram_percent' => $stats['ramPercent'],
                'ram_used_gb' => $stats['ramUsedGb'],
                'ram_total_gb' => $stats['ramTotalGb'],
                'disk_percent' => $stats['diskPercent'],
                'disk_used_gb' => $stats['diskUsedGb'],
                'disk_total_gb' => $stats['diskTotalGb'],
            ],
        ]);
    }
}
