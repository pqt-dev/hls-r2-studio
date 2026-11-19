<?php

namespace App\Http\Controllers\Api\App;

use App\Exceptions\R2NotConfiguredException;
use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Models\Video;
use App\Services\VideoActionException;
use App\Services\VideoManager;
use App\Support\EmbedStoryboard;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\Rule;

class VideoController extends Controller
{
    private const STORYBOARD_KEYS = ['3x3', '4x4', '5x5'];

    private const LIST_COLUMNS = [
        'id', 'public_id', 'title', 'original_filename', 'original_size_bytes', 'status', 'duration',
        'output_width', 'output_height', 'output_fps', 'output_bitrate_kbps', 'output_codec', 'disk_prefix', 'playlist_path', 'thumbnail_path',
        'custom_image_path', 'storyboards', 'created_at',
    ];

    /** Accepted values of the `sort` query parameter of the list. */
    private const SORTS = ['newest', 'oldest', 'title_asc', 'title_desc', 'duration_desc', 'size_desc'];

    /** Accepted values of the `status` query parameter of the list (exact match on `videos.status`). */
    private const STATUSES = ['pending', 'processing', 'ready', 'failed'];

    /** Words of `q` that are used; more are ignored (the text is at most 100 characters anyway). */
    private const MAX_SEARCH_WORDS = 10;

    private const BULK_DELETE_LIMIT = 100;

    public function __construct(private VideoManager $videos) {}

