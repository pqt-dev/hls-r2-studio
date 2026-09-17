<?php

namespace App\Console\Commands;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Throwable;

class CleanupOrphanedTranscodeTmp extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'videos:cleanup-orphaned-tmp';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Delete transcode temp directories left behind by a crashed job, marking stuck videos as failed';

    /**
     * Execute the console command.
     */
    public function handle(): void
    {
        $ttlHours = config('videos.orphaned_transcode_ttl_hours');
        $cutoff = now()->subHours($ttlHours);

        $deletedCount = 0;

        // Detect crashed jobs by querying videos stuck in 'processing', rather
        // than relying on the temp directory existing: the directory may
        // already be gone (deleted by another process, or never created due
        // to a very early crash), which would otherwise leave the video stuck
        // forever.
        $stuckVideos = Video::where('status', 'processing')
            ->where('updated_at', '<', $cutoff)
            ->get();

        foreach ($stuckVideos as $video) {
            $directory = "hls_tmp/{$video->id}";

            if (Storage::disk('local')->exists($directory)) {
                Storage::disk('local')->deleteDirectory($directory);
                $deletedCount++;
            }

            $this->cleanupRemoteFiles($video);

            $video->status = 'failed';
            $video->stage = 'failed';
            $video->error_message = 'Processing was interrupted unexpectedly and could not be completed. Please try uploading the video again.';
            $video->save();
        }

        // Separate pass: remove leftover temp directories for videos that are
        // no longer 'processing' (deleted from the database entirely, or
        // already in a terminal state such as 'ready'/'failed'). A directory
        // left behind in either case is definitely stale, regardless of how
        // recently it was touched: the normal job flow always calls
        // cleanup() before leaving the 'processing' state, so a directory
        // still present here means that cleanup() itself failed (e.g. disk
        // I/O error) and the temp files were never removed.
        $directories = Storage::disk('local')->directories('hls_tmp');

        foreach ($directories as $directory) {
            $videoId = (int) basename($directory);
            $video = Video::find($videoId);

            if (! $video || $video->status !== 'processing') {
                Storage::disk('local')->deleteDirectory($directory);
                $deletedCount++;
            }
        }

        $this->info("Deleted {$deletedCount} orphaned transcode temp directories.");
    }

    /**
     * Best-effort removal of objects a crashed job may have left on R2. Any
     * problem here is logged and swallowed: it must never prevent the video
     * from being marked as failed.
     */
    private function cleanupRemoteFiles(Video $video): void
    {
        if (! $video->disk_prefix) {
            return;
        }

        try {
            Setting::current()->r2Disk()->deleteDirectory($video->disk_prefix);
        } catch (Throwable $e) {
            Log::error('Failed to clean up partially uploaded R2 files for video '.$video->id.' (prefix: '.$video->disk_prefix.'): '.$e->getMessage());
        }
    }
}
