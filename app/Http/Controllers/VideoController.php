<?php

namespace App\Http\Controllers;

use App\Jobs\TranscodeVideoJob;
use App\Models\Setting;
use App\Models\Video;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class VideoController extends Controller
{
    /**
     * Display a listing of the videos.
     */
    public function index(Request $request)
    {
        $request->validate([
            'search' => ['nullable', 'string'],
            'status' => ['nullable', 'in:pending,processing,ready,failed'],
        ]);

        $search = $request->query('search');
        $status = $request->query('status');

        $applySearch = function ($query) use ($search) {
            if ($search) {
                $query->where(function ($q) use ($search) {
                    $q->where('title', 'like', "%{$search}%")
                        ->orWhere('original_filename', 'like', "%{$search}%");
                });
            }
        };

        $allowedPerPage = [12, 24, 48, 100];
        $perPage = Setting::current()->videos_per_page;
        if (in_array((int) $request->query('per_page'), $allowedPerPage, true)) {
            $perPage = (int) $request->query('per_page');
        }

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        if ($status) {
            $filteredVideos = Video::where('status', $status)
                ->tap($applySearch)
                ->orderBy('created_at', 'desc')
                ->paginate($perPage);

            $disk = Setting::current()->r2Disk();

            foreach ($filteredVideos as $video) {
                if ($video->status === 'ready') {
                    $video->public_url = $disk->url($video->playlist_path);
                }
            }

            $hasActive = $filteredVideos->contains(fn ($video) => in_array($video->status, ['pending', 'processing'], true));

            return view('videos.index', compact('filteredVideos', 'status', 'search', 'deleteFromR2', 'perPage', 'allowedPerPage', 'hasActive'));
        }

        $activeVideos = Video::whereIn('status', ['pending', 'processing'])
            ->tap($applySearch)
            ->orderBy('created_at', 'asc')
            ->limit(100)
            ->get();

        $completedVideos = Video::whereIn('status', ['ready', 'failed'])
            ->tap($applySearch)
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);

        $disk = Setting::current()->r2Disk();

        foreach ($completedVideos as $video) {
            if ($video->status === 'ready') {
                $video->public_url = $disk->url($video->playlist_path);
            }
        }

        $hasActive = $activeVideos->isNotEmpty();

        return view('videos.index', compact('activeVideos', 'completedVideos', 'deleteFromR2', 'perPage', 'allowedPerPage', 'status', 'search', 'hasActive'));
    }

    /**
     * Display the system overview dashboard.
     */
    public function overview()
    {
        $totalVideos = Video::count();
        $readyCount = Video::where('status', 'ready')->count();
        $processingCount = Video::whereIn('status', ['pending', 'processing'])->count();
        $failedCount = Video::where('status', 'failed')->count();

        $cpuPercent = null;
        $cpuCores = null;
        $loadAvg1min = null;
        if (file_exists('/proc/loadavg')) {
            $loadAvg1min = (float) explode(' ', trim(file_get_contents('/proc/loadavg')))[0];
            $coreCount = substr_count(file_get_contents('/proc/cpuinfo'), 'processor');
            if ($coreCount > 0) {
                $cpuCores = $coreCount;
                $cpuPercent = min(100, round($loadAvg1min / $coreCount * 100));
            }
        }

        $ramPercent = null;
        $ramUsedGb = null;
        $ramTotalGb = null;
        if (file_exists('/proc/meminfo')) {
            $memInfo = file_get_contents('/proc/meminfo');
            preg_match('/MemTotal:\s+(\d+)/', $memInfo, $memTotalMatch);
            preg_match('/MemAvailable:\s+(\d+)/', $memInfo, $memAvailableMatch);
            if (isset($memTotalMatch[1], $memAvailableMatch[1]) && (int) $memTotalMatch[1] > 0) {
                $memTotal = (int) $memTotalMatch[1];
                $memAvailable = (int) $memAvailableMatch[1];
                $ramPercent = round((($memTotal - $memAvailable) / $memTotal) * 100);
                $ramUsedGb = round(($memTotal - $memAvailable) / 1024 / 1024, 1);
                $ramTotalGb = round($memTotal / 1024 / 1024, 1);
            }
        }

        $diskTotal = disk_total_space(storage_path());
        $diskFree = disk_free_space(storage_path());
        $diskPercent = round((($diskTotal - $diskFree) / $diskTotal) * 100);
        $diskUsedGb = round(($diskTotal - $diskFree) / 1024 / 1024 / 1024, 1);
        $diskTotalGb = round($diskTotal / 1024 / 1024 / 1024, 1);

        return view('dashboard.overview', compact(
            'totalVideos',
            'readyCount',
            'processingCount',
            'failedCount',
            'cpuPercent',
            'ramPercent',
            'diskPercent',
            'cpuCores',
            'loadAvg1min',
            'ramUsedGb',
            'ramTotalGb',
            'diskUsedGb',
            'diskTotalGb'
        ));
    }

    /**
     * Show the form for uploading a new video.
     */
    public function create()
    {
        return view('videos.create');
    }

    /**
     * Initialize a new chunked upload session.
     */
    public function initUpload(Request $request)
    {
        $maxSizeBytes = config('videos.max_upload_size_mb') * 1024 * 1024;

        $validated = $request->validate([
            'filename' => ['required', 'string', 'regex:/\.(mp4|mov|mkv|avi|webm)$/i'],
            'total_size' => ['required', 'integer', 'min:1', "max:{$maxSizeBytes}"],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $uploadId = (string) Str::uuid();
        $uploadDir = "chunked_uploads/{$uploadId}";

        Storage::disk('local')->makeDirectory("{$uploadDir}/chunks");
        Storage::disk('local')->put("{$uploadDir}/meta.json", json_encode([
            'filename' => $validated['filename'],
            'total_size' => (int) $validated['total_size'],
        ]));

        return response()->json(['upload_id' => $uploadId]);
    }

    /**
     * Receive one chunk of a chunked upload and store it as its own file.
     *
     * The chunk is first written to a uniquely named temporary file, then moved
     * into place with rename(), which is atomic on the same filesystem. A chunk
     * file therefore either exists with its full content or does not exist at
     * all, which also makes re-sending the same chunk index idempotent.
     */
    public function uploadChunk(Request $request, string $uploadId)
    {
        $disk = Storage::disk('local');
        $uploadDir = "chunked_uploads/{$uploadId}";

        if (! $disk->exists($uploadDir)) {
            abort(404);
        }

        $chunkIndex = (int) $request->header('X-Chunk-Index');

        if ($chunkIndex < 0) {
            return response()->json([
                'message' => 'The chunk index of this upload is invalid. Please try uploading again.',
            ], 422);
        }

        $chunksDir = "{$uploadDir}/chunks";
        $uniqueToken = (string) Str::uuid();
        $tmpRelativePath = "{$uploadDir}/incoming_{$chunkIndex}_{$uniqueToken}.tmp";
        $tmpPath = $disk->path($tmpRelativePath);

        try {
            $disk->makeDirectory($chunksDir);

            $tmpHandle = fopen($tmpPath, 'wb');
            if ($tmpHandle === false) {
                throw new \RuntimeException('Unable to open temporary chunk file for writing.');
            }

            $input = $request->getContent(true);
            $copied = stream_copy_to_stream($input, $tmpHandle);
            fclose($input);
            fclose($tmpHandle);

            if ($copied === false) {
                throw new \RuntimeException('Failed to read chunk data from request body.');
            }

            $declaredSize = $this->declaredUploadSize($uploadDir);

            // Without the declared size the upload limit cannot be enforced,
            // so the session is refused rather than accepted unchecked.
            if ($declaredSize === null) {
                $this->deleteFile($tmpPath, "rejecting chunk {$chunkIndex} of upload {$uploadId} whose metadata is unusable");

                return response()->json([
                    'message' => 'Upload session is invalid or expired. Please start a new upload.',
                ], 422);
            }

            $storedSize = $this->storedChunksSize($uploadDir, $chunkIndex);

            if ($storedSize + $copied > $declaredSize) {
                $this->deleteFile($tmpPath, "rejecting oversized chunk {$chunkIndex} of upload {$uploadId}");

                Log::warning("Upload {$uploadId} exceeds its declared size: chunk {$chunkIndex} would bring the total to ".($storedSize + $copied)." bytes, declared {$declaredSize} bytes.");

                return response()->json([
                    'message' => 'Upload exceeds the declared file size.',
                ], 413);
            }

            if (! rename($tmpPath, $disk->path("{$chunksDir}/{$chunkIndex}.chunk"))) {
                throw new \RuntimeException('Unable to move the received chunk into place.');
            }
        } catch (\Throwable $e) {
            $this->deleteFile($tmpPath, "cleaning up after a failed chunk upload for {$uploadId}, chunk {$chunkIndex}");

            Log::error("Chunk upload failed for uploadId {$uploadId}, chunk {$chunkIndex}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Failed to save uploaded chunk.',
            ], 500);
        }

        return response()->json(['received_index' => $chunkIndex, 'ok' => true]);
    }

    /**
     * Read the total size declared when the upload session was initialized.
     *
     * Returns null when the metadata cannot be read, which makes the upload
     * limit unenforceable and therefore invalidates the session.
     */
    private function declaredUploadSize(string $uploadDir): ?int
    {
        $metaPath = "{$uploadDir}/meta.json";

        if (! Storage::disk('local')->exists($metaPath)) {
            Log::warning("Upload metadata is missing for {$uploadDir}; the declared size cannot be enforced.");

            return null;
        }

        $meta = json_decode((string) Storage::disk('local')->get($metaPath), true);

        if (! is_array($meta) || ! isset($meta['total_size'])) {
            Log::warning("Upload metadata is unreadable for {$uploadDir}; the declared size cannot be enforced.");

            return null;
        }

        return (int) $meta['total_size'];
    }

    /**
     * Total size of the chunks already stored for an upload, optionally
     * ignoring one index (the chunk currently being received, which may
     * already exist because the client is retrying it).
     */
    private function storedChunksSize(string $uploadDir, ?int $ignoreIndex = null): int
    {
        $disk = Storage::disk('local');
        $chunksDir = "{$uploadDir}/chunks";

        if (! $disk->exists($chunksDir)) {
            return 0;
        }

        $total = 0;

        foreach ($disk->files($chunksDir) as $file) {
            if (! preg_match('/^(\d+)\.chunk$/', basename($file), $matches)) {
                continue;
            }

            if ($ignoreIndex !== null && (int) $matches[1] === $ignoreIndex) {
                continue;
            }

            $total += $disk->size($file);
        }

        return $total;
    }

    /**
     * Collect the stored chunk indexes of an upload, sorted ascending.
     *
     * @return list<int>
     */
    private function storedChunkIndexes(string $uploadDir): array
    {
        $indexes = [];

        foreach (Storage::disk('local')->files("{$uploadDir}/chunks") as $file) {
            if (preg_match('/^(\d+)\.chunk$/', basename($file), $matches)) {
                $indexes[] = (int) $matches[1];
            }
        }

        sort($indexes);

        return $indexes;
    }

    /**
     * Delete a file, logging the failure instead of silently ignoring it.
     */
    private function deleteFile(string $absolutePath, string $context): void
    {
        if (! file_exists($absolutePath)) {
            return;
        }

        if (! @unlink($absolutePath)) {
            Log::warning("Unable to delete file '{$absolutePath}' while {$context}.");
        }
    }

    /**
     * Finalize a chunked upload: assemble the file, create the video record,
     * and dispatch the transcode job.
     */
    public function completeUpload(Request $request, string $uploadId)
    {
        $maxSizeBytes = config('videos.max_upload_size_mb') * 1024 * 1024;

        $request->validate([
            'filename' => ['required', 'string', 'regex:/\.(mp4|mov|mkv|avi|webm)$/i'],
            'total_size' => ['required', 'integer', 'min:1', "max:{$maxSizeBytes}"],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $disk = Storage::disk('local');
        $uploadDir = "chunked_uploads/{$uploadId}";
        $chunksDir = "{$uploadDir}/chunks";

        if (! $disk->exists($chunksDir)) {
            abort(404);
        }

        $chunkIndexes = $this->storedChunkIndexes($uploadDir);

        if ($chunkIndexes === []) {
            abort(404);
        }

        $expectedCount = end($chunkIndexes) + 1;

        if (count($chunkIndexes) !== $expectedCount) {
            $missingIndex = null;
            foreach (range(0, $expectedCount - 1) as $index) {
                if (! in_array($index, $chunkIndexes, true)) {
                    $missingIndex = $index;
                    break;
                }
            }

            Log::warning("Upload {$uploadId} is missing chunk {$missingIndex}: received ".count($chunkIndexes)." of {$expectedCount} expected parts.");

            // There is no resume feature: the client always restarts a failed
            // upload from scratch, so the partial chunks are dead weight.
            $disk->deleteDirectory($uploadDir);

            return response()->json([
                'message' => "Upload is incomplete: missing part {$missingIndex}. Please try uploading again.",
            ], 422);
        }

        $totalSize = (int) $request->input('total_size');
        $filename = $request->input('filename');
        $extension = pathinfo($filename, PATHINFO_EXTENSION);
        $uuid = (string) Str::uuid();
        $newFilename = "{$uuid}.{$extension}";

        $disk->makeDirectory('uploads');
        $localUploadPath = $disk->path("uploads/{$newFilename}");

        try {
            $outputHandle = fopen($localUploadPath, 'wb');
            if ($outputHandle === false) {
                throw new \RuntimeException('Unable to open the assembled upload file for writing.');
            }

            try {
                foreach ($chunkIndexes as $index) {
                    $chunkHandle = fopen($disk->path("{$chunksDir}/{$index}.chunk"), 'rb');
                    if ($chunkHandle === false) {
                        throw new \RuntimeException("Unable to open chunk {$index} of upload {$uploadId}.");
                    }

                    try {
                        if (stream_copy_to_stream($chunkHandle, $outputHandle) === false) {
                            throw new \RuntimeException("Failed to append chunk {$index} of upload {$uploadId}.");
                        }
                    } finally {
                        fclose($chunkHandle);
                    }
                }
            } finally {
                fclose($outputHandle);
            }
        } catch (\Throwable $e) {
            $this->deleteFile($localUploadPath, "cleaning up after a failed assembly of upload {$uploadId}");

            Log::error("Failed to finalize upload {$uploadId}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Failed to finalize the uploaded file.',
            ], 500);
        }

        clearstatcache(true, $localUploadPath);
        $actualSize = filesize($localUploadPath);

        if ($actualSize !== $totalSize) {
            $this->deleteFile($localUploadPath, "discarding upload {$uploadId} after a size mismatch");
            $disk->deleteDirectory($uploadDir);

            Log::warning("Assembled file size mismatch for upload {$uploadId}: received {$actualSize} bytes, expected {$totalSize} bytes.");

            return response()->json([
                'message' => 'The uploaded file appears incomplete or corrupted. Please try uploading again.',
            ], 422);
        }

        $disk->deleteDirectory($uploadDir);

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mimeType = $finfo ? finfo_file($finfo, $localUploadPath) : false;

        if (! $mimeType || ! str_starts_with($mimeType, 'video/')) {
            $this->deleteFile($localUploadPath, "discarding upload {$uploadId} that is not a video file");

            return response()->json([
                'message' => 'File content does not appear to be a valid video.',
            ], 422);
        }

        try {
            $video = Video::create([
                'title' => $request->input('title') ?: $filename,
                'original_filename' => $filename,
                'original_size_bytes' => $totalSize,
                'status' => 'pending',
            ]);
        } catch (\Throwable $e) {
            $this->deleteFile($localUploadPath, "discarding upload {$uploadId} after the video record could not be created");

            Log::error("Failed to create video record for upload {$uploadId}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Failed to save video record.',
            ], 500);
        }

        try {
            TranscodeVideoJob::dispatch($video->id, $localUploadPath);
        } catch (\Throwable $e) {
            $this->deleteFile($localUploadPath, "discarding upload {$uploadId} after the transcode job could not be queued");

            try {
                $video->delete();
            } catch (\Throwable $deleteError) {
                Log::error("Failed to remove video record {$video->id} after its transcode job could not be queued: {$deleteError->getMessage()}");
            }

            Log::error("Failed to queue transcode job for upload {$uploadId}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Unable to queue this video for processing. Please try again.',
            ], 500);
        }

        return response()->json(['redirect' => route('videos.index')]);
    }

    /**
     * Display the upload log (list of all Video records as log entries).
     */
    public function logs()
    {
        $logs = Video::orderBy('created_at', 'desc')->paginate(30);

        $totalCount = Video::count();
        $successCount = Video::where('status', 'ready')->count();
        $errorCount = Video::where('status', 'failed')->count();

        return view('logs.index', compact('logs', 'totalCount', 'successCount', 'errorCount'));
    }

    /**
     * Remove the video record and its files on R2.
     */
    public function destroy(Video $video)
    {
        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        $this->deleteVideo($video, $deleteFromR2);

        if ($deleteFromR2) {
            return redirect()->route('videos.index')->with('success', 'Video has been deleted.');
        }

        return redirect()->route('videos.index')->with('success', 'Record deleted, file on R2 was KEPT.');
    }

    /**
     * Remove multiple video records and their files on R2 in one request.
     */
    public function bulkDestroy(Request $request)
    {
        $validated = $request->validate([
            'selected_ids' => ['required', 'array', 'min:1'],
            'selected_ids.*' => ['integer', 'exists:videos,id'],
        ]);

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;
        $successCount = 0;
        $failedCount = 0;

        foreach (Video::whereIn('id', $validated['selected_ids'])->get() as $video) {
            try {
                $this->deleteVideo($video, $deleteFromR2);
                $successCount++;
            } catch (\Throwable $e) {
                $failedCount++;

                Log::error("Failed to delete video {$video->id} during bulk delete: {$e->getMessage()}");
            }
        }

        $status = $failedCount > 0
            ? "Deleted {$successCount} videos ({$failedCount} failed — check logs)."
            : "Deleted {$successCount} videos.";

        return redirect()->route('videos.index')->with('status', $status);
    }

    /**
     * Delete a single video's record and, optionally, its files on R2.
     */
    private function deleteVideo(Video $video, bool $deleteFromR2): void
    {
        if ($video->disk_prefix && $deleteFromR2) {
            try {
                if (! Setting::current()->r2Disk()->deleteDirectory($video->disk_prefix)) {
                    Log::error("Failed to delete R2 files for video {$video->id} (disk_prefix: {$video->disk_prefix}); they may need to be removed manually.");
                }
            } catch (\Throwable $e) {
                Log::error("Failed to delete R2 files for video {$video->id} (disk_prefix: {$video->disk_prefix}): {$e->getMessage()}");
            }
        }

        $video->delete();

        if (! $deleteFromR2) {
            Log::info("Video {$video->id} deleted from DB only, kept files on R2 (disk_prefix: {$video->disk_prefix}).");
        }
    }
}
