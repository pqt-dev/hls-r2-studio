<?php

namespace App\Console\Commands;

use App\Models\Setting;
use App\Models\Video;
use App\Services\StoryboardGenerator;
use Illuminate\Console\Command;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\Process;
use Throwable;

class BackfillStoryboards extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'videos:backfill-storyboards {--dry-run} {--limit=}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'One-off backfill: generate storyboards for videos that were HLS-encoded before the storyboard feature existed, sourcing the original mp4 from the media bucket by matching filename';

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $mediaBucket = config('videos.media_bucket');

        if (! $mediaBucket) {
            $this->error('No media bucket is configured. Set MEDIA_R2_BUCKET before running this command.');

            return self::FAILURE;
        }

        $mediaDisk = $this->mediaDisk($mediaBucket);

        $query = Video::where('status', 'ready')
            ->whereNull('storyboards')
            ->orderBy('id');

        if ($this->option('limit') !== null) {
            $query->limit((int) $this->option('limit'));
        }

        $videos = $query->get();

        $keysByBasename = $this->indexSourcesByBasename($mediaDisk);

        $dryRun = (bool) $this->option('dry-run');
        $succeeded = 0;
        $noMatch = [];
        $ambiguous = [];
        $failed = [];

        foreach ($videos as $video) {
            $keys = $keysByBasename[$video->original_filename] ?? [];

            if ($keys === []) {
                $this->warn("Video {$video->id}: no source file named '{$video->original_filename}' in the media bucket, skipping.");
                Log::warning('Storyboard backfill found no matching source file in the media bucket.', [
                    'video_id' => $video->id,
                    'original_filename' => $video->original_filename,
                ]);

                $noMatch[] = $video;

                continue;
            }

            if (count($keys) > 1) {
                $this->warn("Video {$video->id}: '{$video->original_filename}' matches several source files in the media bucket, skipping: ".implode(', ', $keys));
                Log::warning('Storyboard backfill found several matching source files in the media bucket; skipping rather than guessing which one is correct.', [
                    'video_id' => $video->id,
                    'original_filename' => $video->original_filename,
                    'keys' => $keys,
                ]);

                $ambiguous[] = $video;

                continue;
            }

            $key = $keys[0];

            if ($dryRun) {
                $this->line("Video {$video->id}: {$video->original_filename} -> {$key}");

                continue;
            }

            $tmpDir = Storage::disk('local')->path("storyboard_backfill_tmp/{$video->id}");

            try {
                if ($this->backfill($video, $mediaDisk, $key, $tmpDir)) {
                    $succeeded++;
                    $this->line("Video {$video->id}: storyboards generated from {$key}.");
                } else {
                    $failed[] = $video;
                }
            } finally {
                File::deleteDirectory($tmpDir);
            }
        }

        $this->summarise($videos->count(), $succeeded, $noMatch, $ambiguous, $failed);

        return self::SUCCESS;
    }

    /**
     * The media bucket disk: the app's own R2 credentials (which have been
     * granted read access to it), pointed at a different bucket.
     */
    private function mediaDisk(string $bucket): Filesystem
    {
        $settings = Setting::current();
        $base = config('filesystems.disks.r2');

        return Storage::build([
            'driver' => 's3',
            'key' => $settings->r2_access_key_id ?: $base['key'],
            'secret' => $settings->r2_secret_access_key ?: $base['secret'],
            'region' => 'auto',
            'bucket' => $bucket,
            'endpoint' => $settings->r2_endpoint ?: $base['endpoint'],
            'use_path_style_endpoint' => true,
        ]);
    }

    /**
     * Index every file in the media bucket by its exact basename, which is what
     * the videos table stores as original_filename. A basename shared by two
     * different objects is kept as a list so the caller can refuse to guess.
     *
     * @return array<string, list<string>>
     */
    private function indexSourcesByBasename(Filesystem $mediaDisk): array
    {
        $index = [];

        foreach ($mediaDisk->allFiles() as $key) {
            $index[basename($key)][] = $key;
        }

        return $index;
    }

    /**
     * Generate and upload the storyboards for one video, returning false
     * (without updating the row) if any step could not be completed. The
     * object key layout is deterministic, so a video left untouched here is
     * safely retried by a later run.
     */
    private function backfill(Video $video, Filesystem $mediaDisk, string $key, string $tmpDir): bool
    {
        if (! $video->disk_prefix) {
            Log::warning('Storyboard backfill skipped a video with no disk prefix; there is no R2 directory to upload into.', [
                'video_id' => $video->id,
            ]);

            return false;
        }

        File::ensureDirectoryExists($tmpDir);

        $localPath = "{$tmpDir}/source.mp4";

        try {
            $this->downloadSource($mediaDisk, $key, $localPath);
        } catch (Throwable $e) {
            Log::error('Storyboard backfill failed to download the source video from the media bucket.', [
                'video_id' => $video->id,
                'key' => $key,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        $duration = $this->probeDuration($localPath);

        if ($duration === null || $duration <= 0) {
            Log::warning('Storyboard backfill could not determine the duration of the source video; skipping.', [
                'video_id' => $video->id,
                'key' => $key,
            ]);

            return false;
        }

        try {
            (new StoryboardGenerator)->generate($localPath, $tmpDir, $duration, $video->id);
        } catch (Throwable $e) {
            Log::warning('Storyboard backfill failed to generate storyboards.', [
                'video_id' => $video->id,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        $paths = StoryboardGenerator::paths($tmpDir, $video->disk_prefix);

        if ($paths === null) {
            Log::warning('Storyboard backfill produced no storyboard grid at all for this video.', [
                'video_id' => $video->id,
            ]);

            return false;
        }

        try {
            $this->uploadStoryboards($tmpDir, $paths);
        } catch (Throwable $e) {
            Log::error('Storyboard backfill failed to upload the generated storyboards to R2; leaving the video untouched so a later run retries it.', [
                'video_id' => $video->id,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        $video->update(['storyboards' => $paths]);

        return true;
    }

    /**
     * Stream the source object to disk rather than reading it into memory:
     * some of these originals are several gigabytes.
     */
    private function downloadSource(Filesystem $mediaDisk, string $key, string $localPath): void
    {
        $source = $mediaDisk->readStream($key);

        if (! is_resource($source)) {
            throw new \RuntimeException("Unable to read the media bucket object: {$key}");
        }

        $target = @fopen($localPath, 'w');

        if ($target === false) {
            fclose($source);

            throw new \RuntimeException("Unable to open the local file for writing: {$localPath}");
        }

        try {
            if (stream_copy_to_stream($source, $target) === false) {
                throw new \RuntimeException("Failed to copy the media bucket object to disk: {$key}");
            }
        } finally {
            fclose($source);
            fclose($target);
        }
    }

    /**
     * Upload only the storyboard files that were actually produced, each to
     * the key already recorded for it inside the video's own disk prefix.
     *
     * @param  array<string, array{path: string, meta_path: string}>  $paths
     */
    private function uploadStoryboards(string $tmpDir, array $paths): void
    {
        $disk = Setting::current()->r2Disk();

        foreach ($paths as $storyboard) {
            foreach ([$storyboard['path'], $storyboard['meta_path']] as $remotePath) {
                $localPath = $tmpDir.'/'.basename($remotePath);
                $stream = @fopen($localPath, 'r');

                if ($stream === false) {
                    throw new \RuntimeException("Unable to open the storyboard file for reading: {$localPath}");
                }

                try {
                    if (! $disk->put($remotePath, $stream, 'public')) {
                        throw new \RuntimeException("Failed to upload the storyboard file to R2: {$remotePath}");
                    }
                } finally {
                    if (is_resource($stream)) {
                        fclose($stream);
                    }
                }
            }
        }
    }

    private function probeDuration(string $filePath): ?float
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            $filePath,
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return null;
        }

        $rawOutput = trim($process->getOutput());

        if (! is_numeric($rawOutput) || (float) $rawOutput <= 0) {
            return null;
        }

        return (float) $rawOutput;
    }

    /**
     * @param  list<Video>  $noMatch
     * @param  list<Video>  $ambiguous
     * @param  list<Video>  $failed
     */
    private function summarise(int $total, int $succeeded, array $noMatch, array $ambiguous, array $failed): void
    {
        $this->info(
            "Targeted {$total} videos: {$succeeded} succeeded, "
            .count($noMatch).' skipped (no matching source file), '
            .count($ambiguous).' skipped (ambiguous match), '
            .count($failed).' failed.'
        );

        $this->listVideos('Skipped, no matching source file:', $noMatch);
        $this->listVideos('Skipped, several matching source files:', $ambiguous);
        $this->listVideos('Failed while generating or uploading (see the log for details):', $failed);
    }

    /**
     * @param  list<Video>  $videos
     */
    private function listVideos(string $heading, array $videos): void
    {
        if ($videos === []) {
            return;
        }

        $this->line($heading);

        foreach ($videos as $video) {
            $this->line("  {$video->id} {$video->original_filename}");
        }
    }
}
