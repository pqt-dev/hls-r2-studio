<?php

namespace App\Services;

use App\Models\Setting;
use App\Models\Video;
use App\Models\VideoStatusLog;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Log;

/**
 * Business rules for managing videos, shared by the web admin and the desktop app API so both behave identically.
 */
class VideoManager
{
    /**
     * Most ids the status endpoints look at per request (extra ids are ignored).
     */
    public const STATUS_ID_LIMIT = 50;

    /**
     * Validation rules for a video title update.
     *
     * @return array<string, list<string>>
     */
    public static function titleRules(): array
    {
        return [
            'title' => ['required', 'string', 'max:255'],
        ];
    }

    /**
     * Validation rules for the custom image upload. The "mimetypes" rule checks the file content, not the extension.
     *
     * @return array<string, list<string>>
     */
    public static function imageRules(): array
    {
        return [
            'image' => ['required', 'file', 'mimes:jpg,jpeg,png,webp', 'mimetypes:image/jpeg,image/png,image/webp', 'max:5120'],
        ];
    }

    /**
     * Parse a comma separated id list: positive integers, de-duplicated, capped at STATUS_ID_LIMIT.
     *
     * @return list<int>
     */
    public function parseStatusIds(string $raw): array
    {
        $ids = array_filter(array_map(
            fn ($id) => (int) trim($id),
            explode(',', $raw)
        ), fn ($id) => $id > 0);

        return array_slice(array_values(array_unique($ids)), 0, self::STATUS_ID_LIMIT);
    }

    /**
     * Current status/stage/progress of the given video ids.
     *
     * @param  list<int>  $ids
     * @return Collection<int, Video>
     */
    public function statusRows(array $ids): Collection
    {
        if ($ids === []) {
            return new Collection;
        }

        return Video::whereIn('id', $ids)->get(['id', 'status', 'stage', 'progress']);
    }

    /**
     * Server-origin status history of a video (client-origin lines come from the activity log).
     *
     * @return Collection<int, VideoStatusLog>
     */
    public function statusLog(Video $video): Collection
    {
        return VideoStatusLog::where('video_id', $video->id)
            ->whereNull('message')
            ->orderBy('created_at')
            ->get(['status', 'stage', 'progress', 'created_at']);
    }

    /**
     * Store (or replace) the single custom image of a video on R2, inside the video's own folder.
     *
     * @return array{label: string, url: string}
     *
     * @throws VideoActionException
     */
    public function storeCustomImage(Video $video, UploadedFile $file): array
    {
        if (! $video->disk_prefix) {
            throw new VideoActionException(
                'no_storage_folder',
                'This video has no storage folder yet. Please wait until it has finished processing.',
                422,
            );
        }

        $extension = $file->guessExtension() === 'jpeg' ? 'jpg' : $file->guessExtension();
        $filename = 'custom-'.basename(rtrim($video->disk_prefix, '/')).'.'.$extension;
        $disk = Setting::current()->r2Disk();
        $oldPath = $video->custom_image_path;
        $newPath = null;

        try {
            $newPath = $disk->putFileAs(rtrim($video->disk_prefix, '/'), $file, $filename, [
                'ContentType' => $file->getMimeType(),
            ]);

            if (! $newPath) {
                throw new \RuntimeException('The R2 disk refused to store the file.');
            }

            // Set updated_at explicitly: a same-extension replace leaves the path unchanged, so
            // Eloquent would skip the UPDATE and the cache-busting version would not move.
            $video->forceFill(['custom_image_path' => $newPath, 'updated_at' => now()])->save();
        } catch (\Throwable $e) {
            Log::error("Failed to store custom image for video {$video->id}: {$e->getMessage()}");

            // When the keys are equal the "new" object is the old one (already overwritten); keep it.
            if ($newPath && $newPath !== $oldPath) {
                $this->deleteR2Object($disk, $newPath, $video);
            }

            throw new VideoActionException('image_store_failed', 'Failed to upload the image. Please try again.', 500);
        }

        if ($oldPath && $oldPath !== $newPath) {
            $this->deleteR2Object($disk, $oldPath, $video);
        }

        return [
            'label' => 'Custom image',
            'url' => $disk->url($newPath).'?v='.$video->updated_at->timestamp,
        ];
    }

