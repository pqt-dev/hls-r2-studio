<?php

namespace App\Jobs;

use App\Exceptions\StorageConfigurationException;
use App\Models\Setting;
use App\Models\Video;
use Aws\CommandPool;
use Aws\S3\S3Client;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Filesystem\AwsS3V3Adapter;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use League\MimeTypeDetection\FinfoMimeTypeDetector;
use Symfony\Component\Process\Process;
use Throwable;

class TranscodeVideoJob implements ShouldQueue
{
    use Queueable;

    public $tries = 1;

    /**
     * Overall hard cap (172800s / 48h) on how long this job may run. This is
     * a last-resort safety net matching (and staying slightly below) the
     * queue worker's --timeout flag wherever it is configured (queue:work
     * command), so Laravel enforces this before the OS-level worker timeout
     * would kill the process; the primary control over ffmpeg's running
     * time is calculateProcessTimeout(), which scales with the video's
     * duration.
     */
    public $timeout = 172800;

    private const MIN_THUMBNAIL_SATURATION = 5.0;

    private const MIN_THUMBNAIL_DETAIL = 3.0;

    private const DETAIL_SCORE_WEIGHT = 5.0;

    private const INITIAL_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];

    private const EXTRA_SAMPLE_FRACTIONS = [0.1, 0.9];

    private const SMART_CROP_WINDOW_COUNT = 3;

    /**
     * Storyboard grid dimensions (columns, rows) keyed by the exclusive
     * upper bound (in seconds) of the video duration bracket they apply to.
     * The last entry (PHP_INT_MAX) is the fallback for any longer duration.
     * See generateStoryboard().
     */
    private const STORYBOARD_GRID_BRACKETS = [
        60 => [3, 3],
        300 => [5, 5],
        1800 => [8, 8],
        PHP_INT_MAX => [10, 10],
    ];

    private const UPLOAD_CONCURRENCY = 5;

    private const UPLOAD_MAX_ATTEMPTS = 3;

    /**
     * Seconds to wait before each retry attempt, in order: the delay before
     * attempt 2, then before attempt 3, and so on.
     */
    private const UPLOAD_RETRY_DELAYS = [1, 2];

    /**
     * Process timeout (in seconds) used when the video duration could not be
     * determined at all. Matches the job's overall time cap (172800s / 48h).
     */
    private const UNKNOWN_DURATION_TIMEOUT_SECONDS = 172800;

    /**
     * Create a new job instance.
     */
    public function __construct(
        public int $videoId,
        public string $localUploadPath,
    ) {
    }

    /**
     * Execute the job.
     */
    public function handle(): void
    {
        // Atomically claim this video for processing: only proceed if it is
        // not already marked 'processing'. This prevents two workers from
        // running the same transcode concurrently if the same job ever gets
        // dispatched or picked up twice (e.g. due to queue retry_after).
        $claimed = Video::where('id', $this->videoId)
            ->where('status', '!=', 'processing')
            ->update(['status' => 'processing', 'stage' => 'queued', 'progress' => 0]);

        if ($claimed === 0) {
            Log::warning("TranscodeVideoJob skipped: video {$this->videoId} is already being processed or in a terminal state.");

            return;
        }

        $video = Video::findOrFail($this->videoId);

        $tmpDir = Storage::disk('local')->path("hls_tmp/{$this->videoId}");

        try {
            $duration = $this->probeDuration($this->localUploadPath);
            $video->duration = $duration;
            $video->stage = 'transcoding';
            $video->progress = 2;
            $video->save();

            File::ensureDirectoryExists($tmpDir);

            $this->runTranscode($this->localUploadPath, $tmpDir, $duration, $video);

            $video->fill($this->probeOutputInfo($tmpDir));
            $video->progress = 90;
            $video->save();

            $this->generateThumbnail($this->localUploadPath, $tmpDir, $duration, $video->output_width, $video->output_height);

            try {
                $this->generateStoryboard($this->localUploadPath, $tmpDir, $duration);
            } catch (Throwable $e) {
                Log::warning('Failed to generate storyboard; proceeding without a storyboard.', [
                    'video_id' => $this->videoId,
                    'error' => $e->getMessage(),
                ]);
            }

            $video->stage = 'uploading_r2';
            $video->progress = 92;
            $video->save();

            $year = $video->created_at->format('Y');
            $month = $video->created_at->format('m');
            $day = $video->created_at->format('d');
            $slug = Str::slug(pathinfo($video->original_filename, PATHINFO_FILENAME)) ?: 'video';
            $prefix = "{$year}/{$month}/{$day}/{$slug}-{$video->id}/";

            // Persist the prefix BEFORE the upload starts. If the upload dies
            // part way through, the objects already written to R2 would
            // otherwise be unreachable forever, since nothing would record
            // where they live.
            $video->disk_prefix = $prefix;
            $video->save();

            $this->uploadDirectory($tmpDir, $prefix, $video);

            $video->playlist_path = $prefix.'playlist.m3u8';
            $video->thumbnail_path = File::exists("{$tmpDir}/thumbnail.jpg") ? $prefix.'thumbnail.jpg' : null;
            $video->storyboard_path = File::exists("{$tmpDir}/storyboard.jpg") ? $prefix.'storyboard.jpg' : null;
            $video->storyboard_meta_path = File::exists("{$tmpDir}/storyboard.json") ? $prefix.'storyboard.json' : null;
            $video->status = 'ready';
            $video->stage = 'ready';
            $video->progress = 100;
            $video->error_message = null;
            $video->save();

            $this->cleanup($tmpDir);
        } catch (Throwable $e) {
            $video->status = 'failed';
            $video->stage = 'failed';
            $video->error_message = $e instanceof StorageConfigurationException
                ? 'Unable to process this video due to a server storage configuration issue. Please contact the administrator.'
                : 'Unable to process this video. The file may be corrupted, in an unsupported format, or the server ran out of resources while processing it. Please check the file and try again.';
            $video->save();

            $this->cleanupRemoteFiles($video);

            $this->cleanup($tmpDir);

            Log::error('TranscodeVideoJob failed for video '.$this->videoId.': '.$e->getMessage());

            throw $e;
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
            throw new \RuntimeException('ffprobe failed: '.$process->getErrorOutput());
        }

        $rawOutput = trim($process->getOutput());

        if (! is_numeric($rawOutput) || (float) $rawOutput <= 0) {
            Log::warning('ffprobe returned an unusable duration; proceeding without a known duration.', [
                'video_id' => $this->videoId,
                'raw_output' => $rawOutput,
            ]);

            return null;
        }

        return (float) $rawOutput;
    }

    private function probeFps(string $filePath): float
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            $filePath,
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffprobe failed: '.$process->getErrorOutput());
        }

        $rate = trim($process->getOutput());

        if (str_contains($rate, '/')) {
            [$num, $den] = array_map('floatval', explode('/', $rate, 2));

            return $den > 0 ? $num / $den : 0.0;
        }

        return (float) $rate;
    }

    private function probeOutputInfo(string $tmpDir): array
    {
        $firstSegment = collect(File::files($tmpDir))
            ->first(fn ($f) => str_ends_with($f->getFilename(), '.ts'));

        if (! $firstSegment) {
            return [];
        }

        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate,bit_rate,codec_name',
            '-of', 'json',
            $firstSegment->getPathname(),
        ]);
        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return [];
        }

        $data = json_decode($process->getOutput(), true);
        $stream = $data['streams'][0] ?? [];

        $fps = null;
        if (! empty($stream['r_frame_rate']) && str_contains($stream['r_frame_rate'], '/')) {
            [$num, $den] = explode('/', $stream['r_frame_rate']);
            $fps = (float) $den > 0 ? round((float) $num / (float) $den, 2) : null;
        }

        $bitrateKbps = null;
        if (! empty($stream['bit_rate'])) {
            $bitrateKbps = (int) round(((int) $stream['bit_rate']) / 1000);
        } else {
            $segmentSeconds = Setting::current()->transcode_segment_seconds;

            if ($segmentSeconds > 0) {
                $bitrateKbps = (int) round((File::size($firstSegment->getPathname()) * 8 / 1000) / $segmentSeconds);
            }
        }

        return [
            'output_width' => $stream['width'] ?? null,
            'output_height' => $stream['height'] ?? null,
            'output_fps' => $fps,
            'output_bitrate_kbps' => $bitrateKbps,
            'output_codec' => $stream['codec_name'] ?? null,
        ];
    }

    private function runTranscode(string $inputPath, string $tmpDir, ?float $duration, Video $video): void
    {
        $settings = Setting::current();

        $resolutionWidthMap = [
            '480' => 854,
            '720' => 1280,
            '1080' => 1920,
        ];
        $maxWidth = $resolutionWidthMap[$settings->transcode_resolution] ?? 1280;

        $outputFps = $settings->transcode_fps !== null
            ? (float) $settings->transcode_fps
            : $this->probeFps($inputPath);

        $gopSize = max(1, (int) round($outputFps * $settings->transcode_segment_seconds));

        $progressFilePath = "{$tmpDir}/ffmpeg_progress.txt";

        $args = [
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $inputPath,
            '-vf', "scale='min({$maxWidth},iw)':-2",
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-g', (string) $gopSize,
            '-keyint_min', (string) $gopSize,
            '-sc_threshold', '0',
        ];

        if ($settings->transcode_fps !== null) {
            $args[] = '-r';
            $args[] = (string) $settings->transcode_fps;
        }

        $args = array_merge($args, [
            '-c:a', 'aac',
            '-b:a', '128k',
            '-hls_time', (string) $settings->transcode_segment_seconds,
            '-hls_playlist_type', 'vod',
            '-hls_segment_filename', "{$tmpDir}/segment_%03d.ts",
            '-progress', $progressFilePath,
            "{$tmpDir}/playlist.m3u8",
        ]);

        $process = new Process($args);

        $process->setTimeout(self::calculateProcessTimeout($duration));
        $process->start();

        $progressHandle = null;
        $leftover = '';

        try {
            while ($process->isRunning()) {
                usleep(1000000);

                if ($progressHandle === null && File::exists($progressFilePath)) {
                    $progressHandle = fopen($progressFilePath, 'r');
                }

                if ($progressHandle !== null) {
                    $outTimeMs = $this->readProgressIncrement($progressHandle, $leftover);

                    if ($outTimeMs !== null && $duration !== null && $duration > 0) {
                        $percent = min(88, (int) round((($outTimeMs / 1000000) / $duration) * 100 * 0.86 + 2));

                        if ($percent !== $video->progress) {
                            try {
                                $video->progress = $percent;
                                $video->save();
                            } catch (Throwable $e) {
                                Log::warning('Failed to persist transcode progress.', [
                                    'video_id' => $this->videoId,
                                    'error' => $e->getMessage(),
                                ]);
                            }
                        }
                    }
                }
            }

            if ($progressHandle !== null) {
                fclose($progressHandle);
            }

            $process->wait();
        } finally {
            if (File::exists($progressFilePath)) {
                File::delete($progressFilePath);
            }
        }

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg transcode failed: '.$process->getErrorOutput());
        }
    }

    /**
     * Calculate the ffmpeg process timeout (in seconds) proportional to the
     * video duration, so long videos are not killed prematurely while short
     * videos are not left waiting indefinitely on a hang.
     */
    private static function calculateProcessTimeout(?float $duration): int
    {
        if ($duration === null) {
            return self::UNKNOWN_DURATION_TIMEOUT_SECONDS;
        }

        return max(600, (int) ceil($duration * config('videos.transcode_timeout_multiplier')));
    }

    /**
     * Read only the newly appended bytes from the progress file handle
     * (whose position persists between calls) and return the latest
     * out_time_ms value found in the completed lines, or null if none.
     * Any trailing incomplete line is kept in $leftover and prepended on
     * the next call so a value split across two reads is not lost.
     */
    private function readProgressIncrement($handle, string &$leftover): ?int
    {
        $chunk = stream_get_contents($handle);

        if ($chunk === false || $chunk === '') {
            return null;
        }

        $buffer = $leftover.$chunk;
        $lastNewlinePos = strrpos($buffer, "\n");

        if ($lastNewlinePos === false) {
            $leftover = $buffer;

            return null;
        }

        $complete = substr($buffer, 0, $lastNewlinePos + 1);
        $leftover = substr($buffer, $lastNewlinePos + 1);

        if (preg_match_all('/out_time_ms=(\d+)/', $complete, $matches) && ! empty($matches[1])) {
            return (int) end($matches[1]);
        }

        return null;
    }

    private function generateThumbnail(string $inputPath, string $tmpDir, ?float $duration, ?int $sourceWidth, ?int $sourceHeight): void
    {
        $finalPath = "{$tmpDir}/thumbnail.jpg";
        $effectiveDuration = $duration ?? 0.0;

        if ($effectiveDuration < 3) {
            try {
                $this->extractThumbnailCandidate($inputPath, $effectiveDuration / 2, $finalPath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to extract thumbnail for short video; proceeding without a thumbnail.', [
                    'video_id' => $this->videoId,
                    'error' => $e->getMessage(),
                ]);
            }

            return;
        }

        $maxTimestamp = max(0, $effectiveDuration - 0.5);

        $rank = fn (array $c) => ($c['saturationScore'] ?? 0)
            + self::DETAIL_SCORE_WEIGHT * ($c['detailScore'] ?? 0);

        $isRemoved = fn (array $c) => $c['saturationScore'] === null
            || $c['saturationScore'] < self::MIN_THUMBNAIL_SATURATION
            || ($c['detailScore'] !== null && $c['detailScore'] < self::MIN_THUMBNAIL_DETAIL);

        $candidates = [];
        $candidateCounter = 0;

        $extractCandidate = function (float $fraction) use ($inputPath, $tmpDir, $effectiveDuration, $maxTimestamp, &$candidateCounter, &$candidates): void {
            $timestamp = min(max($effectiveDuration * $fraction, 0), $maxTimestamp);
            $candidatePath = "{$tmpDir}/thumb_candidate_{$candidateCounter}.jpg";
            $candidateCounter++;

            try {
                $this->extractThumbnailCandidate($inputPath, $timestamp, $candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to extract thumbnail candidate frame, skipping', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                if (File::exists($candidatePath)) {
                    File::delete($candidatePath);
                }

                return;
            }

            try {
                $saturationScore = $this->measureSaturation($candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to measure thumbnail candidate saturation, treating as unscored', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                $saturationScore = null;
            }

            try {
                $detailScore = $this->measureDetail($candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to measure thumbnail candidate detail, treating as unscored', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                $detailScore = null;
            }

            $candidates[] = [
                'timestamp' => $timestamp,
                'path' => $candidatePath,
                'saturationScore' => $saturationScore,
                'detailScore' => $detailScore,
            ];
        };

        foreach (self::INITIAL_SAMPLE_FRACTIONS as $fraction) {
            $extractCandidate($fraction);
        }

        $countKept = fn () => count(array_filter($candidates, fn (array $c) => ! $isRemoved($c)));

        foreach (self::EXTRA_SAMPLE_FRACTIONS as $fraction) {
            if ($countKept() >= 3) {
                break;
            }

            $extractCandidate($fraction);
        }

        if (count($candidates) === 0) {
            Log::warning('Unable to extract any thumbnail candidate frames from the video; proceeding without a thumbnail.', [
                'video_id' => $this->videoId,
            ]);

            return;
        }

        $kept = array_values(array_filter(
            $candidates,
            fn (array $c) => ! $isRemoved($c)
        ));
        $removed = array_values(array_filter(
            $candidates,
            fn (array $c) => $isRemoved($c)
        ));

        $isLandscape = $sourceWidth !== null && $sourceHeight !== null && $sourceWidth > $sourceHeight;

        $minNeeded = $isLandscape ? 1 : 3;

        if (count($kept) < $minNeeded) {
            usort($removed, fn (array $a, array $b) => $rank($b) <=> $rank($a));
            $kept = array_merge($kept, array_slice($removed, 0, $minNeeded - count($kept)));
        }

        usort($kept, fn (array $a, array $b) => $rank($b) <=> $rank($a));

        if (! $isLandscape && count($kept) < 3) {
            Log::warning('Not enough valid thumbnail candidates for grid, falling back to single-frame thumbnail', [
                'video_id' => $this->videoId,
                'kept_count' => count($kept),
            ]);

            $isLandscape = true;
        }

        $thumbnailCreated = false;

        if (! $isLandscape) {
            $thumbnailCreated = $this->tryComposeGridThumbnail($kept, $finalPath);
        }

        if (! $thumbnailCreated) {
            $thumbnailCreated = $this->tryComposeSingleFrameThumbnail($kept, $finalPath);
        }

        if (! $thumbnailCreated) {
            Log::warning('Unable to generate a thumbnail for this video after trying all available candidates; proceeding without a thumbnail.', [
                'video_id' => $this->videoId,
            ]);
        }

        foreach ($candidates as $candidate) {
            if (File::exists($candidate['path'])) {
                File::delete($candidate['path']);
            }
        }
    }

    /**
     * Generate a single storyboard image (a grid of tiles sampled evenly
     * across the video's duration, used for scrub-bar hover previews) plus a
     * JSON file describing each tile's time range and position in the grid.
     * The grid dimensions scale with the video's duration.
     */
    private function generateStoryboard(string $inputPath, string $tmpDir, ?float $duration): void
    {
        if ($duration === null || $duration <= 0) {
            Log::warning('Skipping storyboard generation: video duration is unknown.', [
                'video_id' => $this->videoId,
            ]);

            return;
        }

        [$cols, $rows] = $this->storyboardGridForDuration($duration);
        $totalTiles = $cols * $rows;
        $tileSize = config('videos.storyboard_tile_size');

        $finalPath = "{$tmpDir}/storyboard.jpg";

        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $inputPath,
            '-vf', "fps={$totalTiles}/{$duration},crop='min(iw\,ih)':'min(iw\,ih)',scale={$tileSize}:{$tileSize},tile={$cols}x{$rows}",
            '-frames:v', '1',
            $finalPath,
        ]);

        $process->setTimeout(60);
        $process->run();

        // The tile filter requires exactly cols*rows input frames. If fewer
        // are available it silently produces no output file instead of
        // failing the process, so file existence must be checked in
        // addition to the exit code.
        if (! $process->isSuccessful() || ! File::exists($finalPath)) {
            throw new \RuntimeException('ffmpeg storyboard generation failed: '.$process->getErrorOutput());
        }

        $tileDuration = $duration / $totalTiles;
        $tiles = [];

        for ($i = 0; $i < $totalTiles; $i++) {
            $col = $i % $cols;
            $row = intdiv($i, $cols);

            $tiles[] = [
                'start' => round($i * $tileDuration, 2),
                'end' => round(($i + 1) * $tileDuration, 2),
                'x' => $col * $tileSize,
                'y' => $row * $tileSize,
            ];
        }

        File::put("{$tmpDir}/storyboard.json", json_encode($tiles));
    }

    /**
     * The storyboard grid dimensions [cols, rows] for a given video duration,
     * based on the brackets defined in STORYBOARD_GRID_BRACKETS.
     */
    private function storyboardGridForDuration(float $duration): array
    {
        foreach (self::STORYBOARD_GRID_BRACKETS as $upperBound => $grid) {
            if ($duration < $upperBound) {
                return $grid;
            }
        }

        return end(self::STORYBOARD_GRID_BRACKETS);
    }

    private function composeSingleFrameThumbnail(string $framePath, string $outputPath): void
    {
        $this->smartCropToCanvas($framePath, $outputPath, 1080, 1080);
    }

    /**
     * Try to crop up to 3 candidates (in rank order) into grid columns and
     * hstack them into a grid thumbnail. Returns false without throwing if
     * fewer than 3 candidates can be cropped successfully, or if the final
     * hstack composition fails, so the caller can fall back to a
     * single-frame thumbnail instead.
     */
    private function tryComposeGridThumbnail(array $kept, string $finalPath): bool
    {
        $workDir = dirname($finalPath);
        $uid = uniqid('grid_', true);
        $columnResults = [];

        foreach ($kept as $candidate) {
            if (count($columnResults) >= 3) {
                break;
            }

            $columnPath = "{$workDir}/{$uid}_col_".count($columnResults).'.jpg';

            try {
                $this->smartCropToCanvas($candidate['path'], $columnPath, 360, 1080);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to crop thumbnail candidate for grid, trying next candidate', [
                    'video_id' => $this->videoId,
                    'timestamp' => $candidate['timestamp'],
                    'error' => $e->getMessage(),
                ]);

                if (File::exists($columnPath)) {
                    File::delete($columnPath);
                }

                continue;
            }

            $columnResults[] = [
                'timestamp' => $candidate['timestamp'],
                'path' => $columnPath,
            ];
        }

        if (count($columnResults) < 3) {
            foreach ($columnResults as $result) {
                if (File::exists($result['path'])) {
                    File::delete($result['path']);
                }
            }

            return false;
        }

        usort($columnResults, fn (array $a, array $b) => $a['timestamp'] <=> $b['timestamp']);

        try {
            $this->composeGridThumbnail(array_column($columnResults, 'path'), $finalPath);
        } catch (\RuntimeException $e) {
            Log::warning('Failed to compose grid thumbnail from cropped candidates, falling back to single-frame thumbnail', [
                'video_id' => $this->videoId,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        return true;
    }

    /**
     * Try each candidate (in rank order) as a single-frame thumbnail until
     * one succeeds. Returns false without throwing if every candidate
     * fails, so the caller can proceed without a thumbnail.
     */
    private function tryComposeSingleFrameThumbnail(array $kept, string $finalPath): bool
    {
        foreach ($kept as $candidate) {
            try {
                $this->composeSingleFrameThumbnail($candidate['path'], $finalPath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to compose single-frame thumbnail from candidate, trying next candidate', [
                    'video_id' => $this->videoId,
                    'timestamp' => $candidate['timestamp'],
                    'error' => $e->getMessage(),
                ]);

                continue;
            }

            return true;
        }

        return false;
    }

    private function composeGridThumbnail(array $columnPaths, string $outputPath): void
    {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $columnPaths[0],
            '-i', $columnPaths[1],
            '-i', $columnPaths[2],
            '-filter_complex', '[0:v][1:v][2:v]hstack=inputs=3[v]',
            '-map', '[v]',
            '-frames:v', '1',
            $outputPath,
        ]);

        $process->setTimeout(60);
        $process->run();

        foreach ($columnPaths as $columnPath) {
            if (File::exists($columnPath)) {
                File::delete($columnPath);
            }
        }

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg grid thumbnail failed: '.$process->getErrorOutput());
        }
    }

    private function smartCropToCanvas(string $framePath, string $outputPath, int $canvasWidth, int $canvasHeight): void
    {
        $workDir = dirname($outputPath);
        $uid = uniqid('smartcrop_', true);
        $scaledPath = "{$workDir}/{$uid}_scaled.jpg";
        $trialPaths = [];

        $scaleProcess = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $framePath,
            '-vf', "scale={$canvasWidth}:{$canvasHeight}:force_original_aspect_ratio=increase",
            '-frames:v', '1',
            $scaledPath,
        ]);
        $scaleProcess->setTimeout(60);
        $scaleProcess->run();

        try {
            if (! $scaleProcess->isSuccessful()) {
                throw new \RuntimeException('ffmpeg smart-crop scale failed: '.$scaleProcess->getErrorOutput());
            }

            $dimensions = getimagesize($scaledPath);

            if ($dimensions === false) {
                throw new \RuntimeException("Unable to read scaled image dimensions: {$scaledPath}");
            }

            [$scaledWidth, $scaledHeight] = $dimensions;

            $excessX = $scaledWidth - $canvasWidth;
            $excessY = $scaledHeight - $canvasHeight;

            if ($excessX > 0) {
                $axis = 'x';
                $maxOffset = $excessX;
            } elseif ($excessY > 0) {
                $axis = 'y';
                $maxOffset = $excessY;
            } else {
                $axis = null;
                $maxOffset = 0;
            }

            if ($maxOffset > 0) {
                $windowCount = self::SMART_CROP_WINDOW_COUNT;
                $offsets = [];

                for ($i = 0; $i < $windowCount; $i++) {
                    $offsets[] = (int) round($maxOffset * $i / ($windowCount - 1));
                }

                $offsets = array_values(array_unique($offsets));
            } else {
                $offsets = [0];
            }

            $bestOffset = null;
            $bestScore = null;

            foreach ($offsets as $index => $offset) {
                $x = $axis === 'x' ? $offset : 0;
                $y = $axis === 'y' ? $offset : 0;
                $trialPath = "{$workDir}/{$uid}_trial_{$index}.jpg";
                $trialPaths[] = $trialPath;

                $cropProcess = new Process([
                    config('services.ffmpeg.binary'),
                    '-y',
                    '-i', $scaledPath,
                    '-vf', "crop={$canvasWidth}:{$canvasHeight}:{$x}:{$y}",
                    '-frames:v', '1',
                    $trialPath,
                ]);
                $cropProcess->setTimeout(60);
                $cropProcess->run();

                if (! $cropProcess->isSuccessful()) {
                    continue;
                }

                try {
                    $score = $this->measureDetail($trialPath);
                } catch (\RuntimeException $e) {
                    Log::warning('Failed to measure detail for smart-crop trial offset, trying next offset', [
                        'video_id' => $this->videoId,
                        'offset' => $offset,
                        'error' => $e->getMessage(),
                    ]);

                    continue;
                }

                if ($score !== null && ($bestScore === null || $score > $bestScore)) {
                    $bestScore = $score;
                    $bestOffset = $offset;
                }
            }

            if ($bestOffset === null) {
                $bestOffset = (int) round($maxOffset / 2);
            }

            $finalX = $axis === 'x' ? $bestOffset : 0;
            $finalY = $axis === 'y' ? $bestOffset : 0;

            $finalCropProcess = new Process([
                config('services.ffmpeg.binary'),
                '-y',
                '-i', $scaledPath,
                '-vf', "crop={$canvasWidth}:{$canvasHeight}:{$finalX}:{$finalY}",
                '-frames:v', '1',
                $outputPath,
            ]);
            $finalCropProcess->setTimeout(60);
            $finalCropProcess->run();

            if (! $finalCropProcess->isSuccessful()) {
                throw new \RuntimeException('ffmpeg smart-crop final crop failed: '.$finalCropProcess->getErrorOutput());
            }
        } finally {
            if (File::exists($scaledPath)) {
                File::delete($scaledPath);
            }

            foreach ($trialPaths as $trialPath) {
                if (File::exists($trialPath)) {
                    File::delete($trialPath);
                }
            }
        }
    }

    private function extractThumbnailCandidate(string $inputPath, float $timestamp, string $outputPath): void
    {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-ss', (string) $timestamp,
            '-i', $inputPath,
            '-vf', 'thumbnail=24',
            '-frames:v', '1',
            $outputPath,
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg thumbnail failed: '.$process->getErrorOutput());
        }
    }

    private function measureSaturation(string $imagePath): ?float
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-f', 'lavfi',
            '-i', "movie={$imagePath},signalstats",
            '-show_entries', 'frame_tags=lavfi.signalstats.SATAVG',
            '-of', 'default=noprint_wrappers=1:nokey=1',
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return null;
        }

        $output = trim($process->getOutput());

        if ($output === '' || ! is_numeric($output)) {
            return null;
        }

        return (float) $output;
    }

    private function measureDetail(string $imagePath): ?float
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-f', 'lavfi',
            '-i', "movie={$imagePath},edgedetect,signalstats",
            '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
            '-of', 'default=noprint_wrappers=1:nokey=1',
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            return null;
        }

        $output = trim($process->getOutput());

        if ($output === '' || ! is_numeric($output)) {
            return null;
        }

        return (float) $output;
    }

    /**
     * Upload every file in the transcode output directory to R2.
     *
     * Files are first sent concurrently through an AWS command pool, then any
     * file that failed is retried sequentially with a short backoff. Only when
     * a file has exhausted all of its attempts is the upload considered fatal.
     */
    private function uploadDirectory(string $tmpDir, string $prefix, Video $video): void
    {
        $files = array_values(array_filter(File::files($tmpDir), fn (\SplFileInfo $f) => self::isUploadableFile($f)));
        $totalFiles = count($files);

        if ($totalFiles === 0) {
            return;
        }

        $disk = Setting::current()->r2Disk();

        if (! $disk instanceof AwsS3V3Adapter) {
            throw new StorageConfigurationException('The configured R2 disk does not expose an S3 client, so files cannot be uploaded concurrently.');
        }

        $client = $disk->getClient();
        $bucket = $disk->getConfig()['bucket'] ?? null;

        if (! $bucket) {
            throw new StorageConfigurationException('The configured R2 disk has no bucket, so files cannot be uploaded.');
        }

        $detector = new FinfoMimeTypeDetector;
        $uploadedCount = 0;

        // Keyed by the index of the file in $files, so a failure can always be
        // traced back to the exact file that produced it.
        $failures = [];
        $commands = [];
        $handles = [];

        foreach ($files as $index => $file) {
            $stream = @fopen($file->getPathname(), 'r');

            if ($stream === false) {
                // Treat an unreadable local file as a failed upload so it goes
                // through the same retry path as a genuine network failure.
                $failures[$index] = 'Unable to open the local file for reading.';

                continue;
            }

            $handles[$index] = $stream;
            $commands[$index] = $client->getCommand('PutObject', $this->putObjectParams(
                $bucket,
                $prefix.$file->getFilename(),
                $stream,
                $detector
            ));
        }

        try {
            if ($commands !== []) {
                (new CommandPool($client, $commands, [
                    'concurrency' => self::UPLOAD_CONCURRENCY,
                    'preserve_iterator_keys' => true,
                    // The pool runs on curl_multi inside a single PHP process,
                    // so these callbacks never run in parallel and the counter
                    // and model writes below need no extra locking.
                    'fulfilled' => function ($result, $index) use (&$uploadedCount, $totalFiles, $video): void {
                        $uploadedCount++;
                        $percent = self::uploadProgressPercent($uploadedCount, $totalFiles);

                        if ($percent !== $video->progress) {
                            try {
                                $video->progress = $percent;
                                $video->save();
                            } catch (Throwable $e) {
                                Log::warning('Failed to persist upload progress.', [
                                    'video_id' => $this->videoId,
                                    'error' => $e->getMessage(),
                                ]);
                            }
                        }
                    },
                    'rejected' => function ($reason, $index) use (&$failures): void {
                        $failures[$index] = $reason instanceof Throwable
                            ? $reason->getMessage()
                            : (string) $reason;
                    },
                ]))->promise()->wait();
            }
        } finally {
            foreach ($handles as $handle) {
                if (is_resource($handle)) {
                    fclose($handle);
                }
            }
        }

        foreach ($failures as $index => $message) {
            Log::warning('Concurrent R2 upload failed, will retry sequentially.', [
                'video_id' => $this->videoId,
                'file' => $files[$index]->getFilename(),
                'error' => $message,
            ]);
        }

        foreach (array_keys($failures) as $index) {
            if ($this->retryUpload($client, $bucket, $prefix, $files[$index], $detector)) {
                unset($failures[$index]);
                $uploadedCount++;
                $percent = self::uploadProgressPercent($uploadedCount, $totalFiles);

                if ($percent !== $video->progress) {
                    try {
                        $video->progress = $percent;
                        $video->save();
                    } catch (Throwable $e) {
                        Log::warning('Failed to persist upload progress.', [
                            'video_id' => $this->videoId,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }
            }
        }

        if ($failures !== []) {
            $failedNames = array_map(
                fn (int $index): string => $files[$index]->getFilename(),
                array_keys($failures)
            );

            throw new \RuntimeException(
                'Failed to upload the following files to R2 after '.self::UPLOAD_MAX_ATTEMPTS.' application-level attempts (each attempt may include additional retries by the underlying AWS SDK): '
                .implode(', ', $failedNames)
            );
        }
    }

    /**
     * Retry a single file sequentially for the remaining attempts, waiting a
     * short backoff before each one. Returns true as soon as one succeeds.
     */
    private function retryUpload(
        S3Client $client,
        string $bucket,
        string $prefix,
        \SplFileInfo $file,
        FinfoMimeTypeDetector $detector
    ): bool {
        for ($attempt = 2; $attempt <= self::UPLOAD_MAX_ATTEMPTS; $attempt++) {
            sleep(self::uploadRetryDelay($attempt));

            $stream = @fopen($file->getPathname(), 'r');

            if ($stream === false) {
                Log::warning('R2 upload retry could not open the local file for reading.', [
                    'video_id' => $this->videoId,
                    'file' => $file->getFilename(),
                    'attempt' => $attempt,
                ]);

                continue;
            }

            try {
                $client->putObject($this->putObjectParams(
                    $bucket,
                    $prefix.$file->getFilename(),
                    $stream,
                    $detector
                ));

                return true;
            } catch (Throwable $e) {
                Log::warning('R2 upload retry failed.', [
                    'video_id' => $this->videoId,
                    'file' => $file->getFilename(),
                    'attempt' => $attempt,
                    'error' => $e->getMessage(),
                ]);
            } finally {
                if (is_resource($stream)) {
                    fclose($stream);
                }
            }
        }

        return false;
    }

    /**
     * Build the PutObject parameters, mirroring what the Flysystem S3 adapter
     * sends for a stream written with public visibility: a public-read ACL and
     * a content type resolved from the object key.
     *
     * @param  resource  $body
     */
    private function putObjectParams(string $bucket, string $key, $body, FinfoMimeTypeDetector $detector): array
    {
        $params = [
            'Bucket' => $bucket,
            'Key' => $key,
            'Body' => $body,
            'ACL' => 'public-read',
        ];

        $mimeType = $detector->detectMimeType($key, $body);

        if ($mimeType !== null) {
            $params['ContentType'] = $mimeType;
        }

        return $params;
    }

    /**
     * Whether a file in the transcode output directory is one that should be
     * uploaded to R2 (segments, playlist, thumbnail), excluding any stray
     * temporary or leftover files.
     */
    private static function isUploadableFile(\SplFileInfo $file): bool
    {
        return in_array(strtolower($file->getExtension()), ['ts', 'm3u8', 'jpg', 'json'], true);
    }

    /**
     * Overall job progress while uploading: the upload phase spans 92% to 99%,
     * proportional to the number of files actually uploaded so far.
     */
    private static function uploadProgressPercent(int $uploadedCount, int $totalFiles): int
    {
        if ($totalFiles <= 0) {
            return 92;
        }

        return 92 + (int) round(($uploadedCount / $totalFiles) * 7);
    }

    /**
     * Seconds to wait before the given (1-based) upload attempt. The first
     * attempt runs immediately; later attempts back off progressively.
     */
    private static function uploadRetryDelay(int $attempt): int
    {
        if ($attempt <= 1) {
            return 0;
        }

        $delays = self::UPLOAD_RETRY_DELAYS;

        return $delays[$attempt - 2] ?? (int) end($delays);
    }

    /**
     * Whether a failed job may have left objects behind on R2. Once the prefix
     * is recorded the upload has started, so the remote directory has to be
     * swept even if the failure happened later in the job.
     */
    private static function shouldCleanupRemoteFiles(?string $diskPrefix): bool
    {
        return $diskPrefix !== null && trim($diskPrefix) !== '';
    }

    /**
     * Best-effort removal of objects a failed job may have left on R2. Any
     * problem here is logged and swallowed: it must never mask the original
     * failure that brought us into the catch block.
     */
    private function cleanupRemoteFiles(Video $video): void
    {
        if (! self::shouldCleanupRemoteFiles($video->disk_prefix)) {
            return;
        }

        try {
            Setting::current()->r2Disk()->deleteDirectory($video->disk_prefix);
        } catch (Throwable $e) {
            Log::error('Failed to clean up partially uploaded R2 files for video '.$this->videoId.' (prefix: '.$video->disk_prefix.'): '.$e->getMessage());
        }
    }

    private function cleanup(string $tmpDir): void
    {
        if (File::isDirectory($tmpDir)) {
            File::deleteDirectory($tmpDir);
        }

        if (! config('videos.keep_original_upload') && File::exists($this->localUploadPath)) {
            File::delete($this->localUploadPath);
        }
    }
}
