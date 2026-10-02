@extends('layouts.app')

@section('title', 'Reports - HLS R2 Studio')
@section('page-title', 'Reports')
@section('breadcrumb', 'Home / Reports')

@section('content')
    <form method="GET" action="{{ route('reports.index') }}" class="mb-4 flex items-center gap-2">
        <input type="text" name="search" value="{{ $search }}" placeholder="Search by page URL or note..."
               class="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
        <input type="hidden" name="status" value="{{ $status }}">
        <input type="hidden" name="sort" value="{{ $sort }}">
        <button type="submit"
                class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
            Search
        </button>
    </form>

    <div class="flex items-center gap-2 mb-4">
        @php
            $statusOptions = [
                ['value' => null, 'label' => 'All'],
                ['value' => 'new', 'label' => 'New'],
                ['value' => 'resolved', 'label' => 'Resolved'],
            ];
            $currentStatusLabel = collect($statusOptions)->firstWhere('value', $status)['label'] ?? 'All';

            $sortOptions = [
                ['value' => 'newest', 'label' => 'Newest'],
                ['value' => 'oldest', 'label' => 'Oldest'],
                ['value' => 'most_reported', 'label' => 'Most reported'],
            ];
            $currentSortLabel = collect($sortOptions)->firstWhere('value', $sort)['label'] ?? 'Newest';
        @endphp

        <div id="status-filter" class="relative">
            <button type="button" id="status-filter-toggle"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <span class="text-gray-500">Filter:</span>
                <span id="status-filter-label">{{ $currentStatusLabel }}</span>
                <x-lucide-chevron-down class="w-4 h-4" />
            </button>

            <div id="status-filter-panel" class="hidden absolute left-0 z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                <ul class="text-sm text-gray-700">
                    @foreach ($statusOptions as $option)
                        <li>
                            <a href="{{ route('reports.index', array_filter(['status' => $option['value'], 'sort' => $sort, 'search' => $search])) }}"
                               class="block rounded-md px-3 py-1.5 {{ $status === $option['value'] ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-gray-50' }}">
                                {{ $option['label'] }}
                            </a>
                        </li>
                    @endforeach
                </ul>
            </div>
        </div>

        <div id="sort-filter" class="relative">
            <button type="button" id="sort-filter-toggle"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <span class="text-gray-500">Sort:</span>
                <span id="sort-filter-label">{{ $currentSortLabel }}</span>
                <x-lucide-chevron-down class="w-4 h-4" />
            </button>

            <div id="sort-filter-panel" class="hidden absolute left-0 z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                <ul class="text-sm text-gray-700">
                    @foreach ($sortOptions as $option)
                        <li>
                            <a href="{{ route('reports.index', array_filter(['status' => $status, 'sort' => $option['value'], 'search' => $search])) }}"
                               class="block rounded-md px-3 py-1.5 {{ $sort === $option['value'] ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-gray-50' }}">
                                {{ $option['label'] }}
                            </a>
                        </li>
                    @endforeach
                </ul>
            </div>
        </div>
    </div>

    <div id="reports-error-banner" class="hidden mb-6 rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm items-center justify-between gap-2">
        <div class="flex items-center gap-2">
            <x-lucide-circle-x class="w-4 h-4 shrink-0" />
            <span id="reports-error-banner-message"></span>
        </div>
        <button type="button" id="reports-error-banner-close" class="text-red-800 hover:text-red-900">
            <x-lucide-x class="w-4 h-4" />
        </button>
    </div>

    @if ($reports->isEmpty())
        <div class="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
            No reports found.
        </div>
    @else
        <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
                <thead class="bg-gray-50">
                    <tr>
                        <th class="px-3 py-2 text-left">Page URL</th>
                        <th class="px-3 py-2 text-left">Reason</th>
                        <th class="px-3 py-2 text-left">Note</th>
                        <th class="px-3 py-2 text-left">Status</th>
                        <th class="px-3 py-2 text-left">Reports</th>
                        <th class="px-3 py-2 text-left">Reported At</th>
                        <th class="px-3 py-2 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                    @foreach ($reports as $report)
                        @php
                            $badge = match ($report->status) {
                                'new' => ['bg-yellow-100 text-yellow-800', 'New'],
                                'resolved' => ['bg-green-100 text-green-800', 'Resolved'],
                                default => ['bg-gray-100 text-gray-800', $report->status],
                            };
                        @endphp
                        <tr data-report-row="{{ $report->id }}">
                            <td class="px-3 py-2 max-w-xs truncate">
                                <a href="{{ $report->page_url }}" target="_blank" rel="noopener noreferrer" title="{{ $report->page_url }}" class="underline {{ $report->report_count >= 5 ? 'text-red-700 font-semibold' : 'text-emerald-700' }}">{{ $report->page_url }}</a>
                                @if ($report->related_count > 0)
                                    <span class="ml-1 text-xs text-gray-400" title="{{ $report->related_count }} other report(s) on record for this exact page URL (including past resolved incidents)">↻ {{ $report->related_count }}</span>
                                @endif
                                @if ($report->video)
                                    <div class="text-xs mt-0.5">
                                        <a href="{{ route('videos.index', ['search' => $report->video->title]) }}" class="text-gray-400 hover:text-gray-600 underline">
                                            {{ $report->video->title }}
                                        </a>
                                    </div>
                                @endif
                            </td>
                            <td class="px-3 py-2 text-gray-500">{{ \App\Models\Report::REASONS[$report->reason] ?? ($report->reason ?? '—') }}</td>
                            <td class="px-3 py-2 text-gray-500 max-w-xs truncate" title="{{ $report->note }}">{{ $report->note }}</td>
                            <td class="px-3 py-2" data-status-cell>
                                <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium {{ $badge[0] }}">
                                    {{ $badge[1] }}
                                </span>
                            </td>
                            <td class="px-3 py-2">
                                @if ($report->report_count >= 5)
                                    <span title="5+ reports — high priority" class="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-1 text-xs font-bold text-white">
                                        {{ $report->report_count }}
                                    </span>
                                @elseif ($report->report_count >= 2)
                                    <span title="2-4 reports — moderate" class="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-1 text-xs font-semibold text-yellow-800">
                                        {{ $report->report_count }}
                                    </span>
                                @else
                                    <span title="1 report" class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
                                        {{ $report->report_count }}
                                    </span>
                                @endif
                            </td>
                            <td class="px-3 py-2 text-gray-500" data-reported-at-cell>
                                {{ $report->created_at->toDisplay() }}
                                <div data-resolved-at-line class="text-xs text-gray-400" @if (! ($report->status === 'resolved' && $report->resolved_at)) style="display: none;" @endif>
                                    Resolved: <span data-resolved-at-value>{{ $report->resolved_at?->toDisplay() }}</span>
                                    @if ($report->resolvedBy)
                                        by {{ $report->resolvedBy->username }}
                                    @endif
                                </div>
                                @if ($report->report_count > 1 && $report->last_reported_at)
                                    <div class="text-xs text-gray-400">Last reported: {{ $report->last_reported_at->toDisplay() }}</div>
                                @endif
                            </td>
                            <td class="px-3 py-2 text-right whitespace-nowrap" data-actions-cell>
                                @if ($report->status === 'new')
                                    <button type="button"
                                            class="js-mark-resolved inline-flex items-center gap-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700"
                                            data-report-id="{{ $report->id }}"
                                            data-url="{{ route('reports.resolve', $report) }}"
                                            data-page-url="{{ $report->page_url }}">
                                        Mark Resolved
                                    </button>
                                @endif
                            </td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>
        <div class="mt-4">{{ $reports->appends(request()->query())->links('partials.pagination') }}</div>
    @endif
