<?php

namespace App\Services;

use App\Models\Video;
use Illuminate\Database\Eloquent\Builder;

/**
 * Queries behind the Logs page, shared by the web admin and the desktop app API.
 */
class VideoLogs
{
    /**
     * Newest entries shown in each of the Success / Error lists on the Logs page.
     */
    public const LIST_LIMIT = 10;

    /**
     * Maximum rows shown in the Logs page "In Progress" card.
     */
    public const IN_PROGRESS_LIST_LIMIT = 25;

    public const TYPES = ['success', 'error', 'processing'];

    private const IN_PROGRESS_STATUSES = ['pending', 'processing'];

    /**
     * @return array{total: int, success: int, error: int, processing: int}
     */
    public function counts(): array
    {
        return [
            'total' => Video::count(),
            'success' => Video::where('status', 'ready')->count(),
            'error' => Video::where('status', 'failed')->count(),
            'processing' => Video::whereIn('status', self::IN_PROGRESS_STATUSES)->count(),
        ];
    }

    /**
     * Ordered query of one log list: "success", "error" or "processing".
     *
     * @return Builder<Video>
     */
    public function query(string $type): Builder
    {
        return match ($type) {
            'success' => Video::where('status', 'ready')->orderBy('created_at', 'desc'),
            'error' => Video::where('status', 'failed')
                ->orderByRaw('COALESCE(failed_at, updated_at) DESC')
                ->orderByDesc('id'),
            'processing' => Video::whereIn('status', self::IN_PROGRESS_STATUSES)->orderBy('created_at', 'asc'),
        };
    }
}
