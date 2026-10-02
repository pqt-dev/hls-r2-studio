<?php

namespace App\Support;

use App\Events\VideoStatusUpdated;
use App\Models\VideoStatusLog;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

class VideoStatusLogger
{
    private const MAX_TRACKED_VIDEOS = 5;

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
        $trackedVideoIds = VideoStatusLog::query()->distinct()->pluck('video_id');

        if (! $trackedVideoIds->contains($videoId) && $trackedVideoIds->count() >= self::MAX_TRACKED_VIDEOS) {
            $oldestVideoId = VideoStatusLog::query()
                ->select('video_id')
                ->groupBy('video_id')
                ->orderBy(DB::raw('MIN(created_at)'))
                ->value('video_id');

            if ($oldestVideoId !== null) {
                VideoStatusLog::where('video_id', $oldestVideoId)->delete();
            }
        }

        VideoStatusLog::create([
            'video_id' => $videoId,
            'status' => $status,
            'stage' => $stage,
            'progress' => $progress,
        ]);
    }
}