@endsection

@push('scripts')
    <script>
        (function () {
            const activeStatusFilter = @json($status);

            window.__pageCleanup = function () {
                document.removeEventListener('click', onDocumentClick);
            };

            function showErrorBanner(message) {
                const banner = document.getElementById('reports-error-banner');
                document.getElementById('reports-error-banner-message').textContent = message;
                banner.classList.remove('hidden');
                banner.classList.add('flex');
            }

            function hideErrorBanner() {
                const banner = document.getElementById('reports-error-banner');
                banner.classList.add('hidden');
                banner.classList.remove('flex');
            }

            document.getElementById('reports-error-banner-close').addEventListener('click', hideErrorBanner);

            function onDocumentClick(event) {
                const button = event.target.closest('.js-mark-resolved');
                if (!button) {
                    return;
                }

                const url = button.dataset.url;
                const pageUrl = button.dataset.pageUrl;
                const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

                window.confirmDialog({
                    title: 'Mark report as resolved?',
                    message: 'Mark "' + pageUrl + '" as resolved? You can still find it under the Resolved tab afterward.',
                    confirmText: 'Mark Resolved',
                    danger: false,
                }).then(function (ok) {
                    if (!ok) {
                        return;
                    }

                    const originalText = button.textContent;
                    button.disabled = true;
                    button.textContent = 'Resolving...';
                    button.classList.add('opacity-60', 'cursor-not-allowed');

                    fetch(url, {
                        method: 'PUT',
                        headers: {
                            'X-CSRF-TOKEN': csrfToken,
                            'Accept': 'application/json',
                        },
                    })
                        .then(function (response) {
                            if (!response.ok) {
                                throw new Error('Request failed');
                            }
                            return response.json();
                        })
                        .then(function (data) {
                            hideErrorBanner();

                            const row = button.closest('tr');

                            const statusCell = row.querySelector('[data-status-cell]');
                            statusCell.innerHTML = '<span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium bg-green-100 text-green-800">Resolved</span>';

                            const resolvedAtLine = row.querySelector('[data-resolved-at-line]');
                            resolvedAtLine.querySelector('[data-resolved-at-value]').textContent = data.resolved_at;
                            if (data.resolved_by) {
                                resolvedAtLine.querySelector('[data-resolved-at-value]').insertAdjacentText('afterend', ' by ' + data.resolved_by);
                            }
                            resolvedAtLine.style.display = '';

                            button.remove();

                            if (activeStatusFilter === 'new') {
                                row.remove();
                            }
                            // else: leave the row in place — position must not change on resolve (sort order is driven
                            // purely by the chosen sort field's value, which resolving doesn't change).
                        })
                        .catch(function () {
                            showErrorBanner('Failed to mark as resolved. Please try again.');

                            button.disabled = false;
                            button.textContent = originalText;
                            button.classList.remove('opacity-60', 'cursor-not-allowed');
                        });
                });
            }

            document.addEventListener('click', onDocumentClick);

            const statusFilter = document.getElementById('status-filter');
            const statusFilterToggle = document.getElementById('status-filter-toggle');
            const statusFilterPanel = document.getElementById('status-filter-panel');

            const sortFilter = document.getElementById('sort-filter');
            const sortFilterToggle = document.getElementById('sort-filter-toggle');
            const sortFilterPanel = document.getElementById('sort-filter-panel');

            function toggleDropdown(panel) {
                panel.classList.toggle('hidden');
            }

            if (statusFilterToggle) {
                statusFilterToggle.addEventListener('click', function () {
                    sortFilterPanel.classList.add('hidden');
                    toggleDropdown(statusFilterPanel);
                });
            }

            if (sortFilterToggle) {
                sortFilterToggle.addEventListener('click', function () {
                    statusFilterPanel.classList.add('hidden');
                    toggleDropdown(sortFilterPanel);
                });
            }

            document.addEventListener('click', function (event) {
                if (statusFilter && !statusFilter.contains(event.target)) {
                    statusFilterPanel.classList.add('hidden');
                }
                if (sortFilter && !sortFilter.contains(event.target)) {
                    sortFilterPanel.classList.add('hidden');
                }
            });
        })();
    </script>
@endpush
