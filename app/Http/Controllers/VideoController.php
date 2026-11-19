<?php

namespace App\Http\Controllers;

use App\Exceptions\R2NotConfiguredException;
use App\Jobs\MergeUploadChunksJob;
use App\Models\Setting;
use App\Models\Video;
use App\Services\VideoActionException;
use App\Services\VideoLogs;
use App\Services\VideoManager;
use App\Support\SystemStats;
use App\Support\VideoProgress;
use App\Support\VideoStatusLogger;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class VideoController extends Controller
{
    /**
     * Extra bytes a received chunk may exceed the configured chunk size by.
     */
    private const CHUNK_SIZE_TOLERANCE_BYTES = 1024;

    /**
     * Free disk space that must remain on top of the upload size before a
     * chunked upload is assembled.
     */
    private const DISK_FREE_MARGIN_BYTES = 256 * 1024 * 1024;

    public function __construct(private VideoManager $videos, private VideoLogs $logs) {}

    /**
     * Display a listing of the videos.
     */
    public function index(Request $request)
    {
        $request->validate([
            'search' => ['nullable', 'string'],
            'range' => ['nullable', 'string', Rule::in([
                'all', 'today', 'yesterday', 'this_week', 'last_7_days', 'last_week',
                'last_28_days', 'last_30_days', 'this_month', 'last_month', 'custom',
            ])],
            'date_from' => ['required_if:range,custom', 'nullable', 'date'],
            'date_to' => ['required_if:range,custom', 'nullable', 'date', 'after_or_equal:date_from'],
        ]);

        $search = $request->query('search');

        $range = $request->query('range', 'all');
        if (! in_array($range, [
            'all', 'today', 'yesterday', 'this_week', 'last_7_days', 'last_week',
            'last_28_days', 'last_30_days', 'this_month', 'last_month', 'custom',
        ], true)) {
            $range = 'all';
        }

        $today = Carbon::now()->startOfDay();
        $dateFrom = null;
        $dateTo = null;
        $rangeLabel = 'All time';

        switch ($range) {
            case 'today':
                $dateFrom = $today->copy();
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'Today';
                break;
            case 'yesterday':
                $dateFrom = $today->copy()->subDay();
                $dateTo = $today->copy()->subDay()->endOfDay();
                $rangeLabel = 'Yesterday';
                break;
            case 'this_week':
                $dateFrom = $today->copy()->startOfWeek(Carbon::SUNDAY);
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'This week (Sun - Today)';
                break;
            case 'last_7_days':
                $dateFrom = $today->copy()->subDays(6);
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'Last 7 days';
                break;
            case 'last_week':
                $dateFrom = $today->copy()->subWeek()->startOfWeek(Carbon::SUNDAY);
                $dateTo = $today->copy()->subWeek()->endOfWeek(Carbon::SATURDAY);
                $rangeLabel = 'Last week (Sun - Sat)';
                break;
            case 'last_28_days':
                $dateFrom = $today->copy()->subDays(27);
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'Last 28 days';
                break;
            case 'last_30_days':
                $dateFrom = $today->copy()->subDays(29);
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'Last 30 days';
                break;
            case 'this_month':
                $dateFrom = $today->copy()->startOfMonth();
                $dateTo = $today->copy()->endOfDay();
                $rangeLabel = 'This month';
                break;
            case 'last_month':
                $lastMonth = $today->copy()->subMonthNoOverflow();
                $dateFrom = $lastMonth->copy()->startOfMonth();
                $dateTo = $lastMonth->copy()->endOfMonth();
                $rangeLabel = 'Last month';
                break;
            case 'custom':
                $dateFrom = Carbon::parse($request->query('date_from'))->startOfDay();
                $dateTo = Carbon::parse($request->query('date_to'))->endOfDay();
                $rangeLabel = $dateFrom->toDisplay('d/m/Y').' → '.$dateTo->toDisplay('d/m/Y');
                break;
        }

        $applySearch = function ($query) use ($search) {
            if ($search) {
                $query->where(function ($q) use ($search) {
                    // "!" is the escape character: unlike a backslash it needs no
                    // special handling in either MySQL or SQLite string literals.
                    $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $search).'%';

                    $q->whereRaw("title LIKE ? ESCAPE '!'", [$pattern])
                        ->orWhereRaw("original_filename LIKE ? ESCAPE '!'", [$pattern]);
                });
            }
        };

        $applyDateRange = function ($query) use ($dateFrom, $dateTo) {
            if ($dateFrom && $dateTo) {
                $query->whereBetween('created_at', [$dateFrom, $dateTo]);
            }
        };

        $allowedPerPage = [10, 20, 50, 100];
        $perPage = 10;
        if (in_array((int) $request->query('per_page'), $allowedPerPage, true)) {
            $perPage = (int) $request->query('per_page');
        }

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        $completedVideos = Video::whereIn('status', ['ready', 'failed'])
            ->tap($applySearch)
            ->tap($applyDateRange)
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);

        try {
            $disk = Setting::current()->r2Disk();
        } catch (R2NotConfiguredException) {
            return redirect()->route('settings.edit')
                ->with('error', 'R2 storage is not configured. Enter the R2 values in Settings to list videos.');
        }

        foreach ($completedVideos as $video) {
            if ($video->status === 'ready') {
                $video->public_url = $disk->url($video->playlist_path);
            }
        }

        $dateFromInput = $range === 'custom' ? $request->query('date_from') : null;
        $dateToInput = $range === 'custom' ? $request->query('date_to') : null;

        return view('videos.index', compact(
            'completedVideos',
            'deleteFromR2',
            'disk',
            'perPage',
            'allowedPerPage',
            'search',
            'range',
            'rangeLabel',
            'dateFromInput',
            'dateToInput'
        ));
    }

    /**
     * Display the system overview dashboard.
     */
    public function overview()
    {
        $counts = $this->logs->counts();

        $stats = SystemStats::snapshot();

        return view('dashboard.overview', [
            'totalVideos' => $counts['total'],
            'readyCount' => $counts['success'],
            'processingCount' => $counts['processing'],
            'failedCount' => $counts['error'],
        ] + $stats);
    }

    /**
     * Show the form for uploading a new video.
     */
    public function create()
    {
        $activeVideos = Video::whereIn('status', ['pending', 'processing'])
            ->orderBy('created_at', 'asc')
            ->limit(100)
            ->get();

        return view('videos.create', compact('activeVideos'));
    }

    /**
     * Return the current status/stage/progress of the given video ids, for
     * client-side polling.
     */
    public function status(Request $request)
    {
        $request->validate([
            'ids' => ['required', 'string'],
        ]);

        $ids = $this->videos->parseStatusIds($request->query('ids'));

        if ($ids === []) {
            return response()->json([]);
        }

        $videos = $this->videos->statusRows($ids);

        return response()->json($videos);
    }

    /**
     * Return the videos that are queued or being processed, with their progress.
     */
    public function inProgressCount()
    {
        $videos = Video::inProgressSnapshot();

        return response()->json(['count' => count($videos), 'videos' => $videos]);
    }

    /**
     * Return the full status/stage/progress history for the given video.
     */
    public function statusLog(Video $video)
    {
        $logs = $this->videos->statusLog($video);

        return response()->json($logs);
    }

    /**
     * Initialize a new chunked upload session.
     */
    public function initUpload(Request $request)
    {
        $maxSizeBytes = config('videos.max_upload_size_mb') * 1024 * 1024;

        $validated = $request->validate([
            'filename' => ['required', 'string', 'max:255', 'regex:/\.(mp4|mov|mkv|avi|webm)\z/i'],
            'total_size' => ['required', 'integer', 'min:1', "max:{$maxSizeBytes}"],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        // A video needs about twice its size on disk while it is assembled and
        // transcoded (merged original plus HLS output), so refuse early.
        $totalSize = (int) $validated['total_size'];
        $requiredBytes = 2 * $totalSize + self::DISK_FREE_MARGIN_BYTES;
        $freeSpace = $this->freeDiskSpace(Storage::disk('local')->path(''));

        if ($freeSpace !== false && $freeSpace < $requiredBytes) {
            Log::warning("Not enough free disk space to start an upload: {$freeSpace} bytes free, need {$requiredBytes} bytes.");

            return response()->json([
                'message' => 'The server does not have enough free disk space to process this upload.',
            ], 507);
        }

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

        // When the metadata is unusable the check is skipped here and the
        // session is refused after the body is read (see declaredUploadSize()).
        $declaredTotal = $this->declaredUploadSize($uploadDir);

        if ($chunkIndex < 0 || ($declaredTotal !== null && $chunkIndex > $this->maxChunkIndex($declaredTotal))) {
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
            // Read at most one byte past the limit so an oversized body is
            // detected without ever being written to disk in full.
            $maxChunkBytes = $this->maxChunkBytes();
            $copied = stream_copy_to_stream($input, $tmpHandle, $maxChunkBytes + 1);
            fclose($input);
            fclose($tmpHandle);

            if ($copied === false) {
                throw new \RuntimeException('Failed to read chunk data from request body.');
            }

            if ($copied > $maxChunkBytes) {
                $this->deleteFile($tmpPath, "rejecting chunk {$chunkIndex} of upload {$uploadId} that exceeds the chunk size limit");

                Log::warning("Upload {$uploadId}: chunk {$chunkIndex} exceeds the chunk size limit of {$maxChunkBytes} bytes.");

                return response()->json([
                    'message' => 'Chunk exceeds the maximum allowed chunk size.',
                ], 413);
            }

            $declaredSize = $declaredTotal;

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
     * Read the filename and total size stored at init, or null when the
     * metadata is missing or invalid.
     *
     * @return array{filename: string, total_size: int}|null
     */
    private function uploadMeta(string $uploadDir): ?array
    {
        $metaPath = "{$uploadDir}/meta.json";

        if (! Storage::disk('local')->exists($metaPath)) {
            return null;
        }

        $meta = json_decode((string) Storage::disk('local')->get($metaPath), true);

        if (! is_array($meta) || ! isset($meta['filename'], $meta['total_size']) || ! is_string($meta['filename'])) {
            return null;
        }

        return ['filename' => $meta['filename'], 'total_size' => (int) $meta['total_size']];
    }

    /**
     * Highest chunk index a client using the configured chunk size can send
     * for the declared total size, plus a tolerance of one index.
     */
    private function maxChunkIndex(int $totalSize): int
    {
        // ceil(total / chunk) - 1 is the last index; +1 is the tolerance.
        return (int) ceil($totalSize / $this->configuredChunkSizeBytes());
    }

    private function configuredChunkSizeBytes(): float
    {
        return max(1.0, (float) config('videos.chunk_size_mb') * 1024 * 1024);
    }

    /**
     * Largest body accepted for a single chunk: the configured chunk size
     * plus a small tolerance.
     */
    private function maxChunkBytes(): int
    {
        return (int) ceil($this->configuredChunkSizeBytes()) + self::CHUNK_SIZE_TOLERANCE_BYTES;
    }

    /**
     * Free bytes on the filesystem holding the given path, or false when unknown.
     */
    protected function freeDiskSpace(string $path): float|false
    {
        return @disk_free_space($path);
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
     * Finalize a chunked upload: run the cheap integrity checks, create the
     * video record and dispatch the transcode job, which merges the chunks.
     */
    public function completeUpload(Request $request, string $uploadId)
    {
        $maxSizeBytes = config('videos.max_upload_size_mb') * 1024 * 1024;

        $request->validate([
            'filename' => ['required', 'string', 'max:255', 'regex:/\.(mp4|mov|mkv|avi|webm)\z/i'],
            'total_size' => ['required', 'integer', 'min:1', "max:{$maxSizeBytes}"],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $disk = Storage::disk('local');
        $uploadDir = "chunked_uploads/{$uploadId}";
        $chunksDir = "{$uploadDir}/chunks";

        if (! $disk->exists($chunksDir)) {
            abort(404);
        }

        // meta.json (written at init) is the source of truth for the filename
        // and total size; the request values are only validated.
        $meta = $this->uploadMeta($uploadDir);

        if ($meta === null) {
            abort(404);
        }

        $chunkIndexes = $this->storedChunkIndexes($uploadDir);

        if ($chunkIndexes === []) {
            abort(404);
        }

        $expectedCount = end($chunkIndexes) + 1;

        if (count($chunkIndexes) !== $expectedCount) {
            $missingIndex = 0;
            foreach ($chunkIndexes as $storedIndex) {
                if ($storedIndex !== $missingIndex) {
                    break;
                }

                $missingIndex++;
            }

            Log::warning("Upload {$uploadId} is missing chunk {$missingIndex}: received ".count($chunkIndexes)." of {$expectedCount} expected parts.");

            // There is no resume feature: the client always restarts a failed
            // upload from scratch, so the partial chunks are dead weight.
            $disk->deleteDirectory($uploadDir);

            return response()->json([
                'message' => "Upload is incomplete: missing part {$missingIndex}. Please try uploading again.",
            ], 422);
        }

        $totalSize = $meta['total_size'];
        $filename = $meta['filename'];

        // The chunks are merged later by the queue job, so the cheap checks
        // that the merge used to provide happen here instead.
        $storedSize = $this->storedChunksSize($uploadDir);

        if ($storedSize !== $totalSize) {
            $disk->deleteDirectory($uploadDir);

            Log::warning("Chunk size mismatch for upload {$uploadId}: received {$storedSize} bytes, expected {$totalSize} bytes.");

            return response()->json([
                'message' => 'The uploaded file appears incomplete or corrupted. Please try uploading again.',
            ], 422);
        }

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mimeType = $finfo ? finfo_file($finfo, $disk->path("{$chunksDir}/{$chunkIndexes[0]}.chunk")) : false;

        if (! $mimeType || ! str_starts_with($mimeType, 'video/')) {
            $disk->deleteDirectory($uploadDir);

            return response()->json([
                'message' => 'File content does not appear to be a valid video.',
            ], 422);
        }

        $extension = pathinfo($filename, PATHINFO_EXTENSION);
        $newFilename = Str::uuid().".{$extension}";

        $disk->makeDirectory('uploads');
        $localUploadPath = $disk->path("uploads/{$newFilename}");

        $freeSpace = $this->freeDiskSpace($disk->path('uploads'));

        if ($freeSpace !== false && $freeSpace < $totalSize + self::DISK_FREE_MARGIN_BYTES) {
            Log::warning("Not enough free disk space to assemble upload {$uploadId}: {$freeSpace} bytes free, need {$totalSize} bytes plus a ".self::DISK_FREE_MARGIN_BYTES.' byte margin.');

            return response()->json([
                'message' => 'The server does not have enough free disk space to process this upload.',
            ], 507);
        }

        try {
            $video = Video::create([
                'title' => $request->input('title') ?: $filename,
                'original_filename' => $filename,
                'original_size_bytes' => $totalSize,
                'status' => 'pending',
                'progress' => VideoProgress::overall('queued', 0, $totalSize, true),
                'upload_id' => $uploadId,
            ]);
        } catch (\Throwable $e) {
            $disk->deleteDirectory($uploadDir);

            Log::error("Failed to create video record for upload {$uploadId}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Failed to save video record.',
            ], 500);
        }

        // Lines the browser logged before the video existed join the video's group.
        VideoStatusLog::where('upload_id', $uploadId)->whereNull('video_id')->update(['video_id' => $video->id]);

        try {
            MergeUploadChunksJob::dispatch($video->id, $localUploadPath, $uploadId);
        } catch (\Throwable $e) {
            // There is no resume feature: the client restarts from scratch.
            $disk->deleteDirectory($uploadDir);

            try {
                $video->delete();
            } catch (\Throwable $deleteError) {
                Log::error("Failed to remove video record {$video->id} after its merge job could not be queued: {$deleteError->getMessage()}");
            }

            Log::error("Failed to queue merge job for upload {$uploadId}: {$e->getMessage()}");

            return response()->json([
                'message' => 'Unable to queue this video for processing. Please try again.',
            ], 500);
        }

        // Announce the queued video so every client counts it in the batch before its job starts.
        VideoStatusLogger::record($video->id, 'pending', null, (int) $video->progress, $video->upload_id);

        return response()->json([
            'redirect' => route('videos.index'),
            'video_id' => $video->id,
            'video_title' => $video->title,
        ]);
    }

    /**
     * Display the upload log (list of all Video records as log entries).
     */
    public function logs()
    {
        $limit = VideoLogs::LIST_LIMIT;
        $inProgressLimit = VideoLogs::IN_PROGRESS_LIST_LIMIT;

        $counts = $this->logs->counts();
        $totalCount = $counts['total'];
        $successCount = $counts['success'];
        $errorCount = $counts['error'];
        $processingCount = $counts['processing'];

        $successLogs = $this->logs->query('success')->limit($limit)->get();
        $errorLogs = $this->logs->query('error')->limit($limit)->get();
        $processingVideos = $this->logs->query('processing')->limit($inProgressLimit)->get();

        return view('logs.index', compact(
            'totalCount', 'successCount', 'errorCount', 'processingCount',
            'successLogs', 'errorLogs', 'processingVideos', 'limit', 'inProgressLimit'
        ));
    }

    /**
     * Update a video's title.
     */
    public function update(Request $request, Video $video)
    {
        $validated = $request->validate(VideoManager::titleRules());

        $video->update($validated);

        return redirect()->route('videos.index')->with('success', 'Video title has been updated.');
    }

    /**
     * Upload (or replace) the single custom image of a video, stored on R2
     * inside the video's own folder.
     */
    public function storeImage(Request $request, Video $video)
    {
        $validated = $request->validate(VideoManager::imageRules());

        try {
            return response()->json($this->videos->storeCustomImage($video, $validated['image']));
        } catch (VideoActionException $e) {
            return response()->json(['message' => $e->getMessage()], $e->httpStatus);
        }
    }

    /**
     * Remove the custom image of a video.
     */
    public function destroyImage(Video $video)
    {
        try {
            $this->videos->destroyCustomImage($video);
        } catch (VideoActionException $e) {
            return response()->json(['message' => $e->getMessage()], $e->httpStatus);
        }

        return response()->json(['ok' => true]);
    }

    /**
     * Remove the video record and its files on R2.
     */
    public function destroy(Request $request, Video $video)
    {
        $result = $this->videos->destroy($video);

        if ($request->expectsJson()) {
            return response()->json($result);
        }

        return redirect()->route('videos.index')->with($result['status'] === 'deleted' ? 'success' : 'error', $result['message']);
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

        $result = $this->videos->bulkDestroy($validated['selected_ids']);

        return redirect()->route('videos.index')->with($result['flash_key'], $result['message']);
    }
}
