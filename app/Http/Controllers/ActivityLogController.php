<?php

namespace App\Http\Controllers;

use App\Models\Video;
use App\Models\VideoStatusLog;
use App\Support\ActivityLog;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Throwable;

class ActivityLogController extends Controller
{
    private const KIND_INTERRUPTED = 'interrupted';

    private const INTERRUPTED_PREFIX = 'Upload interrupted:';

    private const INTERRUPTED_DEDUPE_SECONDS = 120;

    /** Client line ids already stored are remembered in the cache (no column needed) so redelivery is a no-op. */
    private const CID_KEY_PREFIX = 'activity-log:cid:';

    private const CID_TTL_DAYS = 7;

    private const CID_PATTERN = '/\A[A-Za-z0-9-]{8,64}\z/';

    private const CID_LOOKUP_MAX = 100;

    /**
     * The newest groups (a video, or an upload attempt without a video) plus the
     * misc rows inside their time window, chronologically. Rows of deleted videos
     * are already gone through the video_status_logs.video_id ON DELETE CASCADE FK.
     */
    public function index(Request $request): JsonResponse
    {
        $groups = ActivityLog::groups()->take(max(1, (int) config('videos.activity_log.display_groups')));
        $rows = ActivityLog::rowsFor($groups);

        $videoIds = $rows->pluck('video_id')->filter()->unique()->values();
        $videos = $videoIds->isEmpty()
            ? []
            : Video::whereIn('id', $videoIds)->get(['id', 'title', 'status'])
                ->mapWithKeys(fn (Video $video) => [$video->id => ['title' => $video->title, 'status' => $video->status]])
                ->all();

        return response()->json([
            'entries' => $rows->map(fn (VideoStatusLog $row) => [
                'id' => $row->id,
                'video_id' => $row->video_id,
                'upload_id' => $row->upload_id,
                'level' => $row->level,
                'message' => $row->message,
                'status' => $row->status,
                'stage' => $row->stage,
                'progress' => $row->progress,
                'created_at' => $row->created_at->toIso8601String(),
            ])->all(),
            'videos' => (object) $videos,
            'stored_cids' => $this->storedCids((string) $request->query('cids', '')),
        ]);
    }

    /**
     * Store client-origin Activity Log lines posted by the browser.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'entries' => ['required', 'array', 'min:1', 'max:50'],
            'entries.*' => ['array'],
            'entries.*.upload_id' => ['nullable', 'string', 'regex:/\A[0-9a-f-]{36}\z/'],
            'entries.*.video_id' => ['nullable', 'integer', 'min:1'],
            'entries.*.level' => ['nullable', 'string', 'in:info,error'],
            'entries.*.message' => ['required', 'string'],
            'entries.*.ts' => ['nullable', 'integer'],
            'entries.*.cid' => ['nullable', 'string', 'regex:'.self::CID_PATTERN],
            'entries.*.kind' => ['nullable', 'string', Rule::in([self::KIND_INTERRUPTED])],
        ]);

        $entries = collect($validated['entries']);

        $existingVideoIds = Video::whereIn('id', $entries->pluck('video_id')->filter()->unique()->all())->pluck('id')->all();
        $videoIdByUpload = Video::whereIn('upload_id', $entries->pluck('upload_id')->filter()->unique()->all())
            ->pluck('id', 'upload_id');

        $now = now();
        $earliest = $now->copy()->subDay();
        $latest = $now->copy()->addSeconds(60);
        $max = max(2, (int) config('videos.activity_log.message_max'));
        $rows = [];
        $claimedCids = [];

        foreach ($entries as $entry) {
            $message = $this->cleanMessage((string) $entry['message'], $max);

            if ($message === '') {
                continue;
            }

            $uploadId = $entry['upload_id'] ?? null;

            if (($entry['kind'] ?? null) === self::KIND_INTERRUPTED
                && $this->shouldSkipInterrupted($uploadId, $message, $videoIdByUpload, $rows, $now)) {
                continue;
            }

            $videoId = $entry['video_id'] ?? null;
            $videoId = in_array($videoId, $existingVideoIds, true) ? $videoId : null;
            // A line logged after the video was created still belongs to that video's group.
            $videoId ??= $uploadId !== null ? ($videoIdByUpload[$uploadId] ?? null) : null;

            $createdAt = $now;
            if (isset($entry['ts'])) {
                $candidate = Carbon::createFromTimestampMs((int) $entry['ts']);
                if ($candidate->betweenIncluded($earliest, $latest)) {
                    $createdAt = $candidate;
                }
            }

            // A line whose cid was already stored (retry, reload during an in-flight request) is dropped.
            $cid = $entry['cid'] ?? null;
            if ($cid !== null) {
                if (! Cache::add(self::CID_KEY_PREFIX.$cid, 1, now()->addDays(self::CID_TTL_DAYS))) {
                    continue;
                }
                $claimedCids[] = $cid;
            }

            $rows[] = [
                'video_id' => $videoId,
                'upload_id' => $uploadId,
                'level' => $entry['level'] ?? 'info',
                'message' => $message,
                'created_at' => $createdAt->format('Y-m-d H:i:s'),
            ];
        }

        if ($rows === []) {
            return response()->json(['stored' => 0]);
        }

        $startsNewGroup = $this->startsNewGroup($rows);

        try {
            DB::transaction(fn () => VideoStatusLog::insert($rows));
        } catch (Throwable $e) {
            // Nothing was stored: release the claims so the client's retry is not mistaken for a duplicate.
            foreach ($claimedCids as $claimed) {
                Cache::forget(self::CID_KEY_PREFIX.$claimed);
            }

            throw $e;
        }

        if ($startsNewGroup) {
            ActivityLog::prune();
        }

        return response()->json(['stored' => count($rows)]);
    }

    /**
     * Which of the comma-separated client line ids were already stored (lets the replay skip
     * pending outbox lines that are in the DB rows).
     *
     * @return array<int, string>
     */
    private function storedCids(string $raw): array
    {
        return collect(explode(',', $raw))
            ->filter(fn (string $cid) => preg_match(self::CID_PATTERN, $cid) === 1)
            ->unique()
            ->take(self::CID_LOOKUP_MAX)
            ->filter(fn (string $cid) => Cache::has(self::CID_KEY_PREFIX.$cid))
            ->values()
            ->all();
    }

