<?php

namespace App\Jobs;

use App\Jobs\Concerns\FailsVideo;
use App\Models\Video;
use App\Support\UploadAssembler;
use App\Support\VideoProgress;
use App\Support\VideoStatusLogger;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Assembles the chunks of a finished chunked upload into the original file on
 * the queue, then hands the video over to TranscodeVideoJob. The video stays
 * 'pending' (stage 'merging') meanwhile.
 */
class MergeUploadChunksJob implements ShouldQueue
{
    use FailsVideo, Queueable;

    public $tries = 1;

    /**
     * Hard cap (seconds) on how long a merge may run.
     */
    public $timeout = 3600;

    public function __construct(
        public int $videoId,
        public string $localUploadPath,
        public string $uploadId,
    ) {}

    public function handle(): void
    {
        // Atomically claim the merge: only a video that is still waiting
        // ('pending', stage 'queued') is picked up, so a duplicate delivery or
        // a video that was deleted or already handled is a no-op.
        $claimed = Video::where('id', $this->videoId)
            ->where('status', 'pending')
            ->where('stage', 'queued')
            ->update(['stage' => 'merging']);

        if ($claimed === 0) {
            Log::info("MergeUploadChunksJob skipped: video {$this->videoId} is not waiting for a merge (already handled or deleted).");

            return;
        }

        $video = Video::findOrFail($this->videoId);

        try {
            if (File::exists($this->localUploadPath)) {
                // Already assembled (e.g. a redelivery after a crash right
                // after the merge): only the stage needs to be restored.
                $video->stage = 'queued';
                $video->save();
            } else {
                UploadAssembler::assemble($video, $this->uploadId, $this->localUploadPath);
            }

            // Progress at the start of transcoding, i.e. where the merge share ends.
            $video->progress = max(
                (int) $video->progress,
                VideoProgress::overall('transcoding', 0.0, (int) $video->original_size_bytes, true)
            );
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

            TranscodeVideoJob::dispatch($video->id, $this->localUploadPath, null, true);
        } catch (Throwable $e) {
            $failedWhileMerging = $video->stage === 'merging';

            $this->failVideo($video, $e, $failedWhileMerging);

            Log::error('MergeUploadChunksJob failed for video '.$this->videoId.': '.$e->getMessage());

            throw $e;
        }
    }

    /**
     * Called by Laravel when the job fails, including cases where handle()'s
     * catch block never ran (e.g. worker killed or timed out). Idempotent:
     * does nothing unless the video is still pending and merging.
     */
    public function failed(Throwable $e): void
    {
        $video = Video::find($this->videoId);

        if (! $video || $video->status !== 'pending' || $video->stage !== 'merging') {
            return;
        }

        $this->failVideo($video, $e, true);

        Log::error('MergeUploadChunksJob failed for video '.$this->videoId.': '.$e->getMessage());
    }

    /**
     * Mark the video failed and clean up what the merge left behind. Every
     * step is best-effort so one failing cannot skip the rest or mask the
     * original exception.
     */
    private function failVideo(Video $video, Throwable $e, bool $failedWhileMerging): void
    {
        $this->markFailed($video, $e);

        try {
            $video->save();
        } catch (Throwable $saveError) {
            Log::warning('Failed to persist the failed status for video '.$this->videoId.': '.$saveError->getMessage());
        }

        try {
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
        } catch (Throwable $logError) {
            Log::warning('Failed to record the failed status log for video '.$this->videoId.': '.$logError->getMessage());
        }

        $this->cleanupUpload($failedWhileMerging);
    }
}
