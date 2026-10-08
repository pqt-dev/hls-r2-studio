@extends('layouts.app')

@section('title', 'Logs - HLS R2 Studio')
@section('page-title', 'Logs')
@section('breadcrumb', 'Home / Logs')

@section('content')
    <div id="logs-content">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-3.5">
            <x-ui.card>
                <x-ui.card-content>
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-muted mb-3">
                        <x-lucide-upload class="w-5 h-5 text-foreground" />
                    </div>
                    <div class="text-2xl font-semibold text-foreground leading-tight">{{ $totalCount }}</div>
                    <div class="text-sm text-muted-foreground mt-1">Total Uploads</div>
                </x-ui.card-content>
            </x-ui.card>
            <x-ui.card>
                <x-ui.card-content>
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-emerald-50 mb-3">
                        <x-lucide-circle-check class="w-5 h-5 text-emerald-600" />
                    </div>
                    <div class="text-2xl font-semibold text-foreground leading-tight">{{ $successCount }}</div>
                    <div class="text-sm text-muted-foreground mt-1">Successful</div>
                </x-ui.card-content>
            </x-ui.card>
            <x-ui.card>
                <x-ui.card-content>
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-amber-50 mb-3">
                        <x-lucide-loader-circle class="w-5 h-5 text-amber-600" />
                    </div>
                    <div class="text-2xl font-semibold text-foreground leading-tight">{{ $processingCount }}</div>
                    <div class="text-sm text-muted-foreground mt-1">Processing</div>
                </x-ui.card-content>
            </x-ui.card>
            <x-ui.card>
                <x-ui.card-content>
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-rose-50 mb-3">
                        <x-lucide-circle-x class="w-5 h-5 text-rose-600" />
                    </div>
                    <div class="text-2xl font-semibold text-foreground leading-tight">{{ $errorCount }}</div>
                    <div class="text-sm text-muted-foreground mt-1">Failed</div>
                </x-ui.card-content>
            </x-ui.card>
        </div>

        {{-- Always rendered (hidden when empty) so client-only uploads can reveal it from window.__inProgressState. --}}
        @php
                $stageLabels = [
                    'queued' => 'Queued',
                    'merging' => 'Merging chunks...',
                    'transcoding' => 'Transcoding...',
                    'generating_thumbnail' => 'Generating thumbnail...',
                    'generating_storyboard' => 'Generating storyboard...',
                    'uploading_r2' => 'Uploading to R2...',
                ];
            @endphp
            @php
                $rowProgress = fn ($video) => max(0, min(100, (int) $video->progress));
                $overallPercent = (int) round($processingVideos->avg($rowProgress) ?? 0);
                $stageText = fn ($video) => $stageLabels[$video->stage] ?? ($video->stage ? str_replace('_', ' ', $video->stage) : 'Queued');
                // Stage -> [bar fill, Processing badge] classes (full literals for Tailwind). Keep in sync with STAGE_BAR_CLASSES in videos/create.blade.php.
                $stageColors = [
                    'merging' => ['bg-gradient-to-r from-blue-400 to-indigo-500', 'bg-indigo-100 text-indigo-700 ring-indigo-300'],
                    'transcoding' => ['bg-gradient-to-r from-violet-400 to-purple-500', 'bg-violet-100 text-violet-700 ring-violet-300'],
                    'generating_thumbnail' => ['bg-gradient-to-r from-fuchsia-400 to-pink-500', 'bg-fuchsia-100 text-fuchsia-700 ring-fuchsia-300'],
                    'generating_storyboard' => ['bg-gradient-to-r from-amber-400 to-orange-500', 'bg-orange-100 text-orange-700 ring-orange-300'],
                    'uploading_r2' => ['bg-gradient-to-r from-lime-400 to-green-500', 'bg-green-100 text-green-700 ring-green-300'],
                ];
                $defaultStageColors = ['bg-gradient-to-r from-sky-400 to-blue-500', 'bg-blue-100 text-blue-700 ring-blue-300'];
                $badgeText = fn ($video) => $video->status === 'pending' && $video->stage !== 'merging' ? 'Queued' : 'Processing';
                $plural = $processingCount === 1 ? '' : 's';
                $stageCounts = $processingVideos->map(fn ($video) => rtrim($stageText($video), '.'))->countBy();
                $hiddenCount = $processingCount - $processingVideos->count();
                $summaryText = $processingCount === 1
                    ? ($processingVideos->isEmpty() ? '' : rtrim($stageText($processingVideos->first()), '.'))
                    : $stageCounts->map(fn ($count, $label) => $count.' '.lcfirst($label))->values()->when($hiddenCount > 0, fn ($parts) => $parts->push('+'.$hiddenCount.' more'))->implode(' · ');
            @endphp
            <div class="relative overflow-hidden rounded-lg border border-border bg-card text-slate-900 shadow-sm mb-3.5" role="group" aria-label="Videos in progress" data-in-progress-card @if ($processingVideos->isEmpty()) hidden @endif>
                <div class="live-shimmer h-0.5" aria-hidden="true"></div>
                <div class="relative flex flex-col items-center gap-5 p-5 sm:flex-row sm:items-center sm:gap-6">
                    <div class="relative h-24 w-24 shrink-0" role="progressbar" aria-label="Overall batch progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="{{ $overallPercent }}" data-live-ring>
                        <svg viewBox="0 0 100 100" class="h-24 w-24 -rotate-90" aria-hidden="true">
                            <defs>
                                <linearGradient id="live-ring-gradient" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stop-color="#fbbf24" />
                                    <stop offset="100%" stop-color="#f97316" />
                                </linearGradient>
                            </defs>
                            <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" stroke-width="8" />
                            <circle cx="50" cy="50" r="42" fill="none" stroke="url(#live-ring-gradient)" stroke-width="8" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="{{ 100 - $overallPercent }}" class="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500" data-live-ring-arc />
                        </svg>
                        <div class="absolute inset-0 flex flex-col items-center justify-center">
                            <div class="text-lg font-extrabold leading-none tabular-nums whitespace-nowrap"><span data-overall-current>{{ $processingVideos->isEmpty() ? 0 : 1 }}</span> of <span data-overall-total>{{ $processingCount }}</span></div>
                        </div>
                    </div>

                    <div class="min-w-0 w-full flex-1 text-center sm:text-left">
                        <div class="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                            <span class="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-600 ring-1 ring-red-200">
                                <span class="relative inline-flex h-2 w-2">
                                    <span class="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 motion-safe:animate-ping"></span>
                                    <span class="relative inline-flex h-2 w-2 rounded-full bg-red-500"></span>
                                </span>
                                Live
                                <span class="flex h-3 items-end gap-px" aria-hidden="true">
                                    <span class="live-eq w-0.5 rounded-sm bg-red-400" style="animation-delay: 0s"></span>
                                    <span class="live-eq w-0.5 rounded-sm bg-red-400" style="animation-delay: -0.4s"></span>
                                    <span class="live-eq w-0.5 rounded-sm bg-red-400" style="animation-delay: -0.8s"></span>
                                </span>
                            </span>
                            <h3 class="text-base font-semibold text-slate-900" data-live-title>Processing {{ $processingCount }} video{{ $plural }}</h3>
                        </div>
                        <div class="mt-1.5 truncate text-sm text-slate-600" data-live-summary>{{ $summaryText }}</div>
                    </div>
                </div>
                <span class="sr-only" aria-live="polite" data-live-announce>Processing video 1 of {{ $processingCount }}, {{ $overallPercent }} percent</span>

                <div class="relative divide-y divide-slate-200 border-t border-slate-200" data-log-list="processing">
                    @foreach ($processingVideos as $video)
                        @php
                            $badge = $badgeText($video);
                            $stage = $stageText($video);
                            $isQueued = $badge === 'Queued';
                            $percent = $isQueued ? 0 : $rowProgress($video);
                            $dim = $isQueued ? 'opacity-60' : '';
                            [$barColor, $badgeColor] = $stageColors[$video->stage] ?? $defaultStageColors;
                        @endphp
                        <div class="flex items-center gap-3 px-5 py-3" data-video-id="{{ $video->id }}" data-stage-label="{{ $stage }}" @if ($isQueued) data-queued @endif>
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-2 {{ $dim }}">
                                    <div class="min-w-0 font-medium text-slate-900 text-sm truncate" data-video-title>{{ $video->title }}</div>
                                    <div class="text-xs text-slate-500 whitespace-nowrap shrink-0">{{ $video->created_at->toDisplay('j M Y, H:i') }}</div>
                                </div>
                                @if ($video->original_filename !== $video->title)
                                    <div class="text-xs text-slate-500 truncate {{ $dim }}">{{ $video->original_filename }}</div>
                                @endif
                                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 {{ $isQueued ? 'bg-sky-100 text-sky-700 ring-sky-300' : $badgeColor }}">{{ $badge }}</span>
                                    @if ($stage !== $badge)
                                        <span class="text-xs text-slate-600 {{ $dim }}" data-video-stage>{{ $stage }}</span>
                                    @endif
                                </div>
                                <div class="mt-2 flex items-center gap-2 {{ $dim }}">
                                    <div class="h-1 flex-1 overflow-hidden rounded-full bg-slate-200">
                                        <div class="h-full rounded-full {{ $barColor }} motion-safe:transition-[width] motion-safe:duration-300" style="width: {{ $percent }}%" data-video-bar></div>
                                    </div>
                                    <span class="w-9 text-right text-xs font-medium text-slate-600 tabular-nums" data-video-percent>{{ $percent }}%</span>
                                </div>
                            </div>
                            <a href="{{ route('videos.create') }}" aria-label="View live progress" title="View live progress" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-colors hover:bg-orange-50 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
                                <x-lucide-arrow-right class="h-4 w-4" />
                            </a>
                        </div>
                    @endforeach
                </div>
                @if ($processingCount > $inProgressLimit)
                    <div class="relative border-t border-slate-200 px-5 py-2 text-xs text-slate-500">Showing {{ $inProgressLimit }} of {{ $processingCount }}</div>
                @endif
            </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            <x-ui.card class="overflow-hidden">
                <div class="bg-rose-600 px-4 py-2.5 flex items-center justify-between">
                    <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-x class="w-4 h-4" /> Error Logs</h3>
                    <span class="text-xs font-semibold text-white/90">{{ $errorCount }}</span>
                </div>
                <div class="divide-y divide-border" data-log-list="error">
                    @forelse ($errorLogs as $log)
                        <div class="px-4 py-3" data-log-id="{{ $log->id }}">
                            <div class="flex items-center justify-between gap-2">
                                <div class="min-w-0 font-medium text-foreground text-sm truncate">{{ $log->title }}</div>
                                <div class="text-xs text-muted-foreground whitespace-nowrap shrink-0" title="Failed at">Failed {{ ($log->failed_at ?? $log->updated_at)->toDisplay() }}</div>
                            </div>
                            <div class="text-xs text-muted-foreground truncate">{{ $log->original_filename }}</div>
                            @if ($log->error_message)
                                <div class="text-xs text-rose-600 mt-1 line-clamp-3 break-words">{{ $log->error_message }}</div>
                            @endif
                            @if (! empty($log->error_detail))
                                <details class="mt-1" data-log-detail="{{ $log->id }}">
                                    <summary class="text-xs font-medium text-muted-foreground cursor-pointer select-none">Technical details</summary>
                                    <pre class="mt-1 rounded-md bg-muted p-2 text-xs text-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{{ $log->error_detail }}</pre>
                                </details>
                            @endif
                        </div>
                    @empty
                        <div class="px-4 py-6 text-center text-sm text-muted-foreground">No error logs.</div>
                    @endforelse
                </div>
                @if ($errorCount > $limit)
                    <div class="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing latest {{ $limit }} of {{ $errorCount }}</div>
                @endif
            </x-ui.card>

            <x-ui.card class="overflow-hidden">
                <div class="bg-emerald-600 px-4 py-2.5 flex items-center justify-between">
                    <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-check class="w-4 h-4" /> Success Logs</h3>
                    <span class="text-xs font-semibold text-white/90">{{ $successCount }}</span>
                </div>
                <div class="divide-y divide-border" data-log-list="success">
                    @forelse ($successLogs as $log)
                        <div class="px-4 py-3" data-log-id="{{ $log->id }}">
                            <div class="flex items-center justify-between gap-2">
                                <div class="min-w-0 font-medium text-foreground text-sm truncate">{{ $log->title }}</div>
                                <div class="text-xs text-muted-foreground whitespace-nowrap shrink-0">{{ $log->created_at->toDisplay() }}</div>
                            </div>
                            <div class="text-xs text-muted-foreground truncate">{{ $log->original_filename }}</div>
                            <a href="{{ route('videos.index') }}" class="text-xs font-medium text-emerald-700 hover:underline">View in list</a>
                        </div>
                    @empty
                        <div class="px-4 py-6 text-center text-sm text-muted-foreground">No success logs.</div>
                    @endforelse
                </div>
                @if ($successCount > $limit)
                    <div class="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing latest {{ $limit }} of {{ $successCount }}</div>
                @endif
            </x-ui.card>
        </div>
    </div>
