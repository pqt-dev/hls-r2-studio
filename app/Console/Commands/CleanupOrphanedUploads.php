<?php

namespace App\Console\Commands;

use App\Models\Video;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;

class CleanupOrphanedUploads extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'videos:cleanup-orphaned-uploads';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Delete original uploaded files left behind by a transcode job that never ran to completion';

    /**
     * Execute the console command.
     */
    public function handle(): void
    {
        if (config('videos.keep_original_upload')) {
            $this->info('keep_original_upload is enabled; skipping.');

            return;
        }

        $ttlHours = config('videos.orphaned_upload_ttl_hours');
        $cutoff = now()->subHours($ttlHours)->getTimestamp();

        // An upload file's mtime is roughly its video's created_at and there
        // is no file-to-video mapping, so never delete files newer than one
        // hour before the oldest video still waiting for or running its job.
        $oldestActive = Video::whereIn('status', ['pending', 'processing'])->min('created_at');

        if ($oldestActive !== null) {
            $cutoff = min($cutoff, Carbon::parse($oldestActive)->getTimestamp() - 3600);
        }

        $files = Storage::disk('local')->files('uploads');
        $deletedCount = 0;

        foreach ($files as $file) {
            $lastModified = Storage::disk('local')->lastModified($file);

            if ($lastModified !== false && $lastModified < $cutoff) {
                Storage::disk('local')->delete($file);
                $deletedCount++;
            }
        }

        $this->info("Deleted {$deletedCount} orphaned upload files.");
    }
}
