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

            foreach ($filteredVideos as $video) {
                if ($video->status === 'ready') {
                    $video->public_url = Setting::current()->r2Disk()->url($video->playlist_path);
                }
            }

            $hasActive = $filteredVideos->contains(fn ($video) => in_array($video->status, ['pending', 'processing'], true));

            return view('videos.index', compact('filteredVideos', 'status', 'search', 'deleteFromR2', 'perPage', 'allowedPerPage', 'hasActive'));
        }

        $activeVideos = Video::whereIn('status', ['pending', 'processing'])
            ->tap($applySearch)
            ->orderBy('created_at', 'asc')
            ->get();

        $completedVideos = Video::whereIn('status', ['ready', 'failed'])
            ->tap($applySearch)
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);

        foreach ($completedVideos as $video) {
            if ($video->status === 'ready') {
                $video->public_url = Setting::current()->r2Disk()->url($video->playlist_path);
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

        $request->validate([
            'filename' => ['required', 'string', 'regex:/\.(mp4|mov|mkv|avi|webm)$/i'],
            'total_size' => ['required', 'integer', 'min:1', "max:{$maxSizeBytes}"],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $uploadId = (string) Str::uuid();

        Storage::disk('local')->makeDirectory("chunked_uploads/{$uploadId}");

        return response()->json(['upload_id' => $uploadId]);
    }

    /**
     * Receive one chunk of a chunked upload and append it to the assembled file.
     */
    public function uploadChunk(Request $request, string $uploadId)
    {
        $uploadDir = "chunked_uploads/{$uploadId}";

        if (! Storage::disk('local')->exists($uploadDir)) {
            abort(404);
        }

        $chunkIndex = (int) $request->header('X-Chunk-Index');
        $blobPath = Storage::disk('local')->path("{$uploadDir}/blob.part");

        $handle = fopen($blobPath, 'ab');
        $input = fopen('php://input', 'rb');
        stream_copy_to_stream($input, $handle);
        fclose($input);
        fclose($handle);

        return response()->json(['received_index' => $chunkIndex, 'ok' => true]);
    }

    /**
     * Finalize a chunked upload: assemble the file, create the video record,
     * and dispatch the transcode job.
     */
    public function completeUpload(Request $request, string $uploadId)
    {
        $request->validate([
            'filename' => ['required', 'string', 'regex:/\.(mp4|mov|mkv|avi|webm)$/i'],
            'total_size' => ['required', 'integer', 'min:1'],
            'title' => ['nullable', 'string', 'max:255'],
        ]);

        $uploadDir = "chunked_uploads/{$uploadId}";
        $blobPath = Storage::disk('local')->path("{$uploadDir}/blob.part");

        if (! Storage::disk('local')->exists("{$uploadDir}/blob.part")) {
            abort(404);
        }

        $totalSize = (int) $request->input('total_size');
        $actualSize = filesize($blobPath);

        if ($actualSize !== $totalSize) {
            return response()->json([
                'message' => "File assembled không khớp kích thước: nhận được {$actualSize} bytes, kỳ vọng {$totalSize} bytes.",
            ], 422);
        }

        $filename = $request->input('filename');
        $extension = pathinfo($filename, PATHINFO_EXTENSION);
        $uuid = (string) Str::uuid();
        $newFilename = "{$uuid}.{$extension}";

        Storage::disk('local')->makeDirectory('uploads');
        $localUploadPath = Storage::disk('local')->path("uploads/{$newFilename}");
        rename($blobPath, $localUploadPath);

        Storage::disk('local')->deleteDirectory($uploadDir);

        $video = Video::create([
            'title' => $request->input('title') ?: $filename,
            'original_filename' => $filename,
            'original_size_bytes' => $totalSize,
            'status' => 'pending',
        ]);

        TranscodeVideoJob::dispatch($video->id, $localUploadPath);

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
            return redirect()->route('videos.index')->with('success', 'Video đã được xoá.');
        }

        return redirect()->route('videos.index')->with('success', 'Đã xoá record, GIỮ LẠI file trên R2.');
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
        $count = 0;

        foreach (Video::whereIn('id', $validated['selected_ids'])->get() as $video) {
            $this->deleteVideo($video, $deleteFromR2);
            $count++;
        }

        return redirect()->route('videos.index')->with('status', "Đã xoá {$count} video.");
    }

    /**
     * Delete a single video's record and, optionally, its files on R2.
     */
    private function deleteVideo(Video $video, bool $deleteFromR2): void
    {
        if ($video->disk_prefix && $deleteFromR2) {
            Setting::current()->r2Disk()->deleteDirectory($video->disk_prefix);
        }

        $video->delete();

        if (! $deleteFromR2) {
            Log::info("Video {$video->id} deleted from DB only, kept files on R2 (disk_prefix: {$video->disk_prefix}).");
        }
    }
}
