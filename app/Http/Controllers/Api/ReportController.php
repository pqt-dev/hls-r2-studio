<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Report;
use Illuminate\Http\Request;

class ReportController extends Controller
{
    /**
     * Store a newly reported video playback issue.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'page_url' => ['required', 'url', 'max:2048'],
            'note' => ['nullable', 'string', 'max:1000'],
        ]);

        $existing = Report::where('page_url', $validated['page_url'])
            ->where('status', 'new')
            ->first();

        if ($existing) {
            $existing->increment('report_count');
            $existing->update(['last_reported_at' => now()]);
        } else {
            Report::create([
                ...$validated,
                'reporter_ip' => $request->ip(),
                'report_count' => 1,
                'last_reported_at' => now(),
            ]);
        }

        return response()->json(['success' => true], 201);
    }
}
