<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;

class CleanupAbandonedUploads extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'uploads:cleanup-abandoned';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Delete chunked upload directories that have been abandoned longer than the configured TTL';

    /**
     * Execute the console command.
     */
    public function handle(): void
    {
        $ttlHours = config('videos.abandoned_upload_ttl_hours');
        $cutoff = now()->subHours($ttlHours)->getTimestamp();

        $directories = Storage::disk('local')->directories('chunked_uploads');
        $deletedCount = 0;

        foreach ($directories as $directory) {
            $lastModified = $this->lastActivityAt($directory);

            if ($lastModified !== false && $lastModified < $cutoff) {
                Storage::disk('local')->deleteDirectory($directory);
                $deletedCount++;
            }
        }

        $this->info("Deleted {$deletedCount} abandoned upload directories.");
    }

    /**
     * Timestamp of the last activity on a chunked upload: the newest chunk
     * stored so far, or the upload directory itself when no chunk has
     * arrived yet.
     */
    private function lastActivityAt(string $directory): int|false
    {
        $timestamps = [];

        foreach (Storage::disk('local')->files("{$directory}/chunks") as $chunk) {
            $modified = Storage::disk('local')->lastModified($chunk);

            if ($modified !== false) {
                $timestamps[] = $modified;
            }
        }

        if ($timestamps !== []) {
            return max($timestamps);
        }

        return Storage::disk('local')->lastModified($directory);
    }
}
