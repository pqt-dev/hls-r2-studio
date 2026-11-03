<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Models\Video;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class VideoController extends Controller
{
    private const STORYBOARD_KEYS = ['3x3', '4x4', '5x5'];

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

    private function existingResponse(Video $video, ?string $diskPrefix): JsonResponse
    {
        if ($diskPrefix === null || $video->disk_prefix !== $diskPrefix) {
            return response()->json(['error' => 'public_id_conflict'], 409);
        }

        return response()->json($this->payload($video));
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
