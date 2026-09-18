<?php

namespace App\Http\Controllers;

use App\Models\Report;
use App\Models\Setting;
use Illuminate\Http\Request;

class ReportController extends Controller
{
    /**
     * Display a listing of the reports.
     */
    public function index(Request $request)
    {
        $status = $request->query('status');

        $validSorts = ['newest', 'oldest', 'most_reported'];
        $sort = $request->query('sort');
        $sort = in_array($sort, $validSorts, true) ? $sort : 'newest';

        $query = Report::query()
            ->when($status, fn ($query) => $query->where('status', $status))
            ->orderByRaw("CASE WHEN status = 'resolved' THEN 1 ELSE 0 END ASC");

        match ($sort) {
            'oldest' => $query->orderByRaw("CASE WHEN status = 'resolved' THEN resolved_at ELSE created_at END ASC"),
            'most_reported' => $query->orderBy('report_count', 'desc')->orderBy('created_at', 'desc'),
            default => $query->orderByRaw("CASE WHEN status = 'resolved' THEN resolved_at ELSE created_at END DESC"), // 'newest'
        };

        $reports = $query->paginate(Setting::current()->videos_per_page);

        return view('reports.index', compact('reports', 'status', 'sort'));
    }

    /**
     * Mark the given report as resolved.
     */
    public function resolve(Request $request, Report $report)
    {
        $report->update(['status' => 'resolved', 'resolved_at' => now()]);

        if ($request->wantsJson()) {
            return response()->json([
                'success' => true,
                'resolved_at' => $report->fresh()->resolved_at->toDisplay(),
            ]);
        }

        return back()->with('success', 'Report marked as resolved.');
    }
}
