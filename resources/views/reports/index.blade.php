@extends('layouts.app')

@section('title', 'Reports - HLS R2 Studio')
@section('page-title', 'Reports')
@section('breadcrumb', 'Home / Reports')

@section('content')
    <form method="GET" action="{{ route('reports.index') }}" class="mb-4 flex flex-wrap items-center gap-2">
        <x-ui.input type="text" name="search" value="{{ $search }}" placeholder="Search by page URL or note..." class="max-w-sm" />
        <input type="hidden" name="status" value="{{ $status }}">
        <input type="hidden" name="sort" value="{{ $sort }}">
        <x-ui.button type="submit">
            Search
        </x-ui.button>
    </form>

    <div class="flex flex-wrap items-center gap-2 mb-4">
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

        <x-ui.dropdown-menu id="status-filter" class="relative" panel-id="status-filter-panel">
            <x-slot:trigger>
                <x-ui.button variant="outline" id="status-filter-toggle" data-dropdown-trigger aria-haspopup="menu" aria-expanded="false">
                    <span class="text-muted-foreground">Filter:</span>
                    <span>{{ $currentStatusLabel }}</span>
                    <x-lucide-chevron-down class="w-4 h-4" />
                </x-ui.button>
            </x-slot:trigger>

            @foreach ($statusOptions as $option)
                <x-ui.dropdown-menu-item :href="route('reports.index', array_filter(['status' => $option['value'], 'sort' => $sort, 'search' => $search]))" :active="$status === $option['value']">
                    {{ $option['label'] }}
                </x-ui.dropdown-menu-item>
            @endforeach
        </x-ui.dropdown-menu>

        <x-ui.dropdown-menu id="sort-filter" class="relative" panel-id="sort-filter-panel">
            <x-slot:trigger>
                <x-ui.button variant="outline" id="sort-filter-toggle" data-dropdown-trigger aria-haspopup="menu" aria-expanded="false">
                    <span class="text-muted-foreground">Sort:</span>
                    <span>{{ $currentSortLabel }}</span>
                    <x-lucide-chevron-down class="w-4 h-4" />
                </x-ui.button>
            </x-slot:trigger>

            @foreach ($sortOptions as $option)
                <x-ui.dropdown-menu-item :href="route('reports.index', array_filter(['status' => $status, 'sort' => $option['value'], 'search' => $search]))" :active="$sort === $option['value']">
                    {{ $option['label'] }}
                </x-ui.dropdown-menu-item>
            @endforeach
        </x-ui.dropdown-menu>
    </div>

    <x-ui.alert variant="destructive" id="reports-error-banner" class="hidden mb-6 justify-between">
        <div class="flex min-w-0 items-center gap-2">
            <x-lucide-circle-x class="w-4 h-4 shrink-0" />
            <span id="reports-error-banner-message"></span>
        </div>
        <button type="button" id="reports-error-banner-close" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="Dismiss">
            <x-lucide-x class="w-4 h-4" />
        </button>
    </x-ui.alert>

    @if ($reports->isEmpty())
        <div class="rounded-lg border border-dashed border-input bg-background p-10 text-center text-muted-foreground">
            <div class="mx-auto mb-3 w-11 h-11 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 ring-1 ring-inset ring-slate-200/70 flex items-center justify-center"><x-lucide-flag class="w-5 h-5 text-slate-700 stroke-[1.75]" /></div>
            No reports found.
        </div>
    @else
        <x-ui.card class="overflow-x-auto">
            <div class="px-4 py-2.5 flex items-center justify-between border-b border-border bg-muted/40">
                <h3 class="text-sm font-semibold text-foreground inline-flex items-center gap-2"><x-lucide-flag class="w-4 h-4 stroke-[1.75] text-slate-600" /> Reports</h3>
                <span class="rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset bg-white text-slate-700 ring-slate-200">{{ $reports->total() }}</span>
            </div>
            {{-- mobile-card:start (below md the table is restyled as stacked cards via max-md:* classes) --}}
            <x-ui.table class="max-md:block">
                <x-ui.table-header class="max-md:hidden">
                    <x-ui.table-row :hover="false">
                        <x-ui.table-head>Page URL</x-ui.table-head>
                        <x-ui.table-head class="hidden xl:table-cell">Reason</x-ui.table-head>
                        <x-ui.table-head class="hidden xl:table-cell">Note</x-ui.table-head>
                        <x-ui.table-head>Status</x-ui.table-head>
                        <x-ui.table-head class="hidden md:table-cell">Reports</x-ui.table-head>
                        <x-ui.table-head class="hidden md:table-cell">Reported At</x-ui.table-head>
                        <x-ui.table-head align="right">Actions</x-ui.table-head>
                    </x-ui.table-row>
                </x-ui.table-header>
                <tbody class="[&_tr:last-child]:border-0 max-md:block">
                    @foreach ($reports as $report)
                        @php
                            $badge = match ($report->status) {
                                'new' => ['bg-amber-100 text-amber-700 ring-amber-300', 'New'],
                                'resolved' => ['bg-emerald-100 text-emerald-700 ring-emerald-300', 'Resolved'],
                                default => ['bg-slate-100 text-slate-700 ring-slate-300', $report->status],
                            };
                        @endphp
                        <x-ui.table-row data-report-row="{{ $report->id }}" class="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:p-3">
                            <x-ui.table-cell class="max-w-[10rem] md:max-w-xs truncate max-md:col-start-1 max-md:row-start-1 max-md:min-w-0 max-md:max-w-none max-md:whitespace-normal max-md:break-all max-md:p-0">
                                <a href="{{ $report->page_url }}" target="_blank" rel="noopener noreferrer" title="{{ $report->page_url }}" class="text-foreground hover:underline">{{ $report->page_url }}</a>
                                @if ($report->related_count > 0)
                                    <span class="ml-1 text-xs text-muted-foreground" title="{{ $report->related_count }} other report(s) on record for this exact page URL (including past resolved incidents)">↻ {{ $report->related_count }}</span>
                                @endif
                                <div class="hidden md:block xl:hidden text-xs text-muted-foreground mt-0.5 truncate">{{ \App\Models\Report::REASONS[$report->reason] ?? ($report->reason ?? '—') }}</div>
                                @if ($report->video)
                                    <div class="text-xs mt-0.5">
                                        <a href="{{ route('videos.index', ['search' => $report->video->title]) }}" class="text-muted-foreground hover:text-foreground hover:underline">
                                            {{ $report->video->title }}
                                        </a>
                                    </div>
                                @endif
                            </x-ui.table-cell>
                            <x-ui.table-cell class="hidden xl:table-cell text-muted-foreground max-md:col-span-full max-md:flex max-md:items-start max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:shrink-0 max-md:before:text-muted-foreground max-md:text-right max-md:before:content-['Reason']">{{ \App\Models\Report::REASONS[$report->reason] ?? ($report->reason ?? '—') }}</x-ui.table-cell>
                            <x-ui.table-cell class="hidden xl:table-cell text-muted-foreground max-w-xs truncate max-md:col-span-full max-md:flex max-md:items-start max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:shrink-0 max-md:before:text-muted-foreground max-md:max-w-none max-md:whitespace-normal max-md:break-words max-md:text-right max-md:before:content-['Note'] max-md:empty:hidden" title="{{ $report->note }}">{{ $report->note }}</x-ui.table-cell>
                            <x-ui.table-cell class="max-md:col-start-2 max-md:row-start-1 max-md:p-0" data-status-cell>
                                <span class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap {{ $badge[0] }}">{{ $badge[1] }}</span>
                            </x-ui.table-cell>
                            <x-ui.table-cell class="hidden md:table-cell max-md:col-span-full max-md:flex max-md:items-start max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:shrink-0 max-md:before:text-muted-foreground max-md:items-center max-md:before:content-['Reports']">
                                @if ($report->report_count >= 5)
                                    <span title="5+ reports — high priority" class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-300">
                                        {{ $report->report_count }}
                                    </span>
                                @elseif ($report->report_count >= 2)
                                    <span title="2-4 reports — moderate" class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset bg-amber-100 text-amber-700 ring-amber-300">
                                        {{ $report->report_count }}
                                    </span>
                                @else
                                    <span title="1 report" class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset bg-slate-100 text-slate-700 ring-slate-300">
                                        {{ $report->report_count }}
                                    </span>
                                @endif
                            </x-ui.table-cell>
                            <x-ui.table-cell class="hidden md:table-cell text-muted-foreground max-md:col-span-full max-md:p-0 max-md:text-xs max-md:before:mb-0.5 max-md:before:block max-md:before:text-muted-foreground max-md:before:content-['Reported']" data-reported-at-cell>
                                {{ $report->created_at->toDisplay('j M Y, H:i') }}
                                <div data-resolved-at-line class="text-xs text-muted-foreground" @if (! ($report->status === 'resolved' && $report->resolved_at)) style="display: none;" @endif>
                                    Resolved: <span data-resolved-at-value>{{ $report->resolved_at?->toDisplay('j M Y, H:i') }}</span>
                                    @if ($report->resolvedBy)
                                        by {{ $report->resolvedBy->username }}
                                    @endif
                                </div>
                                @if ($report->report_count > 1 && $report->last_reported_at)
                                    <div class="text-xs text-muted-foreground">Last reported: {{ $report->last_reported_at->toDisplay('j M Y, H:i') }}</div>
                                @endif
                            </x-ui.table-cell>
                            <x-ui.table-cell align="right" class="whitespace-nowrap max-md:col-span-full max-md:p-0 max-md:text-left" data-actions-cell>
                                @if ($report->status === 'new')
                                    <x-ui.button variant="outline" size="sm" class="js-mark-resolved max-md:min-h-10 max-md:w-full" data-report-id="{{ $report->id }}" data-url="{{ route('reports.resolve', $report) }}" data-page-url="{{ $report->page_url }}">
                                        Mark resolved
                                    </x-ui.button>
                                @endif
                            </x-ui.table-cell>
                        </x-ui.table-row>
                    @endforeach
                </tbody>
            </x-ui.table>
            {{-- mobile-card:end --}}
        </x-ui.card>
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
                    message: 'Mark "' + pageUrl + '" as resolved? You can still find it under the Resolved filter afterward.',
                    confirmText: 'Mark resolved',
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
                            statusCell.innerHTML = '<span class="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap bg-emerald-100 text-emerald-700 ring-emerald-300">Resolved</span>';

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
        })();
    </script>
@endpush
