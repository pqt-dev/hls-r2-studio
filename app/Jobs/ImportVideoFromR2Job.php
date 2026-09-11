<?php

namespace App\Jobs;

use App\Models\Video;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

class ImportVideoFromR2Job implements ShouldQueue
{
    use Queueable;

    public $tries = 1;

    /**
     * Create a new job instance.
     */
    public function __construct(
        public int $videoId,
        public string $sourceKey,
    ) {
    }

    /**
     * Execute the job.
     */
    public function handle(): void
    {
        $video = Video::findOrFail($this->videoId);

        $extension = pathinfo($this->sourceKey, PATHINFO_EXTENSION) ?: 'mp4';
        $uuid = (string) Str::uuid();
        Storage::disk('local')->makeDirectory('uploads');
        $localUploadPath = Storage::disk('local')->path("uploads/{$uuid}.{$extension}");

        try {
            $video->status = 'processing';
            $video->stage = 'queued';
            $video->progress = 0;
            $video->save();

            if (! Storage::disk('r2_source')->exists($this->sourceKey)) {
                throw new \RuntimeException("Source file not found in r2_source bucket: {$this->sourceKey}");
            }

            $sourceStream = Storage::disk('r2_source')->readStream($this->sourceKey);

            if ($sourceStream === null) {
                throw new \RuntimeException("Failed to open source stream: {$this->sourceKey}");
            }

            $localStream = fopen($localUploadPath, 'w');

            if ($localStream === false) {
                fclose($sourceStream);
                throw new \RuntimeException("Failed to open local file for writing: {$localUploadPath}");
            }

            stream_copy_to_stream($sourceStream, $localStream);
            fclose($sourceStream);
            fclose($localStream);
        } catch (Throwable $e) {
            $video->status = 'failed';
            $video->stage = 'failed';
            $video->error_message = 'Import download failed: '.$e->getMessage();
            $video->save();

            if (File::exists($localUploadPath)) {
                File::delete($localUploadPath);
            }

            Log::error('ImportVideoFromR2Job download failed for video '.$this->videoId.': '.$e->getMessage());

            throw $e;
        }

        (new TranscodeVideoJob($this->videoId, $localUploadPath))->handle();
    }
}
