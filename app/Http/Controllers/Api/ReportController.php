<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Report;
use App\Models\Video;
use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class ReportController extends Controller
{
    /**
     * Store a newly reported video playback issue.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'page_url' => ['required', 'url', 'max:2048'],
            'reason' => ['nullable', 'string', Rule::in(array_keys(\App\Models\Report::REASONS))],
            'note' => ['nullable', 'string', 'max:1000'],
        ]);

        $videoId = $this->resolveVideoIdFromPageUrl($validated['page_url']);

        DB::transaction(function () use ($validated, $request, $videoId) {
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
            } catch (QueryException $e) {
                if (($e->errorInfo[1] ?? null) !== 1062 || ! str_contains($e->getMessage(), 'active_report_key')) {
                    throw $e;
                }

                $existing = Report::where('page_url', $validated['page_url'])
                    ->where('status', 'new')
                    ->lockForUpdate()
                    ->first();

                $existing->increment('report_count');
                $existing->update([
                    'last_reported_at' => now(),
                    'reporter_ip' => $request->ip(),
                    'reason' => $validated['reason'] ?? null,
                ]);
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
