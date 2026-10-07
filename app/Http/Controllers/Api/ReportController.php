<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Report;
use App\Models\Video;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class ReportController extends Controller
{
    /**
     * Store a newly reported video playback issue.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'page_url' => ['required', 'url', 'max:2048'],
            'reason' => ['nullable', 'string', Rule::in(array_keys(Report::REASONS))],
            'note' => ['nullable', 'string', 'max:1000'],
        ]);

        $allowedHosts = config('videos.report_allowed_hosts');

        if ($allowedHosts !== []) {
            $host = strtolower((string) parse_url($validated['page_url'], PHP_URL_HOST));

            if (! in_array($host, array_map('strtolower', $allowedHosts), true)) {
                throw ValidationException::withMessages([
                    'page_url' => 'The page URL host is not allowed.',
                ]);
            }
        }

        $videoId = $this->resolveVideoIdFromPageUrl($validated['page_url']);

        DB::transaction(function () use ($validated, $request, $videoId) {
            // A unique violation means another request created the active
            // report first; retry once, which then finds it. If it was
            // resolved in between, the retry creates a fresh report.
            for ($attempt = 0; $attempt < 2; $attempt++) {
                $existing = Report::where('page_url', $validated['page_url'])
                    ->where('status', 'new')
                    ->lockForUpdate()
                    ->first();

                if ($existing) {
                    $existing->increment('report_count');
                    $existing->update([
                        'last_reported_at' => now(),
                        'reporter_ip' => $request->ip(),
                        'reason' => $validated['reason'] ?? null,
                    ]);

                    return;
                }

                try {
                    Report::create([
                        ...$validated,
                        'video_id' => $videoId,
                        'reporter_ip' => $request->ip(),
                        'report_count' => 1,
                        'last_reported_at' => now(),
                    ]);

                    return;
                } catch (UniqueConstraintViolationException $e) {
                    if ($attempt === 1) {
                        throw $e;
                    }
                }
            }
        });

        return response()->json(['success' => true], 201);
    }

    private function resolveVideoIdFromPageUrl(string $pageUrl): ?int
    {
        $path = parse_url($pageUrl, PHP_URL_PATH);

        if (! $path) {
            return null;
        }

        $segments = array_values(array_filter(explode('/', $path), fn ($segment) => $segment !== ''));

        if (count($segments) < 2 || $segments[count($segments) - 2] !== 'embed') {
            return null;
        }

        $candidateId = $segments[count($segments) - 1];

        if (! ctype_digit($candidateId)) {
            return null;
        }

        return Video::whereKey((int) $candidateId)->exists() ? (int) $candidateId : null;
    }
}
