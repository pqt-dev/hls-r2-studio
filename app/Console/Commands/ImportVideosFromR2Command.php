<?php

namespace App\Console\Commands;

use App\Jobs\ImportVideoFromR2Job;
use App\Models\Video;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;
use Throwable;

class ImportVideosFromR2Command extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'videos:import-from-r2 {--dry-run : Chỉ liệt kê danh sách, không tạo record hay dispatch job}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Import existing video files from the read-only source R2 bucket and queue them for HLS transcoding';

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $keys = collect(Storage::disk('r2_source')->allFiles())
            ->filter(fn (string $key) => preg_match('/\.(mp4|mov|mkv|avi|webm)$/i', $key) === 1)
            ->values();

        $found = $keys->count();

        if ($found === 0) {
            $this->warn('No video files found in the r2_source bucket.');

            return self::SUCCESS;
        }

        if ($this->option('dry-run')) {
            $rows = $keys->map(fn (string $key) => [
                $key,
                $this->formatBytes(Storage::disk('r2_source')->size($key)),
            ])->all();

            $this->table(['File', 'Size'], $rows);
            $this->info("Found: {$found} file(s). Dry-run: no record created, no job queued.");

            return self::SUCCESS;
        }

        $queued = 0;
        $skipped = 0;
        $errors = 0;

        foreach ($keys as $key) {
            try {
                $basename = basename($key);

                $alreadyImported = Video::where('original_filename', $basename)
                    ->where('status', '!=', 'failed')
                    ->exists();

                if ($alreadyImported) {
                    $this->warn("Skipped (already imported): {$basename}");
                    $skipped++;

                    continue;
                }

                $video = Video::create([
                    'title' => pathinfo($basename, PATHINFO_FILENAME),
                    'original_filename' => $basename,
                    'original_size_bytes' => Storage::disk('r2_source')->size($key),
                    'status' => 'pending',
                ]);

                ImportVideoFromR2Job::dispatch($video->id, $key);

                $this->info("Queued: {$basename} (video #{$video->id})");
                $queued++;
            } catch (Throwable $e) {
                $this->error("Error on {$key}: ".$e->getMessage());
                $errors++;
            }
        }

        $this->info("Found: {$found} | Queued: {$queued} | Skipped (already imported): {$skipped} | Errors: {$errors}");

        return self::SUCCESS;
    }

    private function formatBytes(int $bytes): string
    {
        if ($bytes >= 1024 ** 3) {
            return number_format($bytes / 1024 ** 3, 2).' GB';
        }

        if ($bytes >= 1024 ** 2) {
            return number_format($bytes / 1024 ** 2, 2).' MB';
        }

        return number_format($bytes / 1024, 2).' KB';
    }
}
