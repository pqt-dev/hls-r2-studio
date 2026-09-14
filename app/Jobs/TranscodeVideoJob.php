<?php

namespace App\Jobs;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;
use Throwable;

class TranscodeVideoJob implements ShouldQueue
{
    use Queueable;

    public $tries = 1;

    private const MIN_THUMBNAIL_SATURATION = 5.0;

    private const MIN_THUMBNAIL_DETAIL = 3.0;

    private const DETAIL_SCORE_WEIGHT = 5.0;

    private const INITIAL_SAMPLE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

    private const EXTRA_SAMPLE_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 0.05, 0.95];

    private const SMART_CROP_WINDOW_COUNT = 7;

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
        $video = Video::findOrFail($this->videoId);

        $tmpDir = Storage::disk('local')->path("hls_tmp/{$this->videoId}");

        try {
            $video->status = 'processing';
            $video->stage = 'queued';
            $video->progress = 0;
            $video->save();

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

            $video->stage = 'uploading_r2';
            $video->progress = 92;
            $video->save();

            $year = $video->created_at->format('Y');
            $month = $video->created_at->format('m');
            $day = $video->created_at->format('d');
            $slug = Str::slug(pathinfo($video->original_filename, PATHINFO_FILENAME)) ?: 'video';
            $prefix = "{$year}/{$month}/{$day}/{$slug}-{$video->id}/";
            $this->uploadDirectory($tmpDir, $prefix, $video);

            $video->disk_prefix = $prefix;
            $video->playlist_path = $prefix.'playlist.m3u8';
            $video->thumbnail_path = $prefix.'thumbnail.jpg';
            $video->status = 'ready';
            $video->stage = 'ready';
            $video->progress = 100;
            $video->error_message = null;
            $video->save();

            $this->cleanup($tmpDir);
        } catch (Throwable $e) {
            $video->status = 'failed';
            $video->stage = 'failed';
            $video->error_message = $e->getMessage();
            $video->save();

            $this->cleanup($tmpDir);

            Log::error('TranscodeVideoJob failed for video '.$this->videoId.': '.$e->getMessage());

            throw $e;
        }
    }

    private function probeDuration(string $filePath): float
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            $filePath,
        ]);

        $process->setTimeout(3600);
        $process->run();

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffprobe failed: '.$process->getErrorOutput());
        }

        return (float) trim($process->getOutput());
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

        $process->setTimeout(3600);
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

    private function runTranscode(string $inputPath, string $tmpDir, float $duration, Video $video): void
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

        $process->setTimeout(3600);
        $process->start();

        while ($process->isRunning()) {
            usleep(1000000);

            if (File::exists($progressFilePath)) {
                $content = file_get_contents($progressFilePath);

                if (preg_match_all('/out_time_ms=(\d+)/', $content, $matches) && ! empty($matches[1])) {
                    $outTimeMs = (int) end($matches[1]);

                    if ($duration > 0) {
                        $percent = min(88, (int) round((($outTimeMs / 1000000) / $duration) * 100 * 0.86 + 2));

                        if ($percent !== $video->progress) {
                            $video->progress = $percent;
                            $video->save();
                        }
                    }
                }
            }
        }

        $process->wait();

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg transcode failed: '.$process->getErrorOutput());
        }
    }

    private function generateThumbnail(string $inputPath, string $tmpDir, float $duration, ?int $sourceWidth, ?int $sourceHeight): void
    {
        $finalPath = "{$tmpDir}/thumbnail.jpg";

        if ($duration < 3) {
            $this->extractThumbnailCandidate($inputPath, $duration / 2, $finalPath);

            return;
        }

        $maxTimestamp = max(0, $duration - 0.5);

        $rank = fn (array $c) => ($c['saturationScore'] ?? 0)
            + self::DETAIL_SCORE_WEIGHT * ($c['detailScore'] ?? 0);

        $isRemoved = fn (array $c) => $c['saturationScore'] === null
            || $c['saturationScore'] < self::MIN_THUMBNAIL_SATURATION
            || ($c['detailScore'] !== null && $c['detailScore'] < self::MIN_THUMBNAIL_DETAIL);

        $candidates = [];
        $candidateCounter = 0;

        $extractCandidate = function (float $fraction) use ($inputPath, $tmpDir, $duration, $maxTimestamp, &$candidateCounter, &$candidates): void {
            $timestamp = min(max($duration * $fraction, 0), $maxTimestamp);
            $candidatePath = "{$tmpDir}/thumb_candidate_{$candidateCounter}.jpg";
            $candidateCounter++;
            $this->extractThumbnailCandidate($inputPath, $timestamp, $candidatePath);
            $candidates[] = [
                'timestamp' => $timestamp,
                'path' => $candidatePath,
                'saturationScore' => $this->measureSaturation($candidatePath),
                'detailScore' => $this->measureDetail($candidatePath),
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

        if ($isLandscape) {
            $best = $kept[0];
            $this->composeSingleFrameThumbnail($best['path'], $finalPath);
        } else {
            $selected = array_slice($kept, 0, 3);

            usort($selected, fn (array $a, array $b) => $a['timestamp'] <=> $b['timestamp']);

            $this->composeGridThumbnail(array_column($selected, 'path'), $finalPath);
        }

        foreach ($candidates as $candidate) {
            if (File::exists($candidate['path'])) {
                File::delete($candidate['path']);
            }
        }
    }

    private function composeSingleFrameThumbnail(string $framePath, string $outputPath): void
    {
        $this->smartCropToCanvas($framePath, $outputPath, 1080, 1080);
    }

    private function composeGridThumbnail(array $orderedFramePaths, string $outputPath): void
    {
        $workDir = dirname($outputPath);
        $uid = uniqid('grid_', true);
        $columnPaths = [];

        foreach ($orderedFramePaths as $index => $framePath) {
            $columnPath = "{$workDir}/{$uid}_col_{$index}.jpg";
            $this->smartCropToCanvas($framePath, $columnPath, 360, 1080);
            $columnPaths[] = $columnPath;
        }

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

        $process->setTimeout(3600);
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

        $scaleProcess = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $framePath,
            '-vf', "scale={$canvasWidth}:{$canvasHeight}:force_original_aspect_ratio=increase",
            '-frames:v', '1',
            $scaledPath,
        ]);
        $scaleProcess->setTimeout(3600);
        $scaleProcess->run();

        if (! $scaleProcess->isSuccessful()) {
            throw new \RuntimeException('ffmpeg smart-crop scale failed: '.$scaleProcess->getErrorOutput());
        }

        $dimensions = getimagesize($scaledPath);

        if ($dimensions === false) {
            File::delete($scaledPath);

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

        $trialPaths = [];
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
            $cropProcess->setTimeout(3600);
            $cropProcess->run();

            if (! $cropProcess->isSuccessful()) {
                continue;
            }

            $score = $this->measureDetail($trialPath);

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
        $finalCropProcess->setTimeout(3600);
        $finalCropProcess->run();

        File::delete($scaledPath);

        foreach ($trialPaths as $trialPath) {
            if (File::exists($trialPath)) {
                File::delete($trialPath);
            }
        }

        if (! $finalCropProcess->isSuccessful()) {
            throw new \RuntimeException('ffmpeg smart-crop final crop failed: '.$finalCropProcess->getErrorOutput());
        }
    }

    private function extractThumbnailCandidate(string $inputPath, float $timestamp, string $outputPath): void
    {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-ss', (string) $timestamp,
            '-i', $inputPath,
            '-vf', 'thumbnail=100',
            '-frames:v', '1',
            $outputPath,
        ]);

        $process->setTimeout(3600);
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

    private function uploadDirectory(string $tmpDir, string $prefix, Video $video): void
    {
        $files = File::files($tmpDir);
        $totalFiles = count($files);
        $uploadedCount = 0;

        foreach ($files as $file) {
            $stream = fopen($file->getPathname(), 'r');

            $uploaded = Setting::current()->r2Disk()->put(
                $prefix.$file->getFilename(),
                $stream,
                ['visibility' => 'public']
            );

            if (is_resource($stream)) {
                fclose($stream);
            }

            if (! $uploaded) {
                throw new \RuntimeException("Failed to upload {$file->getFilename()} to R2 disk.");
            }

            $uploadedCount++;

            if ($totalFiles > 0) {
                $video->progress = 92 + (int) round(($uploadedCount / $totalFiles) * 7);
                $video->save();
            }
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
