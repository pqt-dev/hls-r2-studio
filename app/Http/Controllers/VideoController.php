<?php

namespace App\Http\Controllers;

use App\Jobs\MergeUploadChunksJob;
use App\Models\Setting;
use App\Models\Video;
use App\Models\VideoStatusLog;
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

    /**
     * Newest entries shown in each of the Success / Error lists on the Logs page.
     */
    private const LOG_LIST_LIMIT = 10;

    /**
     * Maximum rows shown in the Logs page "In Progress" card.
     */
    private const IN_PROGRESS_LIST_LIMIT = 25;

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
        $perPage = Setting::current()->videos_per_page;
        if (in_array((int) $request->query('per_page'), $allowedPerPage, true)) {
            $perPage = (int) $request->query('per_page');
        }

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        $completedVideos = Video::whereIn('status', ['ready', 'failed'])
            ->tap($applySearch)
            ->tap($applyDateRange)
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);

        $disk = Setting::current()->r2Disk();

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
        $diskPercent = $diskTotal ? round((($diskTotal - $diskFree) / $diskTotal) * 100) : null;
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

        $ids = array_filter(array_map(
            fn ($id) => (int) trim($id),
            explode(',', $request->query('ids'))
        ), fn ($id) => $id > 0);

        $ids = array_slice(array_values(array_unique($ids)), 0, 50);

        if ($ids === []) {
            return response()->json([]);
        }

        $videos = Video::whereIn('id', $ids)->get(['id', 'status', 'stage', 'progress']);

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
        // Server-origin rows only: client-origin lines (message set) come from GET /activity-log.
        $logs = VideoStatusLog::where('video_id', $video->id)
            ->whereNull('message')
            ->orderBy('created_at')
            ->get(['status', 'stage', 'progress', 'created_at']);

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
        $limit = self::LOG_LIST_LIMIT;
        $inProgressLimit = self::IN_PROGRESS_LIST_LIMIT;
        $inProgressStatuses = ['pending', 'processing'];

        $totalCount = Video::count();
        $successCount = Video::where('status', 'ready')->count();
        $errorCount = Video::where('status', 'failed')->count();
        $processingCount = Video::whereIn('status', $inProgressStatuses)->count();

        $successLogs = Video::where('status', 'ready')->orderBy('created_at', 'desc')->limit($limit)->get();
        $errorLogs = Video::where('status', 'failed')
            ->orderByRaw('COALESCE(failed_at, updated_at) DESC')
            ->orderByDesc('id')
            ->limit($limit)
            ->get();
        $processingVideos = Video::whereIn('status', $inProgressStatuses)->orderBy('created_at', 'asc')->limit($inProgressLimit)->get();

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
        $validated = $request->validate([
            'title' => ['required', 'string', 'max:255'],
        ]);

        $video->update($validated);

        return redirect()->route('videos.index')->with('success', 'Video title has been updated.');
    }

    /**
     * Upload (or replace) the single custom image of a video, stored on R2
     * inside the video's own folder.
     */
    public function storeImage(Request $request, Video $video)
    {
        $validated = $request->validate([
            'image' => ['required', 'file', 'mimes:jpg,jpeg,png,webp', 'mimetypes:image/jpeg,image/png,image/webp', 'max:5120'],
        ]);

        if (! $video->disk_prefix) {
            return response()->json([
                'message' => 'This video has no storage folder yet. Please wait until it has finished processing.',
            ], 422);
        }

        $file = $validated['image'];
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

            return response()->json([
                'message' => 'Failed to upload the image. Please try again.',
            ], 500);
        }

        if ($oldPath && $oldPath !== $newPath) {
            $this->deleteR2Object($disk, $oldPath, $video);
        }

        return response()->json([
            'label' => 'Custom image',
            'url' => $disk->url($newPath).'?v='.$video->updated_at->timestamp,
        ]);
    }

    /**
     * Remove the custom image of a video.
     */
    public function destroyImage(Video $video)
    {
        if (! $video->custom_image_path) {
            return response()->json(['message' => 'This video has no custom image.'], 404);
        }

        // Keep the DB path when the object could not be deleted, otherwise it would be orphaned on R2.
        if (! $this->deleteR2Object(Setting::current()->r2Disk(), $video->custom_image_path, $video)) {
            return response()->json([
                'message' => 'Failed to delete the image. Please try again.',
            ], 500);
        }

        $video->update(['custom_image_path' => null]);

        return response()->json(['ok' => true]);
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
     * Remove the video record and its files on R2.
     */
    public function destroy(Video $video)
    {
        if ($this->isBeingProcessed($video)) {
            return redirect()->route('videos.index')->with('error', 'This video is still being processed and cannot be deleted yet.');
        }

        $deleteFromR2 = Setting::current()->delete_from_r2_on_destroy;

        try {
            $this->deleteVideo($video, $deleteFromR2);
        } catch (\Throwable $e) {
            return redirect()->route('videos.index')->with('error', 'Could not delete the files on R2; the video was kept so you can retry.');
        }

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
        $skippedCount = 0;

        foreach (Video::whereIn('id', $validated['selected_ids'])->get() as $video) {
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

        $message = "Deleted {$successCount} videos".($details ? ' ('.implode(', ', $details).')' : '').'.';

        $flashKey = $successCount === 0 && $failedCount > 0 ? 'error' : 'success';

        return redirect()->route('videos.index')->with($flashKey, $message);
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
