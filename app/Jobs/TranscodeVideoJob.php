<?php

namespace App\Jobs;

use App\Exceptions\StorageConfigurationException;
use App\Jobs\Concerns\FailsVideo;
use App\Models\Setting;
use App\Models\Video;
use App\Services\StoryboardGenerator;
use App\Services\ThumbnailGenerator;
use App\Support\UploadAssembler;
use App\Support\VideoProgress;
use App\Support\VideoStatusLogger;
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
    use FailsVideo, Queueable;

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
     * Id of the chunked upload whose chunks this job must merge into
     * $localUploadPath first. Declared with an explicit default (instead of
     * being promoted) so jobs serialized before this property existed still
     * unserialize with a null value and skip the merge stage.
     */
    public ?string $uploadId = null;

    /**
     * True when MergeUploadChunksJob already assembled the original file, so
     * no merge happens here but the progress scale still includes the merge
     * share. Declared with a default so jobs serialized before this property
     * existed unserialize as false.
     */
    public bool $merged = false;

    /**
     * Create a new job instance.
     */
    public function __construct(
        public int $videoId,
        public string $localUploadPath,
        ?string $uploadId = null,
        bool $merged = false,
    ) {
        $this->uploadId = $uploadId;
        $this->merged = $merged;
    }

    /**
     * Execute the job.
     */
    public function handle(): void
    {
        // Atomically claim this video for processing: only proceed if it is
        // still 'pending'. This prevents two workers from running the same
        // transcode concurrently, and stops a duplicate delivery from
        // re-processing (and wiping the R2 files of) a video that has already
        // finished or failed (e.g. due to queue retry_after).
        // A job queued after a separate merge keeps the progress reached so
        // far; the overall progress must never move backwards.
        $claimedAttributes = ['status' => 'processing', 'stage' => 'queued'];

        if (! $this->merged) {
            $claimedAttributes['progress'] = 0;
        }

        $claimed = Video::where('id', $this->videoId)
            ->where('status', 'pending')
            ->update($claimedAttributes);

        if ($claimed === 0) {
            Log::warning("TranscodeVideoJob skipped: video {$this->videoId} is not pending (already processing or finished).");

            return;
        }

        $video = Video::findOrFail($this->videoId);
        $video->progress = $this->overallProgress($video, 'queued');
        $video->save();

        $tmpDir = Storage::disk('local')->path("hls_tmp/{$this->videoId}");

        try {
            if ($this->uploadId !== null && ! File::exists($this->localUploadPath)) {
                UploadAssembler::assemble($video, $this->uploadId, $this->localUploadPath);
            }

            $duration = $this->probeDuration($this->localUploadPath);
            $video->duration = $duration;
            $video->stage = 'transcoding';
            $video->progress = $this->overallProgress($video, 'transcoding');
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

            File::ensureDirectoryExists($tmpDir);

            $this->runTranscode($this->localUploadPath, $tmpDir, $duration, $video);

            $video->fill($this->probeOutputInfo($tmpDir));
            $previousProgress = (int) $video->progress;
            $video->progress = $this->overallProgress($video, 'transcoding', 1.0);
            $video->save();

            // The last ffmpeg tick may already have recorded this exact value;
            // skip the record (and its broadcast) to avoid a duplicate row.
            if ($video->progress !== $previousProgress) {
                VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
            }

            $video->stage = 'generating_thumbnail';
            $video->progress = $this->overallProgress($video, 'generating_thumbnail');
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

            (new ThumbnailGenerator)->generate($this->localUploadPath, $tmpDir, $duration, $video->output_width, $video->output_height, $this->videoId);

            $video->stage = 'generating_storyboard';
            $video->progress = $this->overallProgress($video, 'generating_storyboard');
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

            try {
                (new StoryboardGenerator)->generate($this->localUploadPath, $tmpDir, $duration, $this->videoId);
            } catch (Throwable $e) {
                Log::warning('Failed to generate storyboard; proceeding without a storyboard.', [
                    'video_id' => $this->videoId,
                    'error' => $e->getMessage(),
                ]);
            }

            $video->stage = 'uploading_r2';
            $video->progress = $this->overallProgress($video, 'uploading_r2');
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

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
            $video->storyboards = StoryboardGenerator::paths($tmpDir, $prefix);
            $video->status = 'ready';
            $video->stage = 'ready';
            $video->progress = 100;
            $video->error_message = null;
            $video->save();
            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

            $this->cleanup($tmpDir);
        } catch (Throwable $e) {
            // Every step below is best-effort so that a failure in one of them
            // can neither skip the remaining cleanup nor mask the original
            // exception, which is always rethrown.
            $failedWhileMerging = $video->stage === 'merging';

            $this->markFailed($video, $e);

            try {
                $video->save();
            } catch (Throwable $saveError) {
                Log::warning('Failed to persist the failed status for video '.$this->videoId.': '.$saveError->getMessage());
            }

            try {
                VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
            } catch (Throwable $logError) {
                Log::warning('Failed to record the failed status log for video '.$this->videoId.': '.$logError->getMessage());
            }

            try {
                $this->cleanupRemoteFiles($video);
            } catch (Throwable $cleanupError) {
                Log::warning('Failed to clean up R2 files after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
            }

            try {
                $this->cleanup($tmpDir);
            } catch (Throwable $cleanupError) {
                Log::warning('Failed to clean up temp files after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
            }

            $this->cleanupUpload($failedWhileMerging);

            Log::error('TranscodeVideoJob failed for video '.$this->videoId.': '.$e->getMessage());

            throw $e;
        }
    }

    /**
     * Called by Laravel when the job fails, including cases where handle()'s
     * catch block never ran (e.g. worker killed or timed out). Idempotent:
     * does nothing unless the video is still marked 'processing'.
     */
    public function failed(Throwable $e): void
    {
        $video = Video::find($this->videoId);

        if (! $video || $video->status !== 'processing') {
            return;
        }

        $failedWhileMerging = $video->stage === 'merging';

        $this->markFailed($video, $e);
        $video->save();
        VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

        try {
            $this->cleanupRemoteFiles($video);
        } catch (Throwable $cleanupError) {
            Log::warning('Failed to clean up R2 files after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
        }

        try {
            $this->cleanup(Storage::disk('local')->path("hls_tmp/{$this->videoId}"));
        } catch (Throwable $cleanupError) {
            Log::warning('Failed to clean up temp files after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
        }

        $this->cleanupUpload($failedWhileMerging);

        Log::error('TranscodeVideoJob failed for video '.$this->videoId.': '.$e->getMessage());
    }

    /**
     * Overall progress for being $stageFraction through $stage, never lower
     * than what the video already reports so the number only moves forward.
     */
    private function overallProgress(Video $video, string $stage, float $stageFraction = 0.0): int
    {
        return max(
            (int) $video->progress,
            VideoProgress::overall($stage, $stageFraction, (int) $video->original_size_bytes, $this->uploadId !== null || $this->merged)
        );
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
                        $percent = $this->overallProgress($video, 'transcoding', ($outTimeMs / 1000000) / $duration);

                        if ($percent !== $video->progress) {
                            try {
                                $video->progress = $percent;
                                $video->save();
                                VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
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
                        $percent = $this->overallProgress($video, 'uploading_r2', $uploadedCount / $totalFiles);

                        if ($percent !== $video->progress) {
                            try {
                                $video->progress = $percent;
                                $video->save();
                                VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
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
                $percent = $this->overallProgress($video, 'uploading_r2', $uploadedCount / $totalFiles);

                if ($percent !== $video->progress) {
                    try {
                        $video->progress = $percent;
                        $video->save();
                        VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
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
