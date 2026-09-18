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

        $validSorts = ['priority', 'newest', 'oldest', 'most_reported'];
        $sort = $request->query('sort');
        $sort = in_array($sort, $validSorts, true) ? $sort : 'priority';

        $query = Report::query()
            ->when($status, fn ($query) => $query->where('status', $status));

        match ($sort) {
            'newest' => $query->orderBy('created_at', 'desc'),
            'oldest' => $query->orderBy('created_at', 'asc'),
            'most_reported' => $query->orderBy('report_count', 'desc')->orderBy('created_at', 'desc'),
            default => $query
                ->orderByRaw("CASE WHEN status = 'resolved' THEN 1 ELSE 0 END ASC")
                ->orderBy('report_count', 'desc')
                ->orderBy('created_at', 'desc'),
        };

        $reports = $query->paginate(Setting::current()->videos_per_page);

        return view('reports.index', compact('reports', 'status', 'sort'));
    }

    /**
     * Mark the given report as resolved.
     */
    public function resolve(Report $report)
    {
        $report->update(['status' => 'resolved', 'resolved_at' => now()]);

        return back()->with('success', 'Report marked as resolved.');
    }
}
