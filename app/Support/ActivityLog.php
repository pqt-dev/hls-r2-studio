<?php

namespace App\Support;

use App\Models\VideoStatusLog;
use Illuminate\Support\Collection;

/**
 * Retention and grouping rules for the Upload page Activity Log, which lives
 * in `video_status_logs`.
 *
 * A group is one video (`video_id` set) or, while no video exists, one upload
 * attempt (`video_id` NULL, `upload_id` set). Rows with both NULL are "misc"
 * rows: they belong to no group and are kept only inside the time window of
 * the groups that are kept/displayed.
 */
class ActivityLog
{
    /**
     * All groups, newest first (by their newest row).
     *
     * @return Collection<int, array{type: string, id: int|string, first_at: string, last_at: string, last_id: int}>
     */
    public static function groups(): Collection
    {
        $columns = 'MIN(created_at) as first_at, MAX(created_at) as last_at, MAX(id) as last_id';

        $videoGroups = VideoStatusLog::query()
            ->whereNotNull('video_id')
            ->groupBy('video_id')
            ->selectRaw("video_id as gid, {$columns}")
            ->get()
            ->map(fn ($row) => self::toGroup('video', (int) $row->gid, $row));

        $uploadGroups = VideoStatusLog::query()
            ->whereNull('video_id')
            ->whereNotNull('upload_id')
            ->groupBy('upload_id')
            ->selectRaw("upload_id as gid, {$columns}")
            ->get()
            ->map(fn ($row) => self::toGroup('upload', (string) $row->gid, $row));

        return $videoGroups->concat($uploadGroups)
            ->sort(fn ($a, $b) => [$b['last_at'], $b['last_id']] <=> [$a['last_at'], $a['last_id']])
            ->values();
    }

    /**
     * Rows of the given groups plus the misc rows inside their time window,
     * in chronological order.
     *
     * @param  Collection<int, array{type: string, id: int|string, first_at: string}>  $groups
     * @return Collection<int, VideoStatusLog>
     */
    public static function rowsFor(Collection $groups): Collection
    {
        if ($groups->isEmpty()) {
            return collect();
        }

        $videoIds = $groups->where('type', 'video')->pluck('id')->all();
        $uploadIds = $groups->where('type', 'upload')->pluck('id')->all();
        $windowStart = $groups->min('first_at');

        return VideoStatusLog::query()
            ->where(function ($query) use ($videoIds, $uploadIds, $windowStart) {
                $query->where(fn ($q) => $q->whereNull('video_id')->whereNull('upload_id')->where('created_at', '>=', $windowStart));

                if ($videoIds !== []) {
                    $query->orWhereIn('video_id', $videoIds);
                }

                if ($uploadIds !== []) {
                    $query->orWhere(fn ($q) => $q->whereNull('video_id')->whereIn('upload_id', $uploadIds));
                }
            })
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
    }

    /**
     * Keep the newest `retain_groups` groups; delete the rows of every older
     * group and the misc rows older than the first row of the oldest kept group.
     * Call it when a new group starts (never per progress tick), or from a scheduler.
     */
    public static function prune(): void
    {
        $retain = max(1, (int) config('videos.activity_log.retain_groups'));
        $groups = self::groups();

        if ($groups->isEmpty()) {
            return;
        }

        $kept = $groups->take($retain);
        $dropped = $groups->slice($retain);

        foreach ($dropped->where('type', 'video')->pluck('id')->chunk(500) as $ids) {
            VideoStatusLog::whereIn('video_id', $ids->all())->delete();
        }

        foreach ($dropped->where('type', 'upload')->pluck('id')->chunk(500) as $ids) {
            VideoStatusLog::whereNull('video_id')->whereIn('upload_id', $ids->all())->delete();
        }

        VideoStatusLog::whereNull('video_id')
            ->whereNull('upload_id')
            ->where('created_at', '<', $kept->min('first_at'))
            ->delete();
    }

    private static function toGroup(string $type, int|string $id, object $row): array
    {
        return [
            'type' => $type,
            'id' => $id,
            'first_at' => (string) $row->first_at,
            'last_at' => (string) $row->last_at,
            'last_id' => (int) $row->last_id,
        ];
    }
}
