<?php

namespace App\Jobs\Concerns;

use App\Exceptions\StorageConfigurationException;
use App\Models\Video;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Failure marking and best-effort upload cleanup shared by the jobs that
 * process a video. Requires $videoId, $localUploadPath and $uploadId
 * (nullable) properties on the using class.
 */
trait FailsVideo
{
    private const ERROR_DETAIL_MAX_LENGTH = 2000;

    /**
     * Best-effort removal of what a failed chunked upload leaves behind: the
     * chunk directory (there is no resume, so partial chunks are dead weight)
     * and, when the failure happened while merging, the partial target file.
     * A target that was fully merged is left to cleanup(), which honours
     * keep_original_upload.
     */
    private function cleanupUpload(bool $failedWhileMerging): void
    {
        if ($this->uploadId === null) {
            return;
        }

        if ($failedWhileMerging) {
            try {
                if (File::exists($this->localUploadPath)) {
                    File::delete($this->localUploadPath);
                }
            } catch (Throwable $cleanupError) {
                Log::warning('Failed to remove the partially merged file after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
            }
        }

        try {
            Storage::disk('local')->deleteDirectory("chunked_uploads/{$this->uploadId}");
        } catch (Throwable $cleanupError) {
            Log::warning('Failed to remove the chunk directory after job failure for video '.$this->videoId.': '.$cleanupError->getMessage());
        }
    }

    private function markFailed(Video $video, Throwable $e): void
    {
        $video->status = 'failed';
        $video->stage = 'failed';
        $video->error_message = $e instanceof StorageConfigurationException
            ? 'Unable to process this video due to a server storage configuration issue. Please contact the administrator.'
            : 'Unable to process this video. The file may be corrupted, in an unsupported format, or the server ran out of resources while processing it. Please check the file and try again.';
        $video->failed_at = now();
        $video->error_detail = self::buildErrorDetail($e);
    }

    /**
     * Technical summary of the exception for the admin Logs page: server
     * paths are replaced with placeholders, control characters are stripped and
     * only the last ERROR_DETAIL_MAX_LENGTH characters are kept, because ffmpeg
     * prints the actual error at the end of its stderr.
     */
    private static function buildErrorDetail(Throwable $e): string
    {
        $detail = class_basename($e).': '.$e->getMessage();

        $detail = str_replace(
            [storage_path(), base_path(), rtrim(sys_get_temp_dir(), '/\\')],
            ['[storage]', '[app]', '[tmp]'],
            $detail
        );

        $detail = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $detail);

        if (mb_strlen($detail) > self::ERROR_DETAIL_MAX_LENGTH) {
            $detail = '…'.mb_substr($detail, -self::ERROR_DETAIL_MAX_LENGTH);
        }

        return $detail;
    }
}
