<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use Illuminate\Http\JsonResponse;

class ConfigController extends Controller
{
    /**
     * R2 credentials and transcode options for the desktop app.
     */
    public function show(): JsonResponse
    {
        $settings = Setting::current();
        $disk = $settings->r2DiskConfig();

        $r2 = [
            'access_key_id' => $disk['key'],
            'secret_access_key' => $disk['secret'],
            'bucket' => $disk['bucket'],
            'endpoint' => $disk['endpoint'],
            'url' => $disk['url'],
        ];

        foreach ($r2 as $value) {
            if (! is_string($value) || trim($value) === '') {
                return response()->json(['error' => 'r2_not_configured'], 409);
            }
        }

        return response()->json([
            'r2' => $r2,
            'transcode' => [
                'resolution' => (string) $settings->transcode_resolution,
                'segment_seconds' => (int) $settings->transcode_segment_seconds,
                'fps' => $settings->transcode_fps === null ? null : (int) $settings->transcode_fps,
            ],
        ]);
    }
}