@endsection

@push('scripts')
    <script>
        (function () {
            const REFRESH_DEBOUNCE_MS = 500;
            const lastStateByVideo = new Map();
            let debounceTimer = null;
            let refreshInFlight = false;
            let refreshQueued = false;
            let disposed = false;

            function scheduleRefresh() {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(runRefresh, REFRESH_DEBOUNCE_MS);
            }

            async function runRefresh() {
                if (disposed) {
                    return;
                }

                if (refreshInFlight) {
                    refreshQueued = true;
                    return;
                }

                refreshInFlight = true;
                try {
                    await refreshLogs();
                } catch (err) {
                    // Best-effort; the next event, reconnect or tab focus will retry.
                } finally {
                    refreshInFlight = false;
                    if (refreshQueued && !disposed) {
                        refreshQueued = false;
                        runRefresh();
                    }
                }
            }

            const HIGHLIGHT_LISTS = ['success', 'error'];
            const HIGHLIGHT_FALLBACK_MS = 9000;

            function collectLogIds(root) {
                const ids = {};
                HIGHLIGHT_LISTS.forEach(function (name) {
                    const set = new Set();
                    root.querySelectorAll('[data-log-list="' + name + '"] [data-log-id]').forEach(function (el) {
                        set.add(el.dataset.logId);
                    });
                    ids[name] = set;
                });
                return ids;
            }

            // Only called from a refresh, so the initial page render is never highlighted.
            function highlightNewEntries(root, previousIds) {
                HIGHLIGHT_LISTS.forEach(function (name) {
                    root.querySelectorAll('[data-log-list="' + name + '"] [data-log-id]').forEach(function (el) {
                        if (previousIds[name].has(el.dataset.logId)) {
                            return;
                        }

                        const cls = name === 'error' ? ['log-entry-new', 'log-entry-new--error'] : ['log-entry-new'];
                        const clear = function () {
                            el.classList.remove.apply(el.classList, cls);
                        };
                        el.classList.add.apply(el.classList, cls);
                        // The entry's own animation (the fade) is the last one; ignore the pseudo-element sweep/bar.
                        el.addEventListener('animationend', function (e) {
                            if (e.target === el && !e.pseudoElement) {
                                clear();
                            }
                        });
                        setTimeout(clear, HIGHLIGHT_FALLBACK_MS);
                    });
                });
            }

            async function refreshLogs() {
                const response = await fetch(window.location.href, {
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html' },
                    credentials: 'same-origin',
                });

                if (!response.ok || response.redirected) {
                    return;
                }

                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                const incoming = doc.getElementById('logs-content');
                const current = document.getElementById('logs-content');

                if (disposed || !incoming || !current || incoming.innerHTML === current.innerHTML) {
                    return;
                }

                const scrollTops = {};
                current.querySelectorAll('[data-log-list]').forEach(function (list) {
                    scrollTops[list.dataset.logList] = list.scrollTop;
                });

                const openDetails = new Set();
                current.querySelectorAll('details[data-log-detail][open]').forEach(function (el) {
                    openDetails.add(el.dataset.logDetail);
                });

                const previousIds = collectLogIds(current);

                current.innerHTML = incoming.innerHTML;

                highlightNewEntries(current, previousIds);
                applyProgress();

                current.querySelectorAll('details[data-log-detail]').forEach(function (el) {
                    if (openDetails.has(el.dataset.logDetail)) {
                        el.open = true;
                    }
                });

                current.querySelectorAll('[data-log-list]').forEach(function (list) {
                    if (scrollTops[list.dataset.logList] !== undefined) {
                        list.scrollTop = scrollTops[list.dataset.logList];
                    }
                });
            }

            const PROGRESS_INTERVAL_MS = 250;
            let progressTimer = null;
            let lastProgressAt = 0;

            let lastAnnounceKey = null;

            function setBar(bar, percent) {
                bar.style.width = percent + '%';
            }

            // "2 transcoding · 1 queued" for several videos; the single video's own stage for one. Rows beyond the server limit have no stage text.
            function stageSummary(card, active, total) {
                const counts = new Map();
                let counted = 0;

                active.forEach(function (item) {
                    let label = null;

                    if (item.kind === 'upload') {
                        label = total === 1 ? uploadLabel(item) : 'Uploading';
                    } else {
                        const row = card.querySelector('[data-video-id="' + item.id + '"]');
                        label = row ? row.getAttribute('data-stage-label').replace(/\.{3}$/, '') : null;
                    }

                    if (!label) {
                        return;
                    }

                    counted++;
                    counts.set(label, (counts.get(label) || 0) + 1);
                });

                if (total === 1) {
                    return counts.size ? counts.keys().next().value : '';
                }

                const parts = [];

                counts.forEach(function (count, label) {
                    parts.push(count + ' ' + label.charAt(0).toLowerCase() + label.slice(1));
                });

                if (total > counted) {
                    parts.push('+' + (total - counted) + ' more');
                }

                return parts.join(' \u00b7 ');
            }

            function uploadLabel(item) {
                return item.uploadPercent > 0 ? 'Uploading \u2014 ' + Math.round(item.uploadPercent) + '%' : 'Waiting to upload';
            }

            function createUploadRow(item) {
                const row = document.createElement('div');
                row.className = 'px-5 py-3';
                row.setAttribute('data-upload-queue-id', String(item.id));

                const title = document.createElement('div');
                title.className = 'min-w-0 font-medium text-slate-900 text-sm truncate';
                title.setAttribute('data-upload-title', '');

                const meta = document.createElement('div');
                meta.className = 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-1';
                const badge = document.createElement('span');
                badge.className = 'inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 ring-1 ring-blue-300';
                badge.textContent = 'Uploading';
                const label = document.createElement('span');
                label.className = 'text-xs text-slate-600';
                label.setAttribute('data-upload-label', '');
                meta.append(badge, label);

                const barWrap = document.createElement('div');
                barWrap.className = 'mt-2 flex items-center gap-2';
                const track = document.createElement('div');
                track.className = 'h-1 flex-1 overflow-hidden rounded-full bg-slate-200';
                const bar = document.createElement('div');
                bar.className = 'h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 motion-safe:transition-[width] motion-safe:duration-300';
                bar.setAttribute('data-upload-bar', '');
                track.appendChild(bar);
                const percent = document.createElement('span');
                percent.className = 'w-9 text-right text-xs font-medium text-slate-600 tabular-nums';
                percent.setAttribute('data-upload-percent', '');
                barWrap.append(track, percent);

                row.append(title, meta, barWrap);

                return row;
            }

            // Client-only uploads (no video record yet) are shown after the server rows, keyed by queue id.
            function syncUploadRows(card, uploads) {
                const list = card.querySelector('[data-log-list="processing"]');

                if (!list) {
                    return;
                }

                const wanted = new Set(uploads.map(function (item) {
                    return String(item.id);
                }));

                list.querySelectorAll('[data-upload-queue-id]').forEach(function (row) {
                    if (!wanted.has(row.getAttribute('data-upload-queue-id'))) {
                        row.remove();
                    }
                });

                uploads.forEach(function (item) {
                    const id = String(item.id);
                    let row = null;

                    list.querySelectorAll('[data-upload-queue-id]').forEach(function (candidate) {
                        if (candidate.getAttribute('data-upload-queue-id') === id) {
                            row = candidate;
                        }
                    });

                    if (!row) {
                        row = createUploadRow(item);
                        row.setAttribute('data-upload-queue-id', id);
                        list.appendChild(row);
                    }

                    const rowPercent = Math.round(item.progress);
                    row.querySelector('[data-upload-title]').textContent = item.title || '';
                    row.querySelector('[data-upload-label]').textContent = uploadLabel(item);
                    row.querySelector('[data-upload-percent]').textContent = rowPercent + '%';
                    setBar(row.querySelector('[data-upload-bar]'), rowPercent);
                });
            }

            // Mirrors the floating ring: ring, overall bar, summary line and rows are updated in place from window.__inProgressState.
            function applyProgress() {
                progressTimer = null;
                lastProgressAt = Date.now();

                const state = window.__inProgressState;
                const card = document.querySelector('[data-in-progress-card]');

                if (disposed || !state || !card) {
                    return;
                }

                if (state.total < 1) {
                    // Nothing in progress anywhere: hide the panel unless the server just rendered rows we have no state for yet.
                    if (!card.querySelector('[data-video-id]')) {
                        card.hidden = true;
                    }
                    syncUploadRows(card, []);
                    return;
                }

                card.hidden = false;

                const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
                const current = Math.min(state.total, Math.max(1, state.current));
                const active = state.active || [];

                card.querySelector('[data-overall-current]').textContent = current;
                card.querySelector('[data-overall-total]').textContent = state.total;
                card.querySelector('[data-live-ring-arc]').setAttribute('stroke-dashoffset', 100 - percent);
                card.querySelector('[data-live-ring]').setAttribute('aria-valuenow', percent);
                card.querySelector('[data-live-title]').textContent = 'Processing ' + state.total + ' video' + (state.total === 1 ? '' : 's');
                card.querySelector('[data-live-summary]').textContent = stageSummary(card, active, state.total);

                syncUploadRows(card, active.filter(function (item) {
                    return item.kind === 'upload';
                }));

                // Announce only when k/N or the 10% bucket changes, so screen readers are not flooded.
                const announceKey = current + '/' + state.total + '|' + Math.floor(percent / 10);

                if (announceKey !== lastAnnounceKey) {
                    lastAnnounceKey = announceKey;
                    card.querySelector('[data-live-announce]').textContent = 'Processing video ' + current + ' of ' + state.total + ', ' + percent + ' percent';
                }

                active.forEach(function (item) {
                    if (item.kind === 'upload') {
                        return;
                    }

                    const row = card.querySelector('[data-video-id="' + item.id + '"]');

                    if (!row) {
                        return;
                    }

                    // A queued row has not started: keep it empty even though the overall share of its finished upload is counted.
                    const rowPercent = row.hasAttribute('data-queued') ? 0 : Math.round(item.progress);
                    row.querySelector('[data-video-percent]').textContent = rowPercent + '%';
                    setBar(row.querySelector('[data-video-bar]'), rowPercent);
                });
            }

            function scheduleProgress() {
                if (progressTimer !== null || disposed) {
                    return;
                }

                progressTimer = setTimeout(function () {
                    window.requestAnimationFrame(applyProgress);
                }, Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastProgressAt)));
            }

            function handleStatusUpdated(e) {
                const key = String(e.videoId);
                // Status + stage only: progress ticks within a stage must not trigger a refresh.
                const state = e.status + '|' + (e.stage || '');
                const changed = !lastStateByVideo.has(key) || lastStateByVideo.get(key) !== state;
                lastStateByVideo.set(key, state);

                if (changed) {
                    scheduleRefresh();
                }
            }

            function handleConnectionStateChange(states) {
                if (states.current === 'connected' && states.previous !== 'connected') {
                    scheduleRefresh();
                }
            }

            function handleVisibilityChange() {
                if (document.visibilityState === 'visible') {
                    scheduleRefresh();
                }
            }

            function initializeLiveUpdates() {
                if (disposed || !window.Echo) {
                    return;
                }

                window.Echo.channel('videos').listen('.video.status-updated', handleStatusUpdated);

                if (window.Echo.connector && window.Echo.connector.pusher) {
                    window.Echo.connector.pusher.connection.bind('state_change', handleConnectionStateChange);
                }
            }

            document.addEventListener('visibilitychange', handleVisibilityChange);
            window.addEventListener('in-progress:update', scheduleProgress);
            applyProgress();

            if (window.Echo) {
                initializeLiveUpdates();
            } else {
                document.addEventListener('DOMContentLoaded', initializeLiveUpdates);
            }

            window.__pageCleanup = function () {
                disposed = true;
                clearTimeout(debounceTimer);
                clearTimeout(progressTimer);
                window.removeEventListener('in-progress:update', scheduleProgress);
                document.removeEventListener('DOMContentLoaded', initializeLiveUpdates);
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                if (window.Echo) {
                    window.Echo.channel('videos').stopListening('.video.status-updated', handleStatusUpdated);
                    if (window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.unbind('state_change', handleConnectionStateChange);
                    }
                }
            };
        })();
    </script>
@endpush
