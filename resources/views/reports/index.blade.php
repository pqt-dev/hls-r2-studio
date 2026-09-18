@extends('layouts.app')

@section('title', 'Reports - HLS R2 Studio')
@section('page-title', 'Reports')
@section('breadcrumb', 'Home / Reports')

@section('content')
    <div class="flex gap-2 mb-4 border-b border-gray-200">
        @php
            $tabs = [
                ['value' => null, 'label' => 'All'],
                ['value' => 'new', 'label' => 'New'],
                ['value' => 'resolved', 'label' => 'Resolved'],
            ];
        @endphp
        @foreach ($tabs as $tab)
            <a href="{{ route('reports.index', array_filter(['status' => $tab['value'], 'sort' => $sort])) }}"
               class="px-3 py-2 text-sm font-medium border-b-2 {{ $status === $tab['value'] ? 'border-emerald-700 text-emerald-700' : 'border-transparent text-gray-500 hover:text-gray-700' }}">
                {{ $tab['label'] }}
            </a>
        @endforeach
    </div>

    <div class="flex gap-2 mb-4 items-center text-sm">
        <span class="text-gray-500">Sort by:</span>
        @php
            $sortOptions = [
                ['value' => 'priority', 'label' => 'Ưu tiên'],
                ['value' => 'newest', 'label' => 'Mới nhất'],
                ['value' => 'oldest', 'label' => 'Cũ nhất'],
                ['value' => 'most_reported', 'label' => 'Nhiều báo cáo nhất'],
            ];
        @endphp
        @foreach ($sortOptions as $option)
            <a href="{{ route('reports.index', array_filter(['status' => $status, 'sort' => $option['value']])) }}"
               class="px-2 py-1 rounded-md font-medium {{ $sort === $option['value'] ? 'bg-emerald-700 text-white' : 'text-gray-500 hover:text-gray-700' }}">
                {{ $option['label'] }}
            </a>
        @endforeach
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
                                <a href="{{ $report->page_url }}" target="_blank" rel="noopener noreferrer" class="underline {{ $report->report_count >= 5 ? 'text-red-700 font-semibold' : 'text-emerald-700' }}">{{ $report->page_url }}</a>
                            </td>
                            <td class="px-3 py-2 text-gray-500 max-w-xs truncate">{{ $report->note }}</td>
                            <td class="px-3 py-2" data-status-cell>
                                <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium {{ $badge[0] }}">
                                    {{ $badge[1] }}
                                </span>
                            </td>
                            <td class="px-3 py-2">
                                @if ($report->report_count >= 5)
                                    <span class="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-1 text-xs font-bold text-white">
                                        {{ $report->report_count }}
                                    </span>
                                @elseif ($report->report_count >= 2)
                                    <span class="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-1 text-xs font-semibold text-yellow-800">
                                        {{ $report->report_count }}
                                    </span>
                                @else
                                    <span class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
                                        {{ $report->report_count }}
                                    </span>
                                @endif
                            </td>
                            <td class="px-3 py-2 text-gray-500" data-reported-at-cell>
                                {{ $report->created_at->toDisplay() }}
                                <div data-resolved-at-line class="text-xs text-gray-400" @if (! ($report->status === 'resolved' && $report->resolved_at)) style="display: none;" @endif>
                                    Resolved: <span data-resolved-at-value>{{ $report->resolved_at?->toDisplay() }}</span>
                                </div>
                                @if ($report->report_count > 1 && $report->last_reported_at)
                                    <div class="text-xs text-gray-400">Last reported: {{ $report->last_reported_at->toDisplay() }}</div>
                                @endif
                            </td>
                            <td class="px-3 py-2 text-right whitespace-nowrap" data-actions-cell>
                                @if ($report->status === 'new')
                                    <button type="button"
                                            class="js-mark-resolved inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                                            data-report-id="{{ $report->id }}"
                                            data-url="{{ route('reports.resolve', $report) }}">
                                        Mark Resolved
                                    </button>
                                @endif
                            </td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>
        <div class="mt-4">{{ $reports->appends(request()->query())->links() }}</div>
    @endif
@endsection

@push('scripts')
    <script>
        document.addEventListener('click', function (event) {
            const button = event.target.closest('.js-mark-resolved');
            if (!button) {
                return;
            }

            const url = button.dataset.url;
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

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
                    const row = button.closest('tr');

                    const statusCell = row.querySelector('[data-status-cell]');
                    statusCell.innerHTML = '<span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium bg-green-100 text-green-800">Resolved</span>';

                    const resolvedAtLine = row.querySelector('[data-resolved-at-line]');
                    resolvedAtLine.querySelector('[data-resolved-at-value]').textContent = data.resolved_at;
                    resolvedAtLine.style.display = '';

                    button.remove();

                    row.parentNode.appendChild(row);
                })
                .catch(function () {
                    alert('Failed to mark as resolved. Please try again.');
                });
        });
    </script>
@endpush