    /**
     * Paginated, read-only list of the site's videos (all statuses). Newest first unless `sort` says otherwise.
     *
     * `status` (optional, whitelisted) keeps only videos in that status; absent means all statuses.
     * `q` is split on whitespace; every word must appear in the title or the original filename (any order). With
     * the default MySQL collation (utf8mb4_unicode_ci) LIKE is case- and accent-insensitive; "đ" still differs
     * from "d" there. `sort` is whitelisted (SORTS); ties are broken by id so pages never overlap.
     */
    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:50'],
            'q' => ['nullable', 'string', 'max:100'],
            'sort' => ['nullable', 'string', Rule::in(self::SORTS)],
            'status' => ['nullable', 'string', Rule::in(self::STATUSES)],
        ]);

        $search = trim((string) ($validated['q'] ?? ''));
        $words = array_slice(preg_split('/\s+/u', $search, -1, PREG_SPLIT_NO_EMPTY) ?: [], 0, self::MAX_SEARCH_WORDS);

        $query = Video::query();

        if (($validated['status'] ?? null) !== null && $validated['status'] !== '') {
            $query->where('status', $validated['status']);
        }

        foreach ($words as $word) {
            // "!" is the escape character (same approach as the web dashboard search).
            $pattern = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $word).'%';

            $query->where(function ($q) use ($pattern) {
                $q->whereRaw("title LIKE ? ESCAPE '!'", [$pattern])
                    ->orWhereRaw("original_filename LIKE ? ESCAPE '!'", [$pattern]);
            });
        }

        $this->applySort($query, $validated['sort'] ?? 'newest');

        $paginator = $query->paginate(
            perPage: (int) ($validated['per_page'] ?? 24),
            columns: self::LIST_COLUMNS,
            page: (int) ($validated['page'] ?? 1),
        );

        return response()->json([
            'data' => $paginator->getCollection()->map(fn (Video $video) => $this->listItem($video))->all(),
            'meta' => [
                'page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    /**
     * Register a video the desktop app already uploaded to R2.
     */
    public function store(Request $request): JsonResponse
    {
        // Idempotency first: a retry of an already-registered video must not fail on unrelated field differences.
        $publicId = $request->input('public_id');

        if (is_string($publicId) && preg_match('/^[a-z0-9]{12}$/D', $publicId) === 1) {
            $existing = Video::where('public_id', $publicId)->first();

            if ($existing) {
                $diskPrefix = $request->input('disk_prefix');

                return $this->existingResponse($existing, is_string($diskPrefix) ? $diskPrefix : null);
            }
        }

        $validated = $request->validate($this->rules($request));

        try {
            $playlistExists = Setting::current()->r2Disk()->exists($validated['playlist_path']);
        } catch (\Throwable $e) {
            // Details are never surfaced: SDK errors can echo endpoint or credential data.
            Log::warning('R2 unavailable while registering a video', ['exception' => $e::class]);

            return response()->json(['error' => 'storage_unavailable'], 503);
        }

        if (! $playlistExists) {
            return response()->json(['error' => 'playlist_not_found'], 422);
        }

        try {
            $video = Video::create([
                'public_id' => $validated['public_id'],
                'title' => $validated['title'],
                'original_filename' => $validated['original_filename'],
                'original_size_bytes' => $validated['original_size_bytes'],
                'status' => 'ready',
                'stage' => 'ready',
                'progress' => 100,
                'disk_prefix' => $validated['disk_prefix'],
                'playlist_path' => $validated['playlist_path'],
                'thumbnail_path' => $validated['thumbnail_path'] ?? null,
                'storyboards' => $validated['storyboards'] ?? null,
                'duration' => $validated['duration'] ?? null,
                'output_width' => $validated['output_width'] ?? null,
                'output_height' => $validated['output_height'] ?? null,
                'output_fps' => $validated['output_fps'] ?? null,
                'output_bitrate_kbps' => $validated['output_bitrate_kbps'] ?? null,
                'output_codec' => $validated['output_codec'] ?? null,
                'error_message' => null,
                'error_detail' => null,
                'failed_at' => null,
            ]);
        } catch (UniqueConstraintViolationException $e) {
            // A concurrent request registered the same public_id first.
            $existing = Video::where('public_id', $validated['public_id'])->first();

            if (! $existing) {
                throw $e;
            }

            return $this->existingResponse($existing, $validated['disk_prefix']);
        }

        return response()->json($this->payload($video), 201);
    }

    /**
     * Full detail of one video, as the embed player needs it. Never exposes R2 credentials or server paths.
     */
    public function show(Video $video): JsonResponse
    {
        return response()->json($this->detail($video));
    }

    /**
     * Update a video's title (same validation as the web admin).
     */
    public function update(Request $request, Video $video): JsonResponse
    {
        $video->update($request->validate(VideoManager::titleRules()));

        return response()->json($this->detail($video->refresh()));
    }

    /**
     * Status, stage and progress of the given ids (comma separated), for polling.
     */
    public function status(Request $request): JsonResponse
    {
        $request->validate(['ids' => ['required', 'string']]);

        $ids = $this->videos->parseStatusIds($request->query('ids'));

        return response()->json([
            'data' => $this->videos->statusRows($ids)
                ->map(fn (Video $video) => [
                    'id' => $video->id,
                    'status' => $video->status,
                    'stage' => $video->stage,
                    'progress' => $video->progress,
                ])
                ->values()
                ->all(),
        ]);
    }

    /**
     * Server-origin status history of a video.
     */
    public function statusLog(Video $video): JsonResponse
    {
        return response()->json([
            'data' => $this->videos->statusLog($video)
                ->map(fn ($log) => [
                    'status' => $log->status,
                    'stage' => $log->stage,
                    'progress' => $log->progress,
                    'created_at' => $log->created_at?->toIso8601String(),
                ])
                ->all(),
        ]);
    }

    /**
     * Delete one video (and its R2 files when the site setting says so). Outcome is in "status", as on the web admin.
     */
    public function destroy(Video $video): JsonResponse
    {
        return response()->json($this->videos->destroy($video));
    }

    /**
     * Delete up to BULK_DELETE_LIMIT videos at once.
     */
    public function bulkDestroy(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'selected_ids' => ['required', 'array', 'min:1', 'max:'.self::BULK_DELETE_LIMIT],
            'selected_ids.*' => ['integer', 'exists:videos,id'],
        ]);

        $result = $this->videos->bulkDestroy($validated['selected_ids']);

        return response()->json([
            'deleted' => $result['deleted'],
            'failed' => $result['failed'],
            'skipped' => $result['skipped'],
            'message' => $result['message'],
        ]);
    }

    /**
     * Upload (or replace) the custom image of a video.
     */
    public function storeImage(Request $request, Video $video): JsonResponse
    {
        $validated = $request->validate(VideoManager::imageRules());

        try {
            return response()->json($this->videos->storeCustomImage($video, $validated['image']));
        } catch (VideoActionException $e) {
            return $this->actionError($e);
        }
    }

    /**
     * Remove the custom image of a video.
     */
    public function destroyImage(Video $video): JsonResponse
    {
        try {
            $this->videos->destroyCustomImage($video);
        } catch (VideoActionException $e) {
            return $this->actionError($e);
        }

        return response()->json(['ok' => true]);
    }

    private function actionError(VideoActionException $e): JsonResponse
    {
        return response()->json(['error' => $e->errorCode, 'message' => $e->getMessage()], $e->httpStatus);
    }

    /**
     * @return array<string, mixed>
     */
    private function detail(Video $video): array
    {
        try {
            $disk = Setting::current()->r2Disk();
        } catch (R2NotConfiguredException) {
            $disk = null;
        }

        // URLs are built from the public R2 URL; if R2 is not configured they are simply absent.
        $url = function (?string $path) use ($disk): ?string {
            if (! $path || $disk === null) {
                return null;
            }

            try {
                return $disk->url($path);
            } catch (\Throwable) {
                return null;
            }
        };

        $storyboards = [];

        foreach (self::STORYBOARD_KEYS as $key) {
            $path = $video->storyboards[$key]['path'] ?? null;
            $storyboardUrl = $url($path);

            if ($storyboardUrl !== null) {
                $columns = (int) explode('x', $key)[0];
                $storyboards[$key] = ['url' => $storyboardUrl, 'columns' => $columns, 'count' => $columns * $columns];
            }
        }

        try {
            $embedStoryboard = $disk === null ? null : EmbedStoryboard::pick($video->storyboards, $disk);
        } catch (\Throwable) {
            $embedStoryboard = null;
        }

        $customImageUrl = $url($video->custom_image_path);

        return [
            'id' => $video->id,
            'public_id' => $video->public_id,
            'title' => $video->title,
            'original_filename' => $video->original_filename,
            'original_size_bytes' => $video->original_size_bytes,
            'status' => $video->status,
            'stage' => $video->stage,
            'progress' => $video->progress,
            'error' => $video->status === 'failed' ? [
                'message' => $video->error_message,
                'detail' => $video->error_detail,
                'failed_at' => $video->failed_at?->toIso8601String(),
            ] : null,
            'duration' => $video->duration,
            'output_width' => $video->output_width,
            'output_height' => $video->output_height,
            'output_fps' => $video->output_fps,
            'output_bitrate_kbps' => $video->output_bitrate_kbps,
            'output_codec' => $video->output_codec,
            'embed_url' => route('embed.show', ['video' => $video->public_id]),
            // Storage folder (key prefix) of the video's files; path only, never a URL or credentials.
            'disk_prefix' => $video->disk_prefix,
            'playlist_url' => $url($video->playlist_path),
            'thumbnail_url' => $url($video->thumbnail_path),
            'has_custom_image' => (bool) $video->custom_image_path,
            // Same cache-busting version the web admin appends.
            'custom_image_url' => $customImageUrl === null ? null : $customImageUrl.'?v='.$video->updated_at->timestamp,
            'storyboards' => $storyboards,
            'embed_storyboard' => $embedStoryboard,
            'created_at' => $video->created_at?->toIso8601String(),
            'updated_at' => $video->updated_at?->toIso8601String(),
        ];
    }

    private function existingResponse(Video $video, ?string $diskPrefix): JsonResponse
    {
        if ($diskPrefix === null || $video->disk_prefix !== $diskPrefix) {
            return response()->json(['error' => 'public_id_conflict'], 409);
        }

        return response()->json($this->payload($video));
    }

    /**
     * @return array<string, mixed>
     */
    /**
     * Orders the list. Videos without a duration/size (still processing) come last; `id` breaks every tie.
     *
     * @param  Builder<Video>  $query
     */
    private function applySort($query, string $sort): void
    {
        match ($sort) {
            'oldest' => $query->orderBy('id'),
            'title_asc' => $query->orderBy('title')->orderByDesc('id'),
            'title_desc' => $query->orderByDesc('title')->orderByDesc('id'),
            'duration_desc' => $query->orderByRaw('duration IS NULL')->orderByDesc('duration')->orderByDesc('id'),
            'size_desc' => $query->orderByRaw('original_size_bytes IS NULL')->orderByDesc('original_size_bytes')->orderByDesc('id'),
            default => $query->orderByDesc('id'),
        };
    }

    private function listItem(Video $video): array
    {
        return [
            'id' => $video->id,
            'public_id' => $video->public_id,
            'title' => $video->title,
            'original_filename' => $video->original_filename,
            'original_size_bytes' => $video->original_size_bytes,
            'status' => $video->status,
            'duration' => $video->duration,
            'output_width' => $video->output_width,
            'output_height' => $video->output_height,
            'output_fps' => $video->output_fps,
            'output_bitrate_kbps' => $video->output_bitrate_kbps,
            'output_codec' => $video->output_codec,
            'disk_prefix' => $video->disk_prefix,
            'playlist_path' => $video->playlist_path,
            'thumbnail_path' => $video->thumbnail_path,
            'custom_image_path' => $video->custom_image_path,
            'storyboards' => $video->storyboards,
            'embed_url' => route('embed.show', ['video' => $video->public_id]),
            'created_at' => $video->created_at?->toIso8601String(),
        ];
    }

    /**
     * @return array{id: int, public_id: string, embed_url: string}
     */
    private function payload(Video $video): array
    {
        return [
            'id' => $video->id,
            'public_id' => $video->public_id,
            'embed_url' => route('embed.show', ['video' => $video->public_id]),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function rules(Request $request): array
    {
        $publicId = $request->input('public_id');
        $publicId = is_string($publicId) && preg_match('/^[a-z0-9]{12}$/D', $publicId) === 1 ? $publicId : null;

        $prefix = $request->input('disk_prefix');
        $prefix = $publicId !== null && is_string($prefix)
            && preg_match('/^\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-'.preg_quote($publicId, '/').'\/$/D', $prefix) === 1
            ? $prefix : null;

        // A path field must equal the expected value; without a valid prefix nothing can match.
        $mustEqual = fn (?string $expected) => function (string $attribute, mixed $value, \Closure $fail) use ($expected) {
            if ($expected === null || $value !== $expected) {
                $fail("The {$attribute} is invalid.");
            }
        };

        return [
            'public_id' => ['required', 'string', 'regex:/^[a-z0-9]{12}$/D'],
            'title' => ['required', 'string', 'max:255'],
            'original_filename' => ['required', 'string', 'max:255'],
            'original_size_bytes' => ['required', 'integer', 'min:1'],
            'disk_prefix' => ['required', 'string', 'max:255', function (string $attribute, mixed $value, \Closure $fail) use ($prefix) {
                if ($prefix === null || $value !== $prefix) {
                    $fail('The disk prefix is invalid.');
                }
            }],
            'playlist_path' => ['required', 'string', 'max:255', $mustEqual($prefix === null ? null : $prefix.'playlist.m3u8')],
            'thumbnail_path' => ['nullable', 'string', 'max:255', $mustEqual($prefix === null ? null : $prefix.'thumbnail.jpg')],
            'storyboards' => ['nullable', 'array', function (string $attribute, mixed $value, \Closure $fail) use ($prefix) {
                foreach ((array) $value as $key => $entry) {
                    $expected = $prefix === null ? null : $prefix.'storyboard_'.$key.'.jpg';

                    if (! in_array($key, self::STORYBOARD_KEYS, true)
                        || ! is_array($entry)
                        || array_keys($entry) !== ['path']
                        || $expected === null
                        || ! is_string($entry['path'])
                        || strlen($entry['path']) > 255
                        || $entry['path'] !== $expected) {
                        $fail('The storyboards are invalid.');

                        return;
                    }
                }
            }],
            'duration' => ['nullable', 'numeric', 'min:0'],
            'output_width' => ['nullable', 'integer', 'min:1', 'max:65535'],
            'output_height' => ['nullable', 'integer', 'min:1', 'max:65535'],
            'output_fps' => ['nullable', 'numeric', 'min:0', 'max:999.99'],
            'output_bitrate_kbps' => ['nullable', 'integer', 'min:0', 'max:4294967295'],
            'output_codec' => ['nullable', 'string', 'max:20'],
        ];
    }
}
