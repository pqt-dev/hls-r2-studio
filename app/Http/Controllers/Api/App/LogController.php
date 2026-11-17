<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Models\Video;
use App\Services\VideoLogs;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class LogController extends Controller
{
    /**
     * The Logs page as JSON. Without "type": the counts plus the three capped lists the web page shows
     * (newest 10 errors, newest 10 successes, 25 in-progress). With "type": one list, paginated like the video list.
     */
    public function index(Request $request, VideoLogs $logs): JsonResponse
    {
        $validated = $request->validate([
            'type' => ['nullable', 'string', Rule::in(VideoLogs::TYPES)],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);

        $counts = $logs->counts();

        if (! isset($validated['type'])) {
            return response()->json([
                'counts' => $counts,
                'success' => $logs->query('success')->limit(VideoLogs::LIST_LIMIT)->get()->map($this->item(...))->all(),
                'error' => $logs->query('error')->limit(VideoLogs::LIST_LIMIT)->get()->map($this->item(...))->all(),
                'processing' => $logs->query('processing')->limit(VideoLogs::IN_PROGRESS_LIST_LIMIT)->get()->map($this->item(...))->all(),
            ]);
        }

        $paginator = $logs->query($validated['type'])->paginate(
            perPage: (int) ($validated['per_page'] ?? 24),
            page: (int) ($validated['page'] ?? 1),
        );

        return response()->json([
            'counts' => $counts,
            'data' => $paginator->getCollection()->map($this->item(...))->all(),
            'meta' => [
                'page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function item(Video $video): array
    {
        return [
            'id' => $video->id,
            'public_id' => $video->public_id,
            'title' => $video->title,
            'original_filename' => $video->original_filename,
            'status' => $video->status,
            'stage' => $video->stage,
            'progress' => $video->progress,
            'error_message' => $video->error_message,
            'error_detail' => $video->error_detail,
            'failed_at' => $video->failed_at?->toIso8601String(),
            'created_at' => $video->created_at?->toIso8601String(),
            'updated_at' => $video->updated_at?->toIso8601String(),
        ];
    }
}
