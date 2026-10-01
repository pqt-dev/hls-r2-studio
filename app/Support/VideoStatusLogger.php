<?php

namespace App\Support;

use App\Events\VideoStatusUpdated;
use Illuminate\Support\Facades\Log;
use Throwable;

class VideoStatusLogger
{
    public static function record(int $videoId, string $status, ?string $stage, int $progress): void
    {
        try {
            event(new VideoStatusUpdated($videoId, $status, $stage, $progress));
        } catch (Throwable $e) {
            Log::warning("Failed to broadcast status for video {$videoId}: {$e->getMessage()}");
        }
    }
}
