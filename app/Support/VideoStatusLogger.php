<?php

namespace App\Support;

use App\Events\VideoStatusUpdated;
use App\Models\VideoStatusLog;
use Illuminate\Support\Facades\Log;
use Throwable;

class VideoStatusLogger
{
    public static function record(int $videoId, string $status, ?string $stage, int $progress): void
    {
        try {
            self::persist($videoId, $status, $stage, $progress);
        } catch (Throwable $e) {
            Log::warning("Failed to persist status log for video {$videoId}: {$e->getMessage()}");
        }

        try {
            event(new VideoStatusUpdated($videoId, $status, $stage, $progress));
        } catch (Throwable $e) {
            Log::warning("Failed to broadcast status for video {$videoId}: {$e->getMessage()}");
        }
    }

    private static function persist(int $videoId, string $status, ?string $stage, int $progress): void
    {
        // Cheap indexed check: pruning runs only when a video starts a new group, never per tick.
        $isNewGroup = ! VideoStatusLog::where('video_id', $videoId)->exists();

        VideoStatusLog::create([
            'video_id' => $videoId,
            'status' => $status,
            'stage' => $stage,
            'progress' => $progress,
        ]);

        if ($isNewGroup) {
            ActivityLog::prune();
        }
    }
}