    /**
     * An interrupted line is dropped when it would be false (the upload actually completed, so a
     * video exists and processing continues) or when it is already stored (both the pagehide and the
     * next-load mechanisms may report the same interruption).
     *
     * @param  Collection<string, int>  $videoIdByUpload
     * @param  array<int, array<string, mixed>>  $rows  rows already accepted in this request
     */
    private function shouldSkipInterrupted(?string $uploadId, string $message, $videoIdByUpload, array $rows, Carbon $now): bool
    {
        if ($uploadId !== null) {
            if (isset($videoIdByUpload[$uploadId])) {
                return true;
            }

            foreach ($rows as $row) {
                if ($row['upload_id'] === $uploadId && str_starts_with($row['message'], self::INTERRUPTED_PREFIX)) {
                    return true;
                }
            }

            return VideoStatusLog::where('upload_id', $uploadId)
                ->where('message', 'like', self::INTERRUPTED_PREFIX.'%')
                ->exists();
        }

        foreach ($rows as $row) {
            if ($row['upload_id'] === null && $row['message'] === $message) {
                return true;
            }
        }

        return VideoStatusLog::whereNull('upload_id')
            ->where('message', $message)
            ->where('created_at', '>=', $now->copy()->subSeconds(self::INTERRUPTED_DEDUPE_SECONDS)->format('Y-m-d H:i:s'))
            ->exists();
    }

    /**
     * Strip control characters (including NUL), trim, and hard-cap with an ellipsis.
     */
    private function cleanMessage(string $message, int $max): string
    {
        $clean = preg_replace('/\p{Cc}/u', '', $message);

        if ($clean === null) {
            return '';
        }

        $clean = trim($clean);

        return mb_strlen($clean) > $max ? mb_substr($clean, 0, $max - 1).'…' : $clean;
    }

    /**
     * Whether any row belongs to a video/upload group that has no rows yet.
     *
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function startsNewGroup(array $rows): bool
    {
        $videoIds = collect($rows)->pluck('video_id')->filter()->unique()->values();
        $uploadIds = collect($rows)->whereNull('video_id')->pluck('upload_id')->filter()->unique()->values();

        if ($videoIds->isNotEmpty()
            && VideoStatusLog::whereIn('video_id', $videoIds)->distinct()->count('video_id') < $videoIds->count()) {
            return true;
        }

        return $uploadIds->isNotEmpty()
            && VideoStatusLog::whereNull('video_id')->whereIn('upload_id', $uploadIds)->distinct()->count('upload_id') < $uploadIds->count();
    }
}
