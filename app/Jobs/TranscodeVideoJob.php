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

            $this->generateThumbnail($this->localUploadPath, $tmpDir, $duration);

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

    private function generateThumbnail(string $inputPath, string $tmpDir, float $duration): void
    {
        $finalPath = "{$tmpDir}/thumbnail.jpg";

        if ($duration < 3) {
            $this->extractThumbnailCandidate($inputPath, $duration / 2, $finalPath);

            return;
        }

        $maxTimestamp = max(0, $duration - 0.5);
        $points = [$duration * 0.15, $duration * 0.5, $duration * 0.85];

        $candidates = [];

        foreach ($points as $i => $point) {
            $timestamp = min(max($point, 0), $maxTimestamp);
            $candidatePath = "{$tmpDir}/thumb_candidate_{$i}.jpg";
            $this->extractThumbnailCandidate($inputPath, $timestamp, $candidatePath);
            $candidates[] = $candidatePath;
        }

        $bestPath = $candidates[0];
        $bestScore = -1.0;
        $measured = false;

        foreach ($candidates as $candidatePath) {
            $score = $this->measureSaturation($candidatePath);

            if ($score !== null) {
                $measured = true;

                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestPath = $candidatePath;
                }
            }
        }

        if (! $measured) {
            $bestPath = $candidates[0];
        }

        File::copy($bestPath, $finalPath);

        foreach ($candidates as $candidatePath) {
            if (File::exists($candidatePath)) {
                File::delete($candidatePath);
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
