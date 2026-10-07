<?php

namespace App\Support;

use App\Exceptions\StorageConfigurationException;
use App\Models\Video;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Assembles the chunks of a chunked upload into the original video file.
 * Shared by MergeUploadChunksJob and the legacy in-job merge of
 * TranscodeVideoJob so both behave identically.
 */
final class UploadAssembler
{
    /**
     * Minimum seconds between two merge progress updates.
     */
    private const PROGRESS_INTERVAL_SECONDS = 2;

    /**
     * Assemble the uploaded chunks, in ascending index order, into
     * $targetPath. Progress is the percentage of bytes merged, throttled so
     * that status updates (and broadcasts) are not spammed. Leaves the video
     * in stage 'queued' once the chunk directory is removed.
     */
    public static function assemble(Video $video, string $uploadId, string $targetPath): void
    {
        $disk = Storage::disk('local');
        $uploadDir = "chunked_uploads/{$uploadId}";
        $chunksDir = "{$uploadDir}/chunks";

        $video->stage = 'merging';
        $video->progress = self::overallProgress($video);
        $video->save();
        VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);

        $indexes = [];

        foreach ($disk->files($chunksDir) as $file) {
            if (preg_match('/^(\d+)\.chunk$/', basename($file), $matches)) {
                $indexes[] = (int) $matches[1];
            }
        }

        sort($indexes);

        if ($indexes === []) {
            throw new \RuntimeException('No chunks were found for this upload.');
        }

        foreach ($indexes as $position => $index) {
            if ($index !== $position) {
                throw new \RuntimeException("Chunk {$position} is missing");
            }
        }

        $expectedSize = $video->original_size_bytes;

        File::ensureDirectoryExists(dirname($targetPath));

        $outputHandle = @fopen($targetPath, 'wb');

        if ($outputHandle === false) {
            throw new StorageConfigurationException('Unable to open the merged upload file for writing.');
        }

        $mergedBytes = 0;
        $lastPercent = $video->progress;
        $lastReportAt = microtime(true);

        try {
            foreach ($indexes as $index) {
                $chunkHandle = @fopen($disk->path("{$chunksDir}/{$index}.chunk"), 'rb');

                if ($chunkHandle === false) {
                    throw new \RuntimeException("Unable to open chunk {$index}.");
                }

                try {
                    $copied = stream_copy_to_stream($chunkHandle, $outputHandle);
                } finally {
                    fclose($chunkHandle);
                }

                if ($copied === false) {
                    throw new \RuntimeException("Failed to append chunk {$index}.");
                }

                $mergedBytes += $copied;

                if ($expectedSize > 0) {
                    $percent = self::overallProgress($video, $mergedBytes / $expectedSize);

                    if ($percent !== $lastPercent && microtime(true) - $lastReportAt >= self::PROGRESS_INTERVAL_SECONDS) {
                        $lastPercent = $percent;
                        $lastReportAt = microtime(true);

                        try {
                            $video->progress = $percent;
                            $video->save();
                            VideoStatusLogger::record($video->id, $video->status, $video->stage, $video->progress);
                        } catch (Throwable $e) {
                            Log::warning('Failed to persist merge progress.', [
                                'video_id' => $video->id,
                                'error' => $e->getMessage(),
                            ]);
                        }
                    }
                }
            }
        } finally {
            fclose($outputHandle);
        }

        clearstatcache(true, $targetPath);
        $actualSize = filesize($targetPath);

        if ($expectedSize !== null && $actualSize !== $expectedSize) {
            throw new \RuntimeException("Assembled size {$actualSize} does not match expected {$expectedSize}");
        }

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mimeType = $finfo ? finfo_file($finfo, $targetPath) : false;

        if (! $mimeType || ! str_starts_with($mimeType, 'video/')) {
            throw new \RuntimeException('File content does not appear to be a valid video.');
        }

        try {
            $disk->deleteDirectory($uploadDir);
        } catch (Throwable $e) {
            Log::warning('Failed to remove the chunk directory after merging for video '.$video->id.': '.$e->getMessage());
        }

        // The merge is done: leave the 'merging' stage so a later failure is
        // not mistaken for a partial merge (which would delete the file).
        $video->stage = 'queued';
        $video->save();
    }

    /**
     * Overall progress for being $fraction through the merge, never lower
     * than what the video already reports so the number only moves forward.
     */
    private static function overallProgress(Video $video, float $fraction = 0.0): int
    {
        return max(
            (int) $video->progress,
            VideoProgress::overall('merging', $fraction, (int) $video->original_size_bytes, true)
        );
    }
}
