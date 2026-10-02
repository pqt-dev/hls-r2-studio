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
        $request->validate([
            'search' => ['nullable', 'string'],
        ]);

        $status = $request->query('status');

        $search = $request->query('search');

        $validSorts = ['newest', 'oldest', 'most_reported'];
        $sort = $request->query('sort');
        $sort = in_array($sort, $validSorts, true) ? $sort : 'newest';

        $query = Report::query()
            ->selectRaw('reports.*, (select count(*) from reports as r2 where r2.page_url = reports.page_url and r2.id != reports.id) as related_count')
            ->with(['video', 'resolvedBy'])
            ->when($status, fn ($query) => $query->where('status', $status))
            ->when($search, function ($query) use ($search) {
                $query->where(function ($q) use ($search) {
                    $q->where('page_url', 'like', "%{$search}%")
                        ->orWhere('note', 'like', "%{$search}%");
                });
            })
            ->orderByRaw("CASE WHEN status = 'resolved' THEN 1 ELSE 0 END ASC");

        match ($sort) {
            'oldest' => $query->orderByRaw("CASE WHEN status = 'resolved' THEN resolved_at ELSE last_reported_at END ASC")->orderBy('id', 'asc'),
            'most_reported' => $query->orderBy('report_count', 'desc')->orderByRaw("CASE WHEN status = 'resolved' THEN resolved_at ELSE last_reported_at END DESC")->orderBy('id', 'desc'),
            default => $query->orderByRaw("CASE WHEN status = 'resolved' THEN resolved_at ELSE last_reported_at END DESC")->orderBy('id', 'desc'), // 'newest'
        };

        $reports = $query->paginate(Setting::current()->videos_per_page);

        return view('reports.index', compact('reports', 'status', 'sort', 'search'));
    }

    /**
     * Mark the given report as resolved.
     */
    public function resolve(Request $request, Report $report)
    {
        Report::where('id', $report->id)
            ->where('status', '!=', 'resolved')
            ->update([
                'status' => 'resolved',
                'resolved_at' => now(),
                'resolved_by' => auth()->id(),
            ]);

        $report = $report->fresh();

        if ($request->wantsJson()) {
            return response()->json([
                'success' => true,
                'resolved_at' => $report->resolved_at->toDisplay(),
                'resolved_by' => auth()->user()->username,
            ]);
        }

        return back()->with('success', 'Report marked as resolved.');
    }
}