    /**
     * Remove the custom image of a video.
     *
     * @throws VideoActionException
     */
    public function destroyCustomImage(Video $video): void
    {
        if (! $video->custom_image_path) {
            throw new VideoActionException('no_custom_image', 'This video has no custom image.', 404);
        }

        // Keep the DB path when the object could not be deleted, otherwise it would be orphaned on R2.
        if (! $this->deleteR2Object(Setting::current()->r2Disk(), $video->custom_image_path, $video)) {
            throw new VideoActionException('image_delete_failed', 'Failed to delete the image. Please try again.', 500);
        }

        $video->update(['custom_image_path' => null]);
    }

    /**
     * Delete one video. Never throws; the outcome is reported as status "deleted", "skipped" or "failed".
     *
     * @return array{status: string, message: string}
     */
    public function destroy(Video $video): array
    {
        if ($this->isBeingProcessed($video)) {
            return ['status' => 'skipped', 'message' => 'This video is still being processed and cannot be deleted yet.'];
        }

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        try {
            $this->deleteVideo($video, $deleteFromR2);
        } catch (\Throwable $e) {
            return ['status' => 'failed', 'message' => 'Could not delete the files on R2; the video was kept so you can retry.'];
        }

        return [
            'status' => 'deleted',
            'message' => $deleteFromR2 ? 'Video has been deleted.' : 'Record deleted, file on R2 was KEPT.',
        ];
    }

    /**
     * Delete several videos; videos still processing are skipped and failures are counted, not thrown.
     *
     * @param  list<int>  $ids
     * @return array{deleted: int, failed: int, skipped: int, message: string, flash_key: string}
     */
    public function bulkDestroy(array $ids): array
    {
        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;
        $successCount = 0;
        $failedCount = 0;
        $skippedCount = 0;

        foreach (Video::whereIn('id', $ids)->get() as $video) {
            if ($this->isBeingProcessed($video)) {
                $skippedCount++;

                continue;
            }

            try {
                $this->deleteVideo($video, $deleteFromR2);
                $successCount++;
            } catch (\Throwable $e) {
                $failedCount++;

                Log::error("Failed to delete video {$video->id} during bulk delete: {$e->getMessage()}");
            }
        }

        $details = [];

        if ($failedCount > 0) {
            $details[] = "{$failedCount} failed — check logs";
        }

        if ($skippedCount > 0) {
            $details[] = "{$skippedCount} skipped: still processing";
        }

        return [
            'deleted' => $successCount,
            'failed' => $failedCount,
            'skipped' => $skippedCount,
            'message' => "Deleted {$successCount} videos".($details ? ' ('.implode(', ', $details).')' : '').'.',
            'flash_key' => $successCount === 0 && $failedCount > 0 ? 'error' : 'success',
        ];
    }

    /**
     * Delete one R2 object; failures are logged, not thrown. Returns whether the object was deleted.
     */
    private function deleteR2Object($disk, string $path, Video $video): bool
    {
        try {
            if ($disk->delete($path)) {
                return true;
            }

            Log::warning("Unable to delete custom image '{$path}' of video {$video->id} from R2.");
        } catch (\Throwable $e) {
            Log::warning("Unable to delete custom image '{$path}' of video {$video->id} from R2: {$e->getMessage()}");
        }

        return false;
    }

    /**
     * Whether the video is still queued or being transcoded.
     */
    private function isBeingProcessed(Video $video): bool
    {
        return in_array($video->status, ['pending', 'processing'], true);
    }

    /**
     * Delete a single video's record and, optionally, its files on R2.
     *
     * @throws \RuntimeException when the R2 files could not be deleted; the record is kept so the delete can be retried.
     */
    private function deleteVideo(Video $video, bool $deleteFromR2): void
    {
        if ($video->disk_prefix && $deleteFromR2) {
            try {
                $deleted = Setting::current()->r2Disk()->deleteDirectory($video->disk_prefix);
            } catch (\Throwable $e) {
                Log::error("Failed to delete R2 files for video {$video->id} (disk_prefix: {$video->disk_prefix}): {$e->getMessage()}");

                throw new \RuntimeException("Failed to delete R2 files for video {$video->id}.", 0, $e);
            }

            if (! $deleted) {
                Log::error("Failed to delete R2 files for video {$video->id} (disk_prefix: {$video->disk_prefix}); the record was kept so the delete can be retried.");

                throw new \RuntimeException("Failed to delete R2 files for video {$video->id}.");
            }
        }

        $video->delete();

        if (! $deleteFromR2) {
            Log::info("Video {$video->id} deleted from DB only, kept files on R2 (disk_prefix: {$video->disk_prefix}).");
        }
    }
}
