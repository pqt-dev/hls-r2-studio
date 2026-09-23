<?php

namespace App\Console\Commands;

use App\Models\Setting;
use App\Models\Video;
use App\Services\ThumbnailGenerator;
use Illuminate\Console\Command;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\Process;
use Throwable;

class BackfillThumbnails extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'videos:backfill-thumbnails {--dry-run} {--limit=}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'One-off backfill: regenerate thumbnails for videos still on the pre-rewrite single-frame style (anything not exactly 1080x1080), sourcing the original mp4 from the media bucket by matching filename';

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

        $videos = Video::whereNotNull('thumbnail_path')
            ->where('status', 'ready')
            ->orderBy('id')
            ->get();

        $limit = $this->option('limit') !== null ? (int) $this->option('limit') : null;

        // Which videos actually need a backfill can only be known by looking at
        // the thumbnail that is on R2 right now, so --limit is applied to the
        // targets found rather than to the query above: --limit=1 means "the
        // first video that genuinely needs one", not "the first candidate row".
        [$targets, $scanned] = $this->findTargets($videos, $limit);

        $keysByBasename = $this->indexSourcesByBasename($mediaDisk);

        $dryRun = (bool) $this->option('dry-run');
        $succeeded = 0;
        $noMatch = [];
        $ambiguous = [];
        $failed = [];

        foreach ($targets as $target) {
            $video = $target['video'];
            $keys = $keysByBasename[$video->original_filename] ?? [];

            if ($keys === []) {
                $this->warn("Video {$video->id}: no source file named '{$video->original_filename}' in the media bucket, skipping.");
                Log::warning('Thumbnail backfill found no matching source file in the media bucket.', [
                    'video_id' => $video->id,
                    'original_filename' => $video->original_filename,
                ]);

                $noMatch[] = $video;

                continue;
            }

            if (count($keys) > 1) {
                $this->warn("Video {$video->id}: '{$video->original_filename}' matches several source files in the media bucket, skipping: ".implode(', ', $keys));
                Log::warning('Thumbnail backfill found several matching source files in the media bucket; skipping rather than guessing which one is correct.', [
                    'video_id' => $video->id,
                    'original_filename' => $video->original_filename,
                    'keys' => $keys,
                ]);

                $ambiguous[] = $video;

                continue;
            }

            $key = $keys[0];

            if ($dryRun) {
                $this->line("Video {$video->id}: {$video->original_filename} [{$target['dimensions']}] -> {$key}");

                continue;
            }

            $tmpDir = Storage::disk('local')->path("thumbnail_backfill_tmp/{$video->id}");

            try {
                if ($this->backfill($video, $mediaDisk, $key, $tmpDir)) {
                    $succeeded++;
                    $this->line("Video {$video->id}: thumbnail regenerated from {$key} (was {$target['dimensions']}).");
                } else {
                    $failed[] = $video;
                }
            } finally {
                File::deleteDirectory($tmpDir);
            }
        }

        $this->summarise($scanned, count($targets), $succeeded, $noMatch, $ambiguous, $failed);

        return self::SUCCESS;
    }

    /**
     * Work out which of the candidate videos still carry a pre-rewrite
     * thumbnail, by reading each one's current thumbnail off R2 and measuring
     * it. A thumbnail that is already exactly 1080x1080 is not a target at
     * all and is passed over silently; one that cannot be read or decoded is
     * treated as a target, since it needs regenerating either way.
     *
     * Returns the targets and how many videos had to be examined to find
     * them (fewer than the candidate count once --limit cuts the scan short).
     *
     * @param  iterable<Video>  $videos
     * @return array{0: list<array{video: Video, dimensions: string}>, 1: int}
     */
    private function findTargets(iterable $videos, ?int $limit): array
    {
        $disk = Setting::current()->r2Disk();
        $targets = [];
        $scanned = 0;

        foreach ($videos as $video) {
            if ($limit !== null && count($targets) >= $limit) {
                break;
            }

            $scanned++;

            try {
                $contents = $disk->get($video->thumbnail_path);
            } catch (Throwable) {
                $contents = null;
            }

            $dimensions = $contents !== null ? getimagesizefromstring($contents) : false;

            if ($dimensions === false) {
                $this->warn("Video {$video->id}: current thumbnail could not be read from R2, treating it as needing a backfill.");
                Log::warning('Thumbnail backfill could not read the current thumbnail from R2; treating the video as a target.', [
                    'video_id' => $video->id,
                    'thumbnail_path' => $video->thumbnail_path,
                ]);

                $targets[] = ['video' => $video, 'dimensions' => 'unreadable'];

                continue;
            }

            [$width, $height] = $dimensions;

            if ($width === 1080 && $height === 1080) {
                continue;
            }

            $targets[] = ['video' => $video, 'dimensions' => "{$width}x{$height}"];
        }

        return [$targets, $scanned];
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
     * Regenerate and upload the thumbnail for one video, returning false
     * (leaving the existing thumbnail untouched) if any step could not be
     * completed. The object key is the one already recorded on the row, so a
     * video left untouched here is safely retried by a later run and no
     * database write is ever needed.
     */
    private function backfill(Video $video, Filesystem $mediaDisk, string $key, string $tmpDir): bool
    {
        if (! $video->disk_prefix) {
            Log::warning('Thumbnail backfill skipped a video with no disk prefix; there is no R2 directory to upload into.', [
                'video_id' => $video->id,
            ]);

            return false;
        }

        File::ensureDirectoryExists($tmpDir);

        $localPath = "{$tmpDir}/source.mp4";

        try {
            $this->downloadSource($mediaDisk, $key, $localPath);
        } catch (Throwable $e) {
            Log::error('Thumbnail backfill failed to download the source video from the media bucket.', [
                'video_id' => $video->id,
                'key' => $key,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        $duration = $this->probeDuration($localPath);

        if ($duration === null || $duration <= 0) {
            Log::warning('Thumbnail backfill could not determine the duration of the source video; skipping.', [
                'video_id' => $video->id,
                'key' => $key,
            ]);

            return false;
        }

        [$sourceWidth, $sourceHeight] = $this->probeDimensions($localPath);

        if ($sourceWidth === null || $sourceHeight === null) {
            // Without the source dimensions there is no way to tell a portrait
            // video (3-column grid) from a landscape one (single smart crop),
            // and guessing would produce exactly the wrong style of thumbnail.
            Log::warning('Thumbnail backfill could not determine the dimensions of the source video; skipping rather than guessing its orientation.', [
                'video_id' => $video->id,
                'key' => $key,
            ]);

            return false;
        }

        try {
            (new ThumbnailGenerator)->generate($localPath, $tmpDir, $duration, $sourceWidth, $sourceHeight, $video->id);
        } catch (Throwable $e) {
            Log::warning('Thumbnail backfill failed to generate a thumbnail.', [
                'video_id' => $video->id,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        $thumbnailPath = "{$tmpDir}/thumbnail.jpg";

        // The generator swallows its own failures and simply leaves no file
        // behind, so its return alone does not prove a thumbnail was made.
        if (! File::exists($thumbnailPath)) {
            Log::warning('Thumbnail backfill produced no thumbnail at all for this video.', [
                'video_id' => $video->id,
            ]);

            return false;
        }

        try {
            $this->uploadThumbnail($thumbnailPath, $video->thumbnail_path);
        } catch (Throwable $e) {
            Log::error('Thumbnail backfill failed to upload the regenerated thumbnail to R2; leaving the video untouched so a later run retries it.', [
                'video_id' => $video->id,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

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
     * Overwrite the video's existing thumbnail object in place. The key never
     * changes, so nothing in the database has to be touched.
     */
    private function uploadThumbnail(string $localPath, string $remotePath): void
    {
        $disk = Setting::current()->r2Disk();

        $stream = @fopen($localPath, 'r');

        if ($stream === false) {
            throw new \RuntimeException("Unable to open the thumbnail file for reading: {$localPath}");
        }

        try {
            if (! $disk->put($remotePath, $stream, 'public')) {
                throw new \RuntimeException("Failed to upload the thumbnail file to R2: {$remotePath}");
            }
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
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
     * The width and height of the source video's first video stream, read
     * straight off the original file: this command never re-transcodes, it
     * only extracts frames, so there is no output stream to measure instead.
     *
     * @return array{0: ?int, 1: ?int}
     */
    private function probeDimensions(string $filePath): array
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'json',
            $filePath,
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return [null, null];
        }

        $data = json_decode($process->getOutput(), true);
        $stream = $data['streams'][0] ?? [];

        $width = isset($stream['width']) && is_numeric($stream['width']) ? (int) $stream['width'] : null;
        $height = isset($stream['height']) && is_numeric($stream['height']) ? (int) $stream['height'] : null;

        if ($width === null || $height === null || $width <= 0 || $height <= 0) {
            return [null, null];
        }

        return [$width, $height];
    }

    /**
     * @param  list<Video>  $noMatch
     * @param  list<Video>  $ambiguous
     * @param  list<Video>  $failed
     */
    private function summarise(int $scanned, int $targeted, int $succeeded, array $noMatch, array $ambiguous, array $failed): void
    {
        $this->info(
            "Scanned {$scanned} videos, {$targeted} of them still on a pre-rewrite thumbnail: {$succeeded} succeeded, "
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
