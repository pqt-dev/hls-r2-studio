<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
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
        $ttlHours = config('videos.orphaned_upload_ttl_hours');
        $cutoff = now()->subHours($ttlHours)->getTimestamp();

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
