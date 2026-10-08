@extends('layouts.app')

@section('title', 'Upload Video - HLS R2 Studio')
@section('page-title', 'Upload Video')
@section('breadcrumb', 'Home / Upload Video')

@section('content')
    <form id="upload-form" class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start"
          data-max-size-mb="{{ config('videos.max_upload_size_mb') }}"
          data-chunk-size-mb="{{ config('videos.chunk_size_mb') }}">
        <x-ui.card class="overflow-hidden min-w-0">
            <x-ui.card-header class="border-b border-border">
                <x-ui.card-title class="inline-flex items-center gap-2"><x-lucide-cloud-upload class="w-4 h-4" /> Upload videos</x-ui.card-title>
                <p class="text-sm text-muted-foreground">Formats: mp4, mov, mkv, avi, webm. Maximum size {{ config('videos.max_upload_size_mb') }} MB.</p>
            </x-ui.card-header>

            <div class="p-4 sm:p-6 space-y-5">
                <div>
                    <x-ui.label for="video" class="block mb-2">Video File</x-ui.label>
                    <input type="file" name="video" id="video" accept=".mp4,.mov,.mkv,.avi,.webm" multiple required class="hidden">
                    <div id="dropzone"
                         class="rounded-lg border-2 border-dashed border-input px-4 sm:px-6 py-8 sm:py-10 text-center cursor-pointer hover:border-foreground/40 hover:bg-muted/40">
                        <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                            <x-lucide-cloud-upload class="w-8 h-8 text-foreground" />
                        </div>
                        <p id="dropzone-instruction" class="text-sm text-muted-foreground mb-3">Drag and drop video here, or</p>
                        <x-ui.button type="button">
                            <x-lucide-upload class="w-4 h-4" /> Choose video file
                        </x-ui.button>
                    </div>
                    <div id="selected-files-list" class="mt-2 space-y-1 hidden"></div>
                </div>

                <div id="title-field-wrapper">
                    <x-ui.label for="title" class="block mb-2">Title (optional)</x-ui.label>
                    <x-ui.input type="text" name="title" id="title" value="{{ old('title') }}" />
                    <p id="title-multi-note" class="mt-1 text-xs text-muted-foreground hidden">Title is automatically taken from the filename when uploading multiple videos.</p>
                </div>

                <x-ui.alert variant="destructive" id="upload-error" class="hidden"></x-ui.alert>

                <x-ui.alert variant="warning" id="upload-warning" class="hidden">
                    <x-lucide-triangle-alert class="w-4 h-4 shrink-0" />
                    Please do not reload or close this tab while the upload is in progress.
                </x-ui.alert>
            </div>

            <div class="flex flex-col gap-3 border-t border-border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <p id="selection-summary" class="text-sm text-muted-foreground">No files selected</p>
                <x-ui.button type="submit" id="upload-submit" class="w-full sm:w-auto">
                    <x-lucide-upload class="w-4 h-4" /> Start upload
                </x-ui.button>
            </div>
        </x-ui.card>

        <div class="space-y-4 min-w-0">
            <x-ui.card id="upload-progress-card" class="overflow-hidden">
                <div class="bg-muted border-b border-border px-4 py-3 flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <h3 class="text-sm font-semibold text-foreground inline-flex items-center gap-2"><x-lucide-activity class="w-4 h-4" /> Processing Queue <x-ui.badge variant="secondary" id="upload-queue-count">0</x-ui.badge></h3>
                        <p class="mt-1 text-xs text-muted-foreground">Upload and processing status of each file</p>
                    </div>
                    <x-ui.button variant="outline" size="sm" id="clear-queue-btn" class="shrink-0">
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear queue
                    </x-ui.button>
                </div>
                <div class="p-4">
                    <div id="upload-queue" class="space-y-3"></div>
                    <p id="upload-queue-empty" class="text-sm text-muted-foreground text-center py-6">No files in queue. Select videos to start uploading.</p>
                </div>
            </x-ui.card>

            <x-ui.card class="overflow-hidden">
                <div class="bg-muted border-b border-border px-4 py-2 flex items-center justify-between gap-2">
                    <h3 class="min-w-0 text-sm font-semibold text-foreground inline-flex items-center gap-2"><x-lucide-scroll-text class="w-4 h-4" /> Activity Log</h3>
                    <div class="flex items-center gap-2 shrink-0">
                        <x-ui.button variant="outline" size="sm" id="copy-log-btn" type="button" class="shrink-0" title="Copy the visible log lines to the clipboard">
                            <x-lucide-copy class="w-3.5 h-3.5" data-copy-icon="copy" />
                            <x-lucide-check class="w-3.5 h-3.5 hidden" data-copy-icon="check" />
                            <span data-copy-label>Copy log</span>
                        </x-ui.button>
                        <span id="copy-log-status" class="sr-only" role="status" aria-live="polite"></span>
                        <x-ui.button variant="outline" size="sm" id="clear-log-btn" class="shrink-0" title="Hides these lines in this browser only. Stored logs are not deleted.">
                            <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear log
                        </x-ui.button>
                    </div>
                </div>
                <div class="p-4">
                    <div id="upload-log" class="font-mono text-xs text-muted-foreground space-y-1 max-h-72 overflow-y-auto break-words">
                        <p class="text-muted-foreground" data-log-placeholder>Ready.</p>
                    </div>
                </div>
                <div id="upload-log-note" class="border-t border-border px-4 py-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <x-lucide-info class="w-3.5 h-3.5 shrink-0 mt-px" />
                    <p>Clear log only hides these lines in this browser. Stored logs are not deleted.</p>
                </div>
            </x-ui.card>

            <div id="upload-summary" class="hidden">
                <x-ui.button href="{{ route('videos.index') }}">
                    View video list
                </x-ui.button>
            </div>
        </div>
    </form>

    @push('scripts')
        <script>
            (function () {
                const form = document.getElementById('upload-form');
                const fileInput = document.getElementById('video');
                const titleInput = document.getElementById('title');
                const titleFieldWrapper = document.getElementById('title-field-wrapper');
                const titleMultiNote = document.getElementById('title-multi-note');
                const submitButton = document.getElementById('upload-submit');
                const dropzone = document.getElementById('dropzone');
                const queueList = document.getElementById('upload-queue');
                const queueEmptyPlaceholder = document.getElementById('upload-queue-empty');
                const clearQueueBtn = document.getElementById('clear-queue-btn');
                const selectedFilesList = document.getElementById('selected-files-list');
                const errorBox = document.getElementById('upload-error');
                const summaryBox = document.getElementById('upload-summary');
                const logBox = document.getElementById('upload-log');
                const selectionSummary = document.getElementById('selection-summary');
                const queueCountBadge = document.getElementById('upload-queue-count');

                const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
                const allowedExtensions = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
                const maxSizeBytes = parseInt(form.dataset.maxSizeMb, 10) * 1024 * 1024;
                const CHUNK_SIZE = parseInt(form.dataset.chunkSizeMb, 10) * 1024 * 1024;
                const FILE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/></svg>';
                const TRASH_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

                let currentQueueItems = [];
                const uploadedVideos = {};
                const historyLoadedForVideoIds = new Set();
                let replayPromise = Promise.resolve();
                let replayDone = false;
                let replayRetried = false;
                const WAITING_LABEL = 'Waiting';
                const LEGACY_WAITING_LABEL = 'Pending';
                function isWaitingLabel(text) {
                    return text === WAITING_LABEL || text === LEGACY_WAITING_LABEL;
                }
                let batchPending = [];

                window.__uploadQueueRegistry = window.__uploadQueueRegistry || {};

                // Shared FIFO of files waiting to be uploaded ({queueId, file, title}) and the single runner that drains it
                // ({active, lastBeat, stats}). Both live on window so they survive soft navigation.
                const RUNNER_STALE_MS = 5 * 60 * 1000;
                const RUNNER_HEARTBEAT_MS = 30 * 1000;
                window.__uploadQueue = window.__uploadQueue || [];
                window.__uploadRunner = window.__uploadRunner || null;

                // A runner that has not beaten for RUNNER_STALE_MS is treated as dead and may be replaced.
                function isUploadRunnerActive() {
                    const runner = window.__uploadRunner;
                    return !!runner && runner.active === true && (Date.now() - runner.lastBeat) <= RUNNER_STALE_MS;
                }

                function beatUploadRunner() {
                    const runner = window.__uploadRunner;
                    if (runner) {
                        runner.lastBeat = Date.now();
                    }
                }

                // Looked up live: the runner may belong to an older script instance whose DOM references are gone.
                function syncUploadWarning() {
                    const warning = document.getElementById('upload-warning');
                    if (warning) {
                        warning.classList.toggle('hidden', window.__uploadInProgress !== true);
                    }
                }

                function showUploadSummaryBox() {
                    const box = document.getElementById('upload-summary');
                    if (box) {
                        box.classList.remove('hidden');
                    }
                }

                // Drops waiting files (Clear queue) so they are never uploaded.
                function removeFromUploadQueue(queueIds) {
                    if (queueIds.length === 0) {
                        return;
                    }
                    const queue = window.__uploadQueue;
                    let removed = 0;
                    for (let i = queue.length - 1; i >= 0; i--) {
                        if (queueIds.indexOf(queue[i].queueId) !== -1) {
                            queue.splice(i, 1);
                            removed++;
                        }
                    }
                    const runner = window.__uploadRunner;
                    if (removed > 0 && runner) {
                        runner.stats.total = Math.max(0, runner.stats.total - removed);
                        touchActiveUpload(window.__uploadActive, {});
                    }
                }

                // Tells the global progress ring that the registry changed (it re-reads the registry on each render).
                // Frequent progress ticks pass `throttle` so they fire at most ~4 times per second.
                let registryNotifyTimer = null;
                let registryLastNotifyAt = 0;
                function notifyUploadRegistry(throttle) {
                    const wait = throttle ? Math.max(0, 250 - (Date.now() - registryLastNotifyAt)) : 0;
                    if (registryNotifyTimer !== null) {
                        if (wait > 0) {
                            return;
                        }
                        clearTimeout(registryNotifyTimer);
                        registryNotifyTimer = null;
                    }
                    const fire = function () {
                        registryNotifyTimer = null;
                        registryLastNotifyAt = Date.now();
                        window.dispatchEvent(new CustomEvent('upload-registry:update'));
                    };
                    if (wait > 0) {
                        registryNotifyTimer = setTimeout(fire, wait);
                    } else {
                        fire();
                    }
                }

                function generateQueueId() {
                    return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                }

                const ACTIVITY_LOG_STORE_URL = @json(route('activity-log.store', [], false));
                const ACTIVITY_LOG_INDEX_URL = @json(route('activity-log.index', [], false));
                const OUTBOX_KEY = 'hls_activity_outbox';
                const OUTBOX_MAX = 1000;
                const OUTBOX_BATCH = 50;
                const REPLAY_CID_MAX = 100;
                const OUTBOX_DEBOUNCE_MS = 500;
                const CLEARED_AT_KEY = 'hls_activity_cleared_at';

                // Shared across script instances (soft navigation) so entries are never sent twice:
                // a batch is moved from `items` to `inflight` BEFORE the request and put back on failure.
                if (!window.__activityOutbox) {
                    let stored = [];
                    try {
                        const raw = sessionStorage.getItem(OUTBOX_KEY);
                        const parsed = raw ? JSON.parse(raw) : [];
                        if (Array.isArray(parsed)) {
                            stored = parsed.filter(function (entry) {
                                return entry && typeof entry.message === 'string';
                            }).slice(-OUTBOX_MAX);
                        }
                    } catch (e) {
                        // sessionStorage unavailable — the outbox simply starts empty
                    }
                    window.__activityOutbox = { items: stored, inflight: [], timer: null, flushing: null };
                }
                const outbox = window.__activityOutbox;

                function persistOutbox() {
                    try {
                        const all = outbox.inflight.concat(outbox.items);
                        if (all.length === 0) {
                            sessionStorage.removeItem(OUTBOX_KEY);
                        } else {
                            sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(all));
                        }
                    } catch (e) {
                        // best-effort only
                    }
                }

                function scheduleOutboxFlush() {
                    clearTimeout(outbox.timer);
                    outbox.timer = setTimeout(function () {
                        outbox.timer = null;
                        flushOutbox();
                    }, OUTBOX_DEBOUNCE_MS);
                }

                // Stable per-line id, generated when the line is created and sent with every delivery attempt so the
                // server can ignore an entry it already stored (retries, a reload while a request was in flight, ...).
                function makeCid() {
                    try {
                        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                            return crypto.randomUUID();
                        }
                    } catch (e) {
                        // randomUUID needs a secure context; fall through
                    }
                    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
                }

                // Lines are persisted in creation order: insert by ts (after any entry with an equal or older ts).
                function enqueueOutbox(entry) {
                    const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
                    let index = outbox.items.length;
                    while (index > 0 && Number.isFinite(outbox.items[index - 1].ts) && outbox.items[index - 1].ts > ts) {
                        index--;
                    }
                    outbox.items.splice(index, 0, entry);
                    if (outbox.items.length > OUTBOX_MAX) {
                        outbox.items = outbox.items.slice(-OUTBOX_MAX);
                    }
                    persistOutbox();
                    scheduleOutboxFlush();
                }

                function flushOutbox() {
                    if (outbox.flushing) {
                        return outbox.flushing;
                    }
                    if (outbox.items.length === 0) {
                        return Promise.resolve();
                    }
                    outbox.flushing = (async function () {
                        try {
                            while (outbox.items.length > 0) {
                                if (navigator.onLine === false) {
                                    break;
                                }
                                const batch = outbox.items.splice(0, OUTBOX_BATCH);
                                // Stable sort so row ids (same-second created_at ties) follow creation order.
                                batch.sort(function (a, b) {
                                    return (Number.isFinite(a.ts) ? a.ts : 0) - (Number.isFinite(b.ts) ? b.ts : 0);
                                });
                                outbox.inflight = batch;
                                persistOutbox();

                                let settled = false;
                                try {
                                    const meta = document.querySelector('meta[name="csrf-token"]');
                                    const response = await fetch(ACTIVITY_LOG_STORE_URL, {
                                        method: 'POST',
                                        keepalive: true,
                                        credentials: 'same-origin',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Accept': 'application/json',
                                            'X-CSRF-TOKEN': meta ? meta.getAttribute('content') : csrfToken,
                                        },
                                        body: JSON.stringify({ entries: batch }),
                                    });
                                    // Dropped only on success or a validation-type 4xx (retrying cannot help).
                                    // Network errors, 5xx, 429, 401, 419 and any other status keep the batch for a later retry.
                                    settled = response.ok || [400, 404, 413, 422].indexOf(response.status) !== -1;
                                } catch (e) {
                                    settled = false;
                                }

                                outbox.inflight = [];
                                if (!settled) {
                                    outbox.items = batch.concat(outbox.items).sort(function (a, b) {
                                        return (Number.isFinite(a.ts) ? a.ts : 0) - (Number.isFinite(b.ts) ? b.ts : 0);
                                    }).slice(-OUTBOX_MAX);
                                    persistOutbox();
                                    break;
                                }
                                persistOutbox();
                            }
                        } catch (e) {
                            // never surface outbox problems to the UI
                        } finally {
                            outbox.flushing = null;
                        }
                    })();
                    return outbox.flushing;
                }

                function getClearedAt() {
                    try {
                        const value = parseInt(localStorage.getItem(CLEARED_AT_KEY), 10);
                        return Number.isFinite(value) ? value : 0;
                    } catch (e) {
                        return 0;
                    }
                }

                function setClearedAt(value) {
                    try {
                        localStorage.setItem(CLEARED_AT_KEY, String(value));
                    } catch (e) {
                        // best-effort only
                    }
                }

                const transcodeStageLabels = {
                    queued: 'Queued',
                    merging: 'Merging chunks',
                    transcoding: 'Transcoding',
                    generating_thumbnail: 'Generating thumbnail',
                    generating_storyboard: 'Generating storyboard',
                    uploading_r2: 'Uploading to R2',
                };

                // Stage -> bar fill classes (full literals for Tailwind). Keep in sync with $stageBarClasses in logs/index.blade.php.
                const BAR_BASE = 'h-1 rounded-full transition-[width] duration-300 ease-linear';
                const STAGE_BAR_CLASSES = {
                    upload: 'bg-gradient-to-r from-sky-400 to-blue-500',
                    merging: 'bg-gradient-to-r from-blue-400 to-indigo-500',
                    transcoding: 'bg-gradient-to-r from-violet-400 to-purple-500',
                    generating_thumbnail: 'bg-gradient-to-r from-fuchsia-400 to-pink-500',
                    generating_storyboard: 'bg-gradient-to-r from-amber-400 to-orange-500',
                    uploading_r2: 'bg-gradient-to-r from-lime-400 to-green-500',
                };

                // Activity Log "stage complete" line colours: same hue per stage as STAGE_BAR_CLASSES above (full literals for Tailwind).
                const STAGE_LOG_CLASSES = {
                    upload: 'text-sky-600 font-medium',
                    merging: 'text-indigo-600 font-medium',
                    transcoding: 'text-violet-600 font-medium',
                    generating_thumbnail: 'text-fuchsia-600 font-medium',
                    generating_storyboard: 'text-orange-600 font-medium',
                    uploading_r2: 'text-green-600 font-medium',
                };

                // Bar of a handed-off video: a queued video shows the upload colour, a merging one its own.
                function setTranscodeBarStage(bar, status, stage) {
                    if (!bar) {
                        return;
                    }
                    const key = isMergingPending(status, stage) ? 'merging' : (status === 'pending' ? 'upload' : (stage || 'transcoding'));
                    bar.className = (STAGE_BAR_CLASSES[key] || STAGE_BAR_CLASSES.transcoding) + ' ' + BAR_BASE;
                }

                // The single bar per video shows OVERALL progress (like the server's video.progress): the client upload fills
                // only the upload share of it. Mirror of uploadWeight() in resources/js/video-progress.js; stages come from the
                // global ring's data-progress-stages (config('videos.progress.stages')).
                function uploadShare(sizeBytes) {
                    const names = ['upload', 'merging', 'transcoding', 'generating_thumbnail', 'generating_storyboard', 'uploading_r2'];
                    let stages = {};

                    try {
                        const ring = document.querySelector('[data-in-progress-ring]');
                        stages = ring ? JSON.parse(ring.dataset.progressStages || '{}') || {} : {};
                    } catch (err) {
                        stages = {};
                    }

                    const sizeMb = Math.max(0, Number(sizeBytes) || 0) / 1048576;
                    const costs = names.map(function (name) {
                        const cost = stages[name] || {};

                        return Math.max(0, (Number(cost.fixed) || 0) + (Number(cost.per_mb) || 0) * sizeMb);
                    });
                    const total = costs.reduce(function (sum, cost) {
                        return sum + cost;
                    }, 0);

                    return total > 0 ? costs[0] / total * 100 : 100 / names.length;
                }

                // Floored like VideoProgress::overall(), so a finished upload equals the server's first (queued) value.
                function setUploadBarPercent(bar, uploadPercent) {
                    if (bar) {
                        const share = Number(bar.dataset.share) || 100;
                        bar.style.width = Math.min(99, Math.floor(share * Math.max(0, Math.min(100, uploadPercent || 0)) / 100)) + '%';
                    }
                }

                function formatStageStatus(stage, progress) {
                    const stageLabel = transcodeStageLabels[stage] || stage;
                    return stageLabel + ' — ' + progress + '%';
                }

                // A merging video is still status 'pending' on the server (it has not reached the transcode job yet),
                // so the stage decides whether it is really waiting in the queue or merging chunks right now.
                function isMergingPending(status, stage) {
                    return status === 'pending' && stage === 'merging';
                }

                // Single source of truth for the queue-row text of a video that has been handed off to the server.
                function transcodeStatusText(status, stage, progress) {
                    if (isMergingPending(status, stage)) {
                        return formatStageStatus('merging', progress || 0);
                    }
                    if (status === 'pending') {
                        return 'Queued for processing...';
                    }
                    return formatStageStatus(stage || 'transcoding', progress || 0);
                }

                // Last server-origin status line printed per video id. The same status can reach the log through
                // the realtime event and through the stored history (/status-log); an identical line directly after
                // the previous one for the same video is dropped. Keyed by video id, compared by message text only.
                const lastStatusLineByVideo = {};

                // force=true (DB replay) always prints and only records the line, so stored rows are never dropped.
                function appendStatusLine(videoId, message, className, time, timestamp, force) {
                    const key = String(videoId);
                    if (!force && lastStatusLineByVideo[key] === message) {
                        return;
                    }
                    lastStatusLineByVideo[key] = message;
                    appendLog(message, className, time, timestamp);
                }

                // Server-side stages in the order they run, and the wording of the line printed when each one is done.
                const LOG_STAGE_ORDER = ['merging', 'transcoding', 'generating_thumbnail', 'generating_storyboard', 'uploading_r2'];
                const STAGE_DONE_TEXT = {
                    merging: 'Merging chunks complete.',
                    transcoding: 'Transcoding complete.',
                    generating_thumbnail: 'Thumbnail complete.',
                    generating_storyboard: 'Storyboard complete.',
                    uploading_r2: 'Upload to R2 complete.',
                };

                // Furthest stage reached per video id. A "<stage> complete." line is printed once, when the video moves past
                // that stage; a rank that is not higher than the stored one (late or replayed row) prints nothing, so realtime
                // events, history catch-up and DB replay can overlap without duplicates. Replay resets it before a forced run.
                const lastStageByVideo = {};

                // Single source of truth for server-origin log lines (already stored by the server, so the
                // client never posts them back). Used by realtime events, history catch-up and DB replay.
                // Returns a list of { message, className }: in-progress ticks are not logged, only finished stages.
                function buildStatusMessages(videoId, title, status, stage, progress) {
                    const key = String(videoId);
                    const prev = lastStageByVideo[key] || null;
                    const lines = [];
                    let current = null;

                    if (isMergingPending(status, stage)) {
                        current = 'merging';
                    } else if (status === 'processing') {
                        current = stage || 'transcoding';
                    }

                    if (current && LOG_STAGE_ORDER.indexOf(current) > LOG_STAGE_ORDER.indexOf(prev)) {
                        if (prev) {
                            lines.push({ message: title + ': ' + STAGE_DONE_TEXT[prev], className: STAGE_LOG_CLASSES[prev] });
                        }
                        lastStageByVideo[key] = current;
                    }
                    if (status === 'pending' && !current) {
                        lines.push({ message: title + ' is queued for processing.', className: null });
                    }
                    if (status === 'ready') {
                        // The final line doubles as the end of the last stage; an earlier unclosed stage is closed first.
                        if (prev && prev !== 'uploading_r2') {
                            lines.push({ message: title + ': ' + STAGE_DONE_TEXT[prev], className: STAGE_LOG_CLASSES[prev] });
                        }
                        lines.push({ message: title + ': Transcoded, uploaded to R2 and ready to use.', className: STAGE_LOG_CLASSES.uploading_r2 });
                        delete lastStageByVideo[key];
                    }
                    if (status === 'failed') {
                        lines.push({ message: title + ' failed to process.', className: null });
                        delete lastStageByVideo[key];
                    }

                    return lines;
                }

                // Derived only from message + level so a replayed client line looks exactly like the realtime one.
                function clientLineClass(message, level) {
                    if (level === 'error') {
                        return 'text-destructive font-medium';
                    }
                    if (/ uploaded successfully\. \(\d+\/\d+\)$/.test(message)) {
                        return STAGE_LOG_CLASSES.upload;
                    }
                    if (/^Upload finished: \d+\/\d+ file\(s\) uploaded\./.test(message)) {
                        return 'text-foreground font-medium';
                    }
                    return null;
                }

                function enqueueClientLine(line, uploadId, videoId) {
                    enqueueOutbox({
                        upload_id: uploadId || null,
                        video_id: videoId || null,
                        level: line.level,
                        message: String(line.message).slice(0, 500),
                        ts: line.ts,
                        cid: line.cid,
                        ...(line.kind ? { kind: line.kind } : {}),
                    });
                }

                // Client-origin line: shown now AND persisted through the outbox. Pass `deferTo` (an array) to
                // show the line but hold it until the upload id is known (see releaseDeferred()).
                function logClient(message, opts) {
                    opts = opts || {};
                    const level = opts.level === 'error' ? 'error' : 'info';
                    const ts = Number.isFinite(opts.ts) ? opts.ts : Date.now();
                    if (!opts.silent) {
                        appendLog(message, clientLineClass(message, level), undefined, ts);
                    }

                    const line = { message: message, level: level, ts: ts, kind: opts.kind, cid: makeCid() };
                    if (Array.isArray(opts.deferTo)) {
                        opts.deferTo.push(line);
                        return;
                    }
                    enqueueClientLine(line, opts.uploadId, opts.videoId);
                }

                function releaseDeferred(lines, uploadId, videoId) {
                    lines.splice(0).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (line) {
                        enqueueClientLine(line, uploadId, videoId);
                    });
                }

                function resolveItemIds(item) {
                    const reg = item && item.queueId ? window.__uploadQueueRegistry[item.queueId] : null;
                    return {
                        uploadId: (item && item.uploadId) || (reg && reg.uploadId) || null,
                        videoId: (item && item.videoId) || (reg && reg.videoId) || null,
                    };
                }

                function logItem(item, message, level) {
                    const ids = resolveItemIds(item);
                    logClient(message, { level: level, uploadId: ids.uploadId, videoId: ids.videoId });
                }

                // Registered once globally so it keeps protecting an in-flight upload
                // across soft navigation, without stacking duplicates on re-entry.
                if (!window.__uploadBeforeUnloadBound) {
                    window.__uploadBeforeUnloadBound = true;
                    window.addEventListener('beforeunload', function (e) {
                        if (window.__uploadInProgress) {
                            e.preventDefault();
                            e.returnValue = '';
                        }
                    });
                }

                // The file being uploaded right now (owned by the instance running the upload loop), mirrored in
                // sessionStorage so the next page load can record an interruption the pagehide request missed.
                const UPLOAD_ACTIVE_KEY = 'hls_upload_active';
                const UPLOAD_ID_PATTERN = /^[0-9a-f-]{36}$/;

                function writeActiveMarker(active) {
                    try {
                        sessionStorage.setItem(UPLOAD_ACTIVE_KEY, JSON.stringify({
                            name: active.name,
                            uploadId: active.uploadId,
                            remaining: active.remaining,
                            ts: active.ts,
                            reported: active.reported,
                        }));
                    } catch (e) {
                        // best-effort only
                    }
                }

                function clearActiveMarker() {
                    try {
                        sessionStorage.removeItem(UPLOAD_ACTIVE_KEY);
                    } catch (e) {
                        // best-effort only
                    }
                }

                function buildInterruptedMessage(name, remaining) {
                    return 'Upload interrupted: the page was reloaded or closed while uploading ' + name + '.'
                        + (remaining > 0 ? ' ' + remaining + ' more file(s) were not started.' : '')
                        + ' The upload did not finish and no video will be processed.';
                }

                // Lines still held back for an upload id (the first /uploads/init has not answered yet) would die with
                // the page: queue them now, with whatever ids are known (none -> misc rows), keeping their ts.
                function releaseActiveDeferred(active) {
                    if (typeof active.getDeferred !== 'function') {
                        return;
                    }
                    active.getDeferred().forEach(function (lines) {
                        if (Array.isArray(lines)) {
                            releaseDeferred(lines, active.uploadId, null);
                        }
                    });
                }

                function reportInterrupted(active) {
                    if (active.reported) {
                        return;
                    }
                    active.reported = true;
                    releaseActiveDeferred(active);
                    logClient(buildInterruptedMessage(active.name, active.remaining), {
                        level: 'error',
                        uploadId: active.uploadId,
                        kind: 'interrupted',
                    });
                    writeActiveMarker(active);
                    clearTimeout(outbox.timer);
                    outbox.timer = null;
                    flushOutbox();
                }

                function beginActiveUpload(item, getRemaining) {
                    const active = {
                        name: item.file.name,
                        uploadId: null,
                        queueId: item.queueId,
                        remaining: getRemaining(),
                        ts: Date.now(),
                        reported: false,
                        getRemaining: getRemaining,
                        reportInterrupted: function () {
                            reportInterrupted(active);
                        },
                    };
                    window.__uploadActive = active;
                    writeActiveMarker(active);
                    return active;
                }

                function touchActiveUpload(active, patch) {
                    if (!active || window.__uploadActive !== active) {
                        return;
                    }
                    Object.assign(active, patch);
                    active.remaining = active.getRemaining();
                    active.ts = Date.now();
                    writeActiveMarker(active);
                }

                function endActiveUpload(active) {
                    if (active && window.__uploadActive === active) {
                        window.__uploadActive = null;
                        clearActiveMarker();
                    }
                }

                // bfcache (persisted) page hides are not an interruption: the page can come back alive.
                function reportActiveInterrupted(event) {
                    try {
                        const active = window.__uploadActive;
                        if (event && event.persisted) {
                            return;
                        }
                        if (active && !active.reported && typeof active.reportInterrupted === 'function') {
                            active.reportInterrupted();
                        }
                    } catch (e) {
                        // never block the page from unloading
                    }
                }

                // Registered once globally (not removed by __pageCleanup) so it keeps covering an in-flight upload.
                if (!window.__uploadPageHideBound) {
                    window.__uploadPageHideBound = true;
                    window.addEventListener('pagehide', reportActiveInterrupted);
                }

                // Next page load: a leftover unreported marker means the pagehide request never went out.
                function recoverInterruptedUpload() {
                    try {
                        if (window.__uploadInProgress || window.__uploadActive) {
                            return; // soft-navigated back while an upload is still running
                        }
                        const raw = sessionStorage.getItem(UPLOAD_ACTIVE_KEY);
                        if (!raw) {
                            return;
                        }
                        let marker = null;
                        try {
                            marker = JSON.parse(raw);
                        } catch (e) {
                            marker = null;
                        }
                        if (marker && marker.reported !== true && typeof marker.name === 'string') {
                            logClient(buildInterruptedMessage(marker.name, Number(marker.remaining) || 0), {
                                level: 'error',
                                uploadId: typeof marker.uploadId === 'string' && UPLOAD_ID_PATTERN.test(marker.uploadId) ? marker.uploadId : null,
                                kind: 'interrupted',
                                ts: Number.isFinite(marker.ts) ? marker.ts : undefined,
                                silent: true, // the replay renders it from the DB/outbox; showing it here too would duplicate it
                            });
                        }
                        clearActiveMarker();
                    } catch (e) {
                        // best-effort only
                    }
                }

                function showError(message) {
                    errorBox.textContent = message;
                    errorBox.classList.remove('hidden');
                }

                function hideError() {
                    errorBox.classList.add('hidden');
                    errorBox.textContent = '';
                }

                function hideSummary() {
                    summaryBox.classList.add('hidden');
                }

                // Lines are kept in chronological order by data-ts (ms epoch), because history
                // fetches for several videos can finish in any order.
                function appendLog(message, extraClass, time, timestamp) {
                    const placeholder = logBox.querySelector('[data-log-placeholder]');
                    if (placeholder) {
                        placeholder.remove();
                    }
                    const ts = Number.isFinite(timestamp) ? timestamp : Date.now();
                    const line = document.createElement('p');
                    if (extraClass) {
                        line.className = extraClass;
                    }
                    line.dataset.ts = String(ts);
                    line.textContent = '[' + (time || new Date().toLocaleTimeString()) + '] ' + message;

                    const lines = logBox.querySelectorAll('p[data-ts]');
                    let anchor = null;
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (Number(lines[i].dataset.ts) <= ts) {
                            anchor = lines[i];
                            break;
                        }
                    }
                    if (anchor) {
                        anchor.after(line);
                    } else if (lines.length > 0) {
                        lines[0].before(line);
                    } else {
                        logBox.appendChild(line);
                    }
                    logBox.scrollTop = logBox.scrollHeight;
                }

                function formatSize(bytes) {
                    if (bytes >= 1024 * 1024 * 1024) {
                        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                    }
                    if (bytes >= 1024 * 1024) {
                        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
                    }
                    return (bytes / 1024).toFixed(2) + ' KB';
                }

                function sleep(ms) {
                    return new Promise((resolve) => setTimeout(resolve, ms));
                }

                const NETWORK_ERROR_MESSAGE = 'Network connection lost: the browser could not reach the server. Check your internet connection and upload the file again.';

                // fetch() rejections (no HTTP response): Chrome 'Failed to fetch', Firefox 'NetworkError when attempting to fetch resource.', Safari 'Load failed'.
                function isNetworkFailure(err) {
                    if (navigator.onLine === false) {
                        return true;
                    }
                    return err instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed/i.test(err.message || '');
                }

                // onRateLimitWait(secondsLeft) is called once a second while waiting out a long HTTP 429, then with 0.
                async function fetchWithRetry(url, options, maxRetries = 3, onRateLimitWait = null) {
                    let lastError;
                    let lastIsHttpError = false;
                    let lastWasRateLimited = false;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        let retryDelayMs = 1000;
                        let retryable = true;
                        lastWasRateLimited = false;
                        try {
                            const response = await fetch(url, options);
                            if (!response.ok) {
                                let message = `Request failed (HTTP ${response.status}).`;
                                if (response.status === 419) {
                                    message = 'Your session has expired. Please reload the page and sign in again.';
                                } else {
                                    try {
                                        const data = await response.json();
                                        if (data && data.message) {
                                            message = data.message;
                                        }
                                    } catch (e) {
                                        // ignore JSON parse error, keep default message
                                    }
                                }
                                // Only 5xx and 429 are transient; any other 4xx is final.
                                retryable = response.status >= 500 || response.status === 429;
                                if (response.status === 429) {
                                    lastWasRateLimited = true;
                                    const retryAfter = parseInt(response.headers.get('Retry-After'), 10);
                                    if (retryAfter > 0) {
                                        retryDelayMs = Math.min(retryAfter, 65) * 1000;
                                    }
                                }
                                lastError = new Error(message);
                                lastIsHttpError = true;
                                if (!retryable) {
                                    throw lastError;
                                }
                            } else {
                                return await response.json();
                            }
                        } catch (err) {
                            if (!retryable) {
                                throw err;
                            }
                            lastError = err;
                            lastIsHttpError = false;
                        }
                        if (attempt < maxRetries) {
                            if (lastWasRateLimited && retryDelayMs > 3000 && typeof onRateLimitWait === 'function') {
                                for (let left = Math.ceil(retryDelayMs / 1000); left > 0; left--) {
                                    onRateLimitWait(left);
                                    await sleep(1000);
                                }
                                onRateLimitWait(0);
                            } else {
                                await sleep(retryDelayMs);
                            }
                        }
                    }
                    if (!lastIsHttpError && isNetworkFailure(lastError)) {
                        const networkError = new Error(NETWORK_ERROR_MESSAGE);
                        networkError.isNetworkError = true;
                        throw networkError;
                    }
                    throw lastError;
                }

                async function loadVideoHistory(videoId) {
                    // Wait for the DB replay so ids it already rendered are never rendered twice.
                    await replayPromise;
                    if (historyLoadedForVideoIds.has(videoId)) {
                        return;
                    }
                    historyLoadedForVideoIds.add(videoId);

                    let logs;
                    try {
                        logs = await fetchWithRetry('/videos/' + videoId + '/status-log', {
                            headers: { 'Accept': 'application/json' },
                        }, 1);
                    } catch (err) {
                        return; // best-effort; live events will still keep the UI current going forward
                    }

                    if (!Array.isArray(logs) || logs.length === 0) {
                        return;
                    }

                    const entry = uploadedVideos[videoId];
                    if (!entry) {
                        return;
                    }

                    const clearedAt = getClearedAt();

                    logs.forEach(function (log) {
                        const createdAt = new Date(log.created_at);
                        // Built even for cleared rows so the stage tracking stays correct.
                        const built = buildStatusMessages(videoId, entry.title, log.status, log.stage, log.progress);
                        if (createdAt.getTime() <= clearedAt) {
                            return;
                        }
                        built.forEach(function (line) {
                            appendStatusLine(videoId, line.message, line.className, createdAt.toLocaleTimeString(), createdAt.getTime());
                        });
                    });

                    const lastLog = logs[logs.length - 1];
                    entry.status = lastLog.status;
                    entry.stage = lastLog.stage;
                    entry.progress = lastLog.progress;

                    if (lastLog.status === 'ready' || lastLog.status === 'failed') {
                        delete lastStatusLineByVideo[String(videoId)];
                        removeFinishedQueueRow(entry);
                    }
                }

                // Renders the persisted Activity Log (newest 10 groups + misc rows) in DB order, then seeds
                // uploadedVideos / historyLoadedForVideoIds so nothing is rendered twice afterwards.
                async function runReplay(isRetry) {
                    try {
                        await Promise.race([flushOutbox(), sleep(3000)]);
                    } catch (e) {
                        // ignore
                    }

                    // Ask the server which pending lines it already stored (it ignores a cid it has seen), so a line
                    // is never rendered both from the DB rows and from the leftover outbox.
                    const pendingLines = outbox.inflight.concat(outbox.items);
                    const pendingCids = pendingLines.map(function (line) { return line.cid; }).filter(Boolean).slice(-REPLAY_CID_MAX);

                    let data;
                    try {
                        data = await fetchWithRetry(ACTIVITY_LOG_INDEX_URL + (pendingCids.length > 0 ? '?cids=' + encodeURIComponent(pendingCids.join(',')) : ''), {
                            headers: { 'Accept': 'application/json' },
                            credentials: 'same-origin',
                        }, 1);
                    } catch (err) {
                        return; // keep "Ready."; retried once when the tab becomes visible again
                    }
                    if (!data || !Array.isArray(data.entries)) {
                        return;
                    }
                    replayDone = true;

                    if (isRetry && logBox.querySelector('p[data-ts]')) {
                        return; // realtime lines already rendered; avoid duplicating them
                    }

                    const clearedAt = getClearedAt();
                    const videosMap = data.videos || {};
                    const lastServerRow = {};

                    // Forced replay prints every stored end line once: start the stage tracking from scratch.
                    Object.keys(lastStageByVideo).forEach(function (k) { delete lastStageByVideo[k]; });

                    data.entries.forEach(function (row) {
                        const parsed = Date.parse(row.created_at);
                        const ts = Number.isFinite(parsed) ? parsed : Date.now();
                        const isServerRow = row.message === null || row.message === undefined;
                        const videoId = row.video_id ? Number(row.video_id) : null;

                        if (isServerRow && videoId) {
                            lastServerRow[videoId] = row;
                            historyLoadedForVideoIds.add(videoId);
                        }
                        // Server rows are built even when cleared so the stage tracking stays correct.
                        let built = [];
                        if (isServerRow) {
                            const info = videoId ? videosMap[videoId] : null;
                            const title = (info && info.title) || (videoId ? 'Video #' + videoId : 'Video');
                            built = buildStatusMessages(videoId || 0, title, row.status, row.stage, row.progress);
                        }
                        if (ts <= clearedAt) {
                            return;
                        }

                        const time = new Date(ts).toLocaleTimeString();
                        if (isServerRow) {
                            built.forEach(function (line) {
                                if (videoId) {
                                    appendStatusLine(videoId, line.message, line.className, time, ts, true);
                                } else {
                                    appendLog(line.message, line.className, time, ts);
                                }
                            });
                        } else {
                            appendLog(row.message, clientLineClass(row.message, row.level), time, ts);
                        }
                    });

                    Object.keys(videosMap).forEach(function (id) {
                        const last = lastServerRow[id];
                        const existing = uploadedVideos[id];
                        if (existing) {
                            if (last) {
                                existing.status = last.status;
                                existing.stage = last.stage;
                                existing.progress = last.progress;
                                if (last.status === 'ready' || last.status === 'failed') {
                                    removeFinishedQueueRow(existing);
                                }
                            }
                            return;
                        }
                        uploadedVideos[id] = {
                            title: videosMap[id].title,
                            item: null,
                            status: last ? last.status : videosMap[id].status,
                            stage: last ? last.stage : null,
                            progress: last ? last.progress : 0,
                            videoId: Number(id),
                        };
                    });

                    // Lines that could not be sent yet are not in the DB; show them (once) so the log stays complete.
                    const storedCids = new Set(Array.isArray(data.stored_cids) ? data.stored_cids : []);
                    if (storedCids.size > 0) {
                        outbox.items = outbox.items.filter(function (line) { return !(line.cid && storedCids.has(line.cid)); });
                        persistOutbox();
                    }
                    const renderedCids = new Set();
                    pendingLines.forEach(function (line) {
                        if (line.cid) {
                            if (storedCids.has(line.cid) || renderedCids.has(line.cid)) {
                                return;
                            }
                            renderedCids.add(line.cid);
                        }
                        if (line.ts > clearedAt) {
                            appendLog(line.message, clientLineClass(line.message, line.level), new Date(line.ts).toLocaleTimeString(), line.ts);
                        }
                    });
                }

                // Removes the queue card of a finished (ready/failed) video and drops its registry entry.
                // Idempotent: safe to call more than once for the same entry.
                function removeFinishedQueueRow(entry) {
                    const item = entry.item;
                    if (item) {
                        const liveRow = findLiveQueueRow(item.queueId);
                        const row = liveRow || item.row;
                        if (row) {
                            row.remove();
                        }
                        currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                        updateQueueEmptyState();
                    }
                    const registry = window.__uploadQueueRegistry;
                    Object.keys(registry).forEach(function (key) {
                        const reg = registry[key];
                        const sameQueueId = !!entry.queueId && reg.queueId === entry.queueId;
                        const sameVideo = entry.videoId !== null && entry.videoId !== undefined
                            && reg.videoId !== null && reg.videoId !== undefined
                            && Number(reg.videoId) === Number(entry.videoId);
                        if (sameQueueId || sameVideo) {
                            delete registry[key];
                        }
                    });
                    notifyUploadRegistry();
                }

                function updateTitleVisibility() {
                    const count = fileInput.files.length;
                    if (count > 1) {
                        titleFieldWrapper.classList.add('hidden');
                        titleInput.disabled = true;
                        titleMultiNote.classList.remove('hidden');
                    } else {
                        titleFieldWrapper.classList.remove('hidden');
                        titleInput.disabled = false;
                        titleMultiNote.classList.add('hidden');
                    }
                }

                function renderSelectedFilesList() {
                    const files = Array.from(fileInput.files);
                    selectedFilesList.innerHTML = '';

                    updateSelectionSummary(files);

                    if (files.length === 0) {
                        selectedFilesList.classList.add('hidden');
                        return;
                    }

                    selectedFilesList.classList.remove('hidden');

                    files.forEach(function (file, index) {
                        const row = document.createElement('div');
                        row.className = 'flex items-center justify-between text-xs bg-muted rounded-lg px-3 py-2 border border-border';

                        const leftWrap = document.createElement('span');
                        leftWrap.className = 'flex items-center gap-2 min-w-0';

                        const iconEl = document.createElement('span');
                        iconEl.className = 'text-foreground shrink-0';
                        iconEl.innerHTML = FILE_ICON_SVG;

                        const nameEl = document.createElement('span');
                        nameEl.className = 'text-foreground truncate';
                        nameEl.textContent = file.name;

                        leftWrap.appendChild(iconEl);
                        leftWrap.appendChild(nameEl);

                        const sizeEl = document.createElement('span');
                        sizeEl.className = 'text-muted-foreground ml-2 shrink-0';
                        sizeEl.textContent = formatSize(file.size);

                        const removeBtn = document.createElement('button');
                        removeBtn.type = 'button';
                        removeBtn.className = 'text-muted-foreground hover:text-destructive shrink-0 ml-2 p-1';
                        removeBtn.innerHTML = TRASH_ICON_SVG;
                        removeBtn.setAttribute('aria-label', 'Remove ' + file.name);
                        removeBtn.addEventListener('click', function () {
                            removeSelectedFile(index);
                        });

                        row.appendChild(leftWrap);
                        row.appendChild(sizeEl);
                        row.appendChild(removeBtn);
                        selectedFilesList.appendChild(row);
                    });
                }

                function updateSelectionSummary(files) {
                    if (files.length === 0) {
                        selectionSummary.textContent = 'No files selected';
                        return;
                    }
                    const total = files.reduce(function (sum, file) { return sum + file.size; }, 0);
                    selectionSummary.textContent = files.length + (files.length === 1 ? ' file' : ' files') + ' \u00b7 ' + formatSize(total);
                }

                function removeSelectedFile(index) {
                    const dataTransfer = new DataTransfer();
                    Array.from(fileInput.files).forEach(function (file, i) {
                        if (i !== index) {
                            dataTransfer.items.add(file);
                        }
                    });
                    fileInput.files = dataTransfer.files;
                    updateTitleVisibility();
                    renderSelectedFilesList();
                }

                function hideSelectedFilesList() {
                    selectedFilesList.classList.add('hidden');
                    selectedFilesList.innerHTML = '';
                    updateSelectionSummary([]);
                }

                fileInput.addEventListener('change', function () {
                    updateTitleVisibility();
                    renderSelectedFilesList();
                });

                dropzone.addEventListener('click', function () {
                    fileInput.click();
                });

                const dropzoneInstruction = document.getElementById('dropzone-instruction');
                const DROPZONE_DEFAULT_TEXT = 'Drag and drop video here, or';
                const DROPZONE_DRAGGING_TEXT = 'Drop your video here';

                function setDropzoneDragging(isDragging) {
                    if (isDragging) {
                        dropzone.style.borderColor = '#60a5fa';
                        dropzone.style.backgroundColor = 'rgba(239, 246, 255, 0.4)';
                        dropzoneInstruction.textContent = DROPZONE_DRAGGING_TEXT;
                    } else {
                        dropzone.style.borderColor = '';
                        dropzone.style.backgroundColor = '';
                        dropzoneInstruction.textContent = DROPZONE_DEFAULT_TEXT;
                    }
                }

                function isPointerOverDropzone(e) {
                    const rect = dropzone.getBoundingClientRect();
                    return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
                }

                const handleWindowDragOver = function (e) {
                    e.preventDefault();
                    setDropzoneDragging(isPointerOverDropzone(e));
                };

                const handleWindowDragLeave = function (e) {
                    if (!e.relatedTarget) {
                        setDropzoneDragging(false);
                    }
                };

                const handleWindowDrop = function (e) {
                    // Still cancel the default action so the browser does not navigate to the dropped file.
                    e.preventDefault();

                    setDropzoneDragging(false);

                    if (!isPointerOverDropzone(e)) {
                        return;
                    }

                    const droppedFiles = e.dataTransfer.files;
                    if (!droppedFiles || droppedFiles.length === 0) {
                        return;
                    }

                    const dataTransfer = new DataTransfer();
                    Array.from(droppedFiles).forEach(function (file) {
                        dataTransfer.items.add(file);
                    });
                    fileInput.files = dataTransfer.files;

                    fileInput.dispatchEvent(new Event('change'));
                };

                window.addEventListener('dragover', handleWindowDragOver);
                window.addEventListener('dragleave', handleWindowDragLeave);
                window.addEventListener('drop', handleWindowDrop);

                clearQueueBtn.addEventListener('click', function () {
                    let clearedCount = 0;
                    const clearedQueueIds = [];
                    currentQueueItems.slice().forEach(function (item) {
                        const row = findLiveQueueRow(item.queueId) || item.row;
                        const isError = !!row && row.dataset.state === 'error';
                        if (!item.cleared && (isError || isWaitingLabel(item.statusEl.textContent))) {
                            item.cleared = true;
                            row.remove();
                            currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                            if (item.queueId) {
                                clearedQueueIds.push(item.queueId);
                                delete window.__uploadQueueRegistry[item.queueId];
                                notifyUploadRegistry();
                            }
                            if (!isError) {
                                clearedCount++;
                            }
                        }
                    });
                    removeFromUploadQueue(clearedQueueIds);
                    updateQueueEmptyState();
                    if (clearedCount > 0) {
                        logClient('Cleared pending file(s) from queue.');
                    }
                });

                const clearLogBtn = document.getElementById('clear-log-btn');

                clearLogBtn.addEventListener('click', function () {
                    setClearedAt(Date.now());
                    Object.keys(lastStatusLineByVideo).forEach(function (k) { delete lastStatusLineByVideo[k]; });
                    logBox.innerHTML = '<p class="text-muted-foreground" data-log-placeholder>Ready.</p>';
                });

                const copyLogBtn = document.getElementById('copy-log-btn');
                const copyLogStatus = document.getElementById('copy-log-status');
                let copyFeedbackTimerId = null;

                function getVisibleLogLines() {
                    return Array.from(logBox.querySelectorAll('p'))
                        .filter(function (p) { return !p.hasAttribute('data-log-placeholder'); })
                        .map(function (p) { return p.textContent; });
                }

                function copyViaTextarea(text) {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'fixed';
                    ta.style.top = '-1000px';
                    ta.style.left = '-1000px';
                    document.body.appendChild(ta);
                    try {
                        ta.select();
                        return document.execCommand('copy') === true;
                    } catch (e) {
                        return false;
                    } finally {
                        ta.remove();
                    }
                }

                function showCopyFeedback(message, ok, duration) {
                    const label = copyLogBtn.querySelector('[data-copy-label]');
                    const copyIcon = copyLogBtn.querySelector('[data-copy-icon="copy"]');
                    const checkIcon = copyLogBtn.querySelector('[data-copy-icon="check"]');
                    clearTimeout(copyFeedbackTimerId);
                    if (!copyLogBtn.style.minWidth) {
                        copyLogBtn.style.minWidth = copyLogBtn.offsetWidth + 'px';
                    }
                    label.textContent = message;
                    copyIcon.classList.toggle('hidden', ok);
                    checkIcon.classList.toggle('hidden', !ok);
                    copyLogStatus.textContent = message;
                    copyFeedbackTimerId = setTimeout(function () {
                        copyFeedbackTimerId = null;
                        label.textContent = 'Copy log';
                        copyIcon.classList.remove('hidden');
                        checkIcon.classList.add('hidden');
                        copyLogBtn.style.minWidth = '';
                        copyLogStatus.textContent = '';
                    }, duration);
                }

                async function handleCopyLogClick() {
                    try {
                        const lines = getVisibleLogLines();
                        if (lines.length === 0) {
                            showCopyFeedback('Nothing to copy', false, 1500);
                            return;
                        }
                        const text = lines.join('\n');
                        let copied = false;
                        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                            try {
                                await navigator.clipboard.writeText(text);
                                copied = true;
                            } catch (e) {
                                copied = false;
                            }
                        }
                        if (!copied) {
                            copied = copyViaTextarea(text);
                        }
                        if (copied) {
                            showCopyFeedback('Copied', true, 1500);
                        } else {
                            showCopyFeedback('Copy failed', false, 2000);
                        }
                    } catch (e) {
                        showCopyFeedback('Copy failed', false, 2000);
                    }
                }

                copyLogBtn.addEventListener('click', handleCopyLogClick);

                function updateQueueEmptyState() {
                    queueCountBadge.textContent = String(queueList.children.length);
                    if (queueList.children.length === 0) {
                        queueEmptyPlaceholder.classList.remove('hidden');
                    } else {
                        queueEmptyPlaceholder.classList.add('hidden');
                    }
                }

                function createTranscodeSection() {
                    const transcodeWrapper = document.createElement('div');
                    transcodeWrapper.className = 'hidden mt-2 pt-2 border-t border-border';

                    const transcodeLabel = document.createElement('p');
                    transcodeLabel.className = 'text-xs font-medium text-muted-foreground mb-1';
                    transcodeLabel.textContent = 'Processing';

                    const transcodeStatusEl = document.createElement('p');
                    transcodeStatusEl.className = 'mt-1 text-xs text-muted-foreground break-words';
                    transcodeStatusEl.dataset.role = 'transcode-status';

                    transcodeWrapper.dataset.role = 'transcode-wrapper';
                    transcodeWrapper.appendChild(transcodeLabel);
                    transcodeWrapper.appendChild(transcodeStatusEl);

                    return { wrapper: transcodeWrapper, statusEl: transcodeStatusEl };
                }

                function createQueueRow(name, size, queueId) {
                    const row = document.createElement('div');
                    row.className = 'rounded-lg border border-border p-3';
                    if (queueId) {
                        row.dataset.queueId = queueId;
                    }

                    const header = document.createElement('div');
                    header.className = 'flex items-center justify-between text-sm';

                    const nameEl = document.createElement('span');
                    nameEl.className = 'font-medium text-foreground truncate mr-2';
                    nameEl.textContent = name;

                    const sizeEl = document.createElement('span');
                    sizeEl.className = 'text-muted-foreground text-xs whitespace-nowrap';
                    sizeEl.textContent = formatSize(size);

                    header.appendChild(nameEl);
                    header.appendChild(sizeEl);

                    const uploadLabel = document.createElement('p');
                    uploadLabel.className = 'text-xs font-medium text-muted-foreground mb-1 mt-2';
                    uploadLabel.textContent = 'Uploading';

                    const barWrapper = document.createElement('div');
                    barWrapper.className = 'w-full bg-slate-200 rounded-full h-1 mt-2 overflow-hidden';

                    const bar = document.createElement('div');
                    bar.className = STAGE_BAR_CLASSES.upload + ' ' + BAR_BASE;
                    bar.style.width = '0%';
                    bar.dataset.role = 'upload-bar';
                    bar.dataset.share = uploadShare(size);
                    barWrapper.appendChild(bar);

                    const statusEl = document.createElement('p');
                    statusEl.className = 'mt-1 text-xs text-muted-foreground break-words';
                    statusEl.dataset.role = 'upload-status';
                    statusEl.textContent = WAITING_LABEL;

                    row.appendChild(header);
                    row.appendChild(uploadLabel);
                    row.appendChild(barWrapper);
                    row.appendChild(statusEl);

                    const transcodeSection = createTranscodeSection();
                    row.appendChild(transcodeSection.wrapper);

                    return {
                        row: row,
                        bar: bar,
                        statusEl: statusEl,
                        cleared: false,
                        transcodeWrapper: transcodeSection.wrapper,
                        transcodeStatusEl: transcodeSection.statusEl,
                        queueId: queueId || null,
                    };
                }

                function buildQueueUI(files) {
                    const items = files.map(function (file) {
                        const queueId = generateQueueId();
                        const item = createQueueRow(file.name, file.size, queueId);
                        item.file = file;
                        queueList.appendChild(item.row);

                        window.__uploadQueueRegistry[queueId] = {
                            queueId: queueId,
                            title: file.name,
                            size: file.size,
                            status: 'pending',
                            uploadPercent: 0,
                            statusText: WAITING_LABEL,
                            videoId: null,
                            stage: null,
                            progress: 0,
                        };

                        return item;
                    });

                    updateQueueEmptyState();
                    notifyUploadRegistry();

                    return items;
                }

                function findLiveQueueRow(queueId) {
                    return queueId ? document.querySelector('[data-queue-id="' + queueId + '"]') : null;
                }

                function setItemProgress(item, percent) {
                    const liveRow = findLiveQueueRow(item.queueId);
                    const bar = liveRow ? liveRow.querySelector('[data-role="upload-bar"]') : item.bar;
                    const statusEl = liveRow ? liveRow.querySelector('[data-role="upload-status"]') : item.statusEl;
                    const text = 'Uploading — ' + percent + '%';

                    setUploadBarPercent(bar, percent);
                    if (statusEl) {
                        statusEl.textContent = text;
                    }

                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        const entry = window.__uploadQueueRegistry[item.queueId];
                        entry.status = 'uploading';
                        entry.uploadPercent = percent;
                        entry.statusText = text;
                        notifyUploadRegistry(true);
                    }
                }

                function setItemStatus(item, text) {
                    const liveRow = findLiveQueueRow(item.queueId);
                    const statusEl = liveRow ? liveRow.querySelector('[data-role="upload-status"]') : item.statusEl;

                    if (statusEl) {
                        statusEl.textContent = text;
                    }

                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        window.__uploadQueueRegistry[item.queueId].statusText = text;
                        notifyUploadRegistry(true);
                    }
                }

                // Shows 'Server busy, retrying in Ns...' on the queue row while a long HTTP 429 wait runs and puts
                // the previous status text back afterwards.
                function rateLimitNotifier(item) {
                    let previousText = null;

                    return function (secondsLeft) {
                        if (secondsLeft > 0) {
                            if (previousText === null) {
                                const liveRow = findLiveQueueRow(item.queueId);
                                const statusEl = liveRow ? liveRow.querySelector('[data-role="upload-status"]') : item.statusEl;
                                previousText = statusEl ? statusEl.textContent : '';
                            }
                            setItemStatus(item, 'Server busy, retrying in ' + secondsLeft + 's...');
                        } else if (previousText !== null) {
                            setItemStatus(item, previousText);
                            previousText = null;
                        }
                    };
                }

                function dismissQueueRow(queueId) {
                    const row = findLiveQueueRow(queueId);
                    if (row) {
                        row.remove();
                    }
                    currentQueueItems = currentQueueItems.filter(function (qi) { return qi.queueId !== queueId; });
                    delete window.__uploadQueueRegistry[queueId];
                    notifyUploadRegistry();
                    updateQueueEmptyState();
                }

                // Turns a queue row into a failed-upload row: red status, no processing section, Dismiss button.
                function renderErrorRow(row, text) {
                    if (!row) {
                        return;
                    }
                    row.dataset.state = 'error';

                    const statusEl = row.querySelector('[data-role="upload-status"]');
                    if (statusEl) {
                        statusEl.textContent = text;
                        statusEl.classList.remove('text-muted-foreground');
                        statusEl.classList.add('text-destructive');
                    }
                    const transcodeWrapper = row.querySelector('[data-role="transcode-wrapper"]');
                    if (transcodeWrapper) {
                        transcodeWrapper.classList.add('hidden');
                    }

                    if (!row.querySelector('[data-role="dismiss-error"]')) {
                        const queueId = row.dataset.queueId;
                        const dismissBtn = document.createElement('button');
                        dismissBtn.type = 'button';
                        dismissBtn.dataset.role = 'dismiss-error';
                        dismissBtn.className = 'mt-2 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors border border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground px-3 py-2 md:py-1.5 text-xs';
                        dismissBtn.textContent = 'Dismiss';
                        dismissBtn.addEventListener('click', function () {
                            dismissQueueRow(queueId);
                        });
                        row.appendChild(dismissBtn);
                    }
                }

                function markItemError(item, message) {
                    const text = 'Error: ' + message;
                    setItemStatus(item, text);
                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        const regEntry = window.__uploadQueueRegistry[item.queueId];
                        regEntry.status = 'error';
                        regEntry.statusText = text;
                        notifyUploadRegistry();
                    }
                    renderErrorRow(findLiveQueueRow(item.queueId) || item.row, text);
                }

                async function uploadFile(item, title, active) {
                    const file = item.file;

                    setItemStatus(item, 'Uploading...');
                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        window.__uploadQueueRegistry[item.queueId].status = 'uploading';
                        notifyUploadRegistry();
                    }
                    // Lines logged before /uploads/init answers are held until the upload id is known.
                    item.preInit = [];
                    logClient('Uploading ' + file.name + '...', { deferTo: item.preInit });

                    const onRateLimitWait = rateLimitNotifier(item);
                    let initData;
                    try {
                        initData = await fetchWithRetry('/uploads/init', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-CSRF-TOKEN': csrfToken,
                                'Accept': 'application/json',
                            },
                            body: JSON.stringify({
                                filename: file.name,
                                total_size: file.size,
                                title: title,
                            }),
                        }, 4, onRateLimitWait);
                    } catch (err) {
                        releaseDeferred(item.preInit, null, null); // no association possible -> misc rows
                        throw err;
                    }

                    const uploadId = initData.upload_id;
                    item.uploadId = uploadId;
                    touchActiveUpload(active, { uploadId: uploadId });
                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        window.__uploadQueueRegistry[item.queueId].uploadId = uploadId;
                        notifyUploadRegistry();
                    }
                    releaseDeferred(item.preInit, uploadId, null);
                    releaseDeferred(batchPending, uploadId, null);
                    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                    let bytesSent = 0;

                    for (let i = 0; i < totalChunks; i++) {
                        const start = i * CHUNK_SIZE;
                        const end = Math.min(start + CHUNK_SIZE, file.size);
                        const chunk = file.slice(start, end);

                        await fetchWithRetry('/uploads/' + uploadId + '/chunk', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/octet-stream',
                                'X-Chunk-Index': i,
                                'X-CSRF-TOKEN': csrfToken,
                                'Accept': 'application/json',
                            },
                            body: chunk,
                        }, 3, onRateLimitWait);

                        bytesSent += (end - start);
                        beatUploadRunner();
                        touchActiveUpload(active, {});
                        setItemProgress(item, Math.round((bytesSent / file.size) * 100));
                    }

                    setItemStatus(item, 'Finalizing upload');
                    logItem(item, 'Finishing upload for ' + file.name + '...');

                    const completeData = await fetchWithRetry('/uploads/' + uploadId + '/complete', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-TOKEN': csrfToken,
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify({
                            filename: file.name,
                            total_size: file.size,
                            title: title,
                        }),
                    }, 4, onRateLimitWait);

                    // The video exists now, so a reload from here on does not interrupt this file.
                    endActiveUpload(active);

                    if (completeData && completeData.video_id) {
                        item.videoId = completeData.video_id;
                        uploadedVideos[completeData.video_id] = {
                            title: completeData.video_title || file.name,
                            item: item,
                            status: 'pending',
                            stage: null,
                            progress: 0,
                            queueId: item.queueId,
                            videoId: completeData.video_id,
                        };

                        const liveRowAfterComplete = findLiveQueueRow(item.queueId);
                        const transcodeWrapper = liveRowAfterComplete ? liveRowAfterComplete.querySelector('[data-role="transcode-wrapper"]') : item.transcodeWrapper;
                        const transcodeStatusEl = liveRowAfterComplete ? liveRowAfterComplete.querySelector('[data-role="transcode-status"]') : item.transcodeStatusEl;
                        if (transcodeWrapper) {
                            transcodeWrapper.classList.remove('hidden');
                        }
                        if (transcodeStatusEl) {
                            transcodeStatusEl.textContent = transcodeStatusText('pending', null, 0);
                        }

                        if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                            const regEntry = window.__uploadQueueRegistry[item.queueId];
                            regEntry.videoId = completeData.video_id;
                            regEntry.status = 'pending';
                            regEntry.stage = null;
                            regEntry.progress = 0;
                            notifyUploadRegistry();
                        }

                        loadVideoHistory(completeData.video_id);
                    }

                    setItemStatus(item, 'Done');

                    return completeData && completeData.video_id ? completeData.video_id : null;
                }

                // The upload runner uploads the shared waiting queue one file at a time. Only one runner exists at a time
                // (window.__uploadRunner); a submit while it is active just appends to window.__uploadQueue.
                async function runUploads() {
                    const runner = {
                        active: true,
                        lastBeat: Date.now(),
                        stats: { total: window.__uploadQueue.length, ok: 0, failed: 0, networkFailed: 0 },
                    };
                    const stats = runner.stats;
                    let heartbeat = null;

                    try {
                        window.__uploadRunner = runner;
                        window.__uploadInProgress = true;
                        syncUploadWarning();
                        heartbeat = setInterval(beatUploadRunner, RUNNER_HEARTBEAT_MS);

                        let lastIds = { uploadId: null, videoId: null };

                        // A replaced (stale) runner stops after its current file; the new owner reports the run.
                        while (window.__uploadRunner === runner) {
                            const next = window.__uploadQueue.shift();
                            if (!next) {
                                break;
                            }
                            runner.lastBeat = Date.now();

                            const item = currentQueueItems.find(function (qi) {
                                return qi.queueId === next.queueId;
                            }) || { queueId: next.queueId, row: null, cleared: false };

                            // Removed by Clear queue / Dismiss while waiting: never upload it.
                            if (item.cleared || !window.__uploadQueueRegistry[next.queueId]) {
                                stats.total = Math.max(0, stats.total - 1);
                                continue;
                            }
                            item.file = next.file;

                            const active = beginActiveUpload(item, function () {
                                return window.__uploadQueue.length;
                            });
                            // Lines still held back for an upload id; flushed by the pagehide handler if the page unloads first.
                            active.getDeferred = function () {
                                return [batchPending, item.preInit];
                            };
                            let uploaded = false;
                            try {
                                await uploadFile(item, next.title, active);
                                uploaded = true;
                            } catch (err) {
                                stats.failed++;
                                if (err && err.isNetworkError) {
                                    stats.networkFailed++;
                                }
                                const failMessage = (err && err.message) || 'An error occurred during upload.';
                                markItemError(item, failMessage);
                                logItem(item, item.file.name + ' failed: ' + failMessage, 'error');
                            } finally {
                                endActiveUpload(active);
                                const ids = resolveItemIds(item);
                                if (ids.uploadId) {
                                    lastIds = ids;
                                }
                            }
                            if (uploaded) {
                                stats.ok++;
                                logItem(item, item.file.name + ' uploaded successfully. (' + stats.ok + '/' + stats.total + ')');
                            }
                        }

                        if (window.__uploadRunner !== runner) {
                            return;
                        }

                        // Everything below is synchronous (no await after the last queue check), so a submit can never
                        // slip between "queue empty" and "runner cleared" (see the finally block).
                        showUploadSummaryBox();
                        releaseDeferred(batchPending, null, null); // no file ever got an upload id -> misc rows
                        if (stats.total > 0) {
                            const failedCount = stats.failed;
                            let summaryMessage;
                            let summaryLevel = 'error';
                            if (failedCount === 0) {
                                summaryMessage = 'Upload finished: ' + stats.ok + '/' + stats.total + ' file(s) uploaded. Processing continues in the background.';
                                summaryLevel = 'info';
                            } else if (stats.networkFailed === failedCount && stats.ok === 0) {
                                summaryMessage = 'Upload failed: 0/' + stats.total + ' file(s) uploaded because the network connection was lost. The upload was stopped and no video will be processed.';
                            } else if (stats.networkFailed === failedCount) {
                                summaryMessage = 'Upload finished with errors: ' + stats.ok + '/' + stats.total + ' file(s) uploaded. ' + failedCount + ' file(s) failed because the network connection was lost and will not be processed.';
                            } else if (stats.ok === 0) {
                                summaryMessage = 'Upload failed: 0/' + stats.total + ' file(s) uploaded. The upload was stopped and no video will be processed.';
                            } else {
                                summaryMessage = 'Upload finished with errors: ' + stats.ok + '/' + stats.total + ' file(s) uploaded. ' + failedCount + ' file(s) failed and will not be processed.';
                            }
                            logClient(summaryMessage, { level: summaryLevel, uploadId: lastIds.uploadId, videoId: lastIds.videoId });
                        }
                    } finally {
                        clearInterval(heartbeat);
                        if (window.__uploadRunner === runner) {
                            window.__uploadRunner = null;
                            window.__uploadInProgress = false;
                            syncUploadWarning();
                        }
                    }
                }

                form.addEventListener('submit', function (e) {
                    e.preventDefault();
                    hideError();
                    hideSummary();

                    // Smallest first (stable: ties keep the selection order) so small files are ready sooner.
                    const files = Array.from(fileInput.files)
                        .map(function (file, index) {
                            return { file: file, index: index };
                        })
                        .sort(function (a, b) {
                            return (a.file.size - b.file.size) || (a.index - b.index);
                        })
                        .map(function (entry) {
                            return entry.file;
                        });
                    if (files.length === 0) {
                        showError('Please select a video file.');
                        return;
                    }

                    const invalidMessages = [];
                    for (const file of files) {
                        const extension = file.name.split('.').pop().toLowerCase();
                        if (!allowedExtensions.includes(extension)) {
                            invalidMessages.push(file.name + ': invalid format. Only ' + allowedExtensions.join(', ') + ' are accepted.');
                            continue;
                        }
                        if (file.size > maxSizeBytes) {
                            invalidMessages.push(file.name + ': size exceeds the allowed limit.');
                        }
                    }

                    if (invalidMessages.length > 0) {
                        showError(invalidMessages.join(' '));
                        return;
                    }

                    const runnerActive = isUploadRunnerActive();
                    const batchTitle = files.length > 1 ? '' : titleInput.value;

                    if (runnerActive) {
                        const runningUpload = window.__uploadActive;
                        logClient('Added ' + files.length + ' file(s) to the upload queue' + (files.length > 1 ? ', smallest first.' : '.'), {
                            uploadId: runningUpload ? runningUpload.uploadId : null,
                        });
                    } else {
                        // Held until the first file's upload id is known, then attached to it.
                        batchPending = [];
                        logClient('Starting upload of ' + files.length + ' file(s)' + (files.length > 1 ? ', smallest first.' : '.'), { deferTo: batchPending });
                    }

                    // Reset the form right away so more files can be picked while this batch waits or uploads.
                    fileInput.value = '';
                    titleInput.value = '';
                    updateTitleVisibility();
                    hideSelectedFilesList();

                    const items = buildQueueUI(files);
                    currentQueueItems = currentQueueItems.concat(items);
                    items.forEach(function (item) {
                        window.__uploadQueue.push({ queueId: item.queueId, file: item.file, title: batchTitle });
                    });

                    if (runnerActive) {
                        window.__uploadRunner.stats.total += items.length;
                        touchActiveUpload(window.__uploadActive, {});
                        return;
                    }

                    runUploads().catch(function (err) {
                        try {
                            showError('Upload stopped unexpectedly: ' + ((err && err.message) || 'unknown error') + ' Add files again to resume the waiting uploads.');
                        } catch (displayError) {
                            // the page may be gone
                        }
                    });
                });

                // Registry entry that represents the same file as a DB video: (a) already linked to it, or (b) not yet
                // linked (the /complete response was not processed yet) with the same filename and size.
                function findRegistryEntryForVideo(video) {
                    const entries = Object.values(window.__uploadQueueRegistry);
                    const linked = entries.find(function (r) {
                        return r.videoId !== null && r.videoId !== undefined && Number(r.videoId) === Number(video.id);
                    });
                    if (linked) {
                        return linked;
                    }
                    return entries.find(function (r) {
                        return (r.videoId === null || r.videoId === undefined)
                            && r.status !== 'error'
                            && (r.title === video.original_filename || r.title === video.title)
                            && Number(r.size) === Number(video.original_size_bytes);
                    }) || null;
                }

                function hydrateActiveVideos() {
                    @php
                        $activeVideosForJs = $activeVideos->map(function ($video) {
                            return [
                                'id' => $video->id,
                                'title' => $video->title,
                                'original_filename' => $video->original_filename,
                                'original_size_bytes' => $video->original_size_bytes,
                                'status' => $video->status,
                                'stage' => $video->stage,
                                'progress' => $video->progress,
                            ];
                        });
                    @endphp
                    const activeVideos = @json($activeVideosForJs);

                    activeVideos.forEach(function (video) {
                        // The same file may already be tracked by the registry (upload started on another script
                        // instance): reuse its queueId so a single row is shown and later removal works.
                        const registryMatch = findRegistryEntryForVideo(video);
                        if (registryMatch) {
                            registryMatch.videoId = video.id;
                            registryMatch.status = video.status;
                            registryMatch.stage = video.stage || null;
                            registryMatch.progress = video.progress || 0;
                            notifyUploadRegistry();
                            adoptRegistryEntry(registryMatch);
                            loadVideoHistory(video.id);
                            return;
                        }

                        const item = createQueueRow(video.title || video.original_filename, video.original_size_bytes || 0);
                        setUploadBarPercent(item.bar, 100);
                        item.statusEl.textContent = 'Done';
                        queueList.appendChild(item.row);
                        currentQueueItems.push(item);

                        item.transcodeWrapper.classList.remove('hidden');
                        setTranscodeBarStage(item.bar, video.status, video.stage);
                        if (video.progress > 0) {
                            item.bar.style.width = video.progress + '%';
                        }
                        item.transcodeStatusEl.textContent = transcodeStatusText(video.status, video.stage, video.progress);

                        uploadedVideos[video.id] = {
                            title: video.title || video.original_filename,
                            item: item,
                            status: video.status,
                            stage: video.stage,
                            progress: video.progress,
                            videoId: video.id,
                        };

                        loadVideoHistory(video.id);
                    });

                    updateQueueEmptyState();
                }

                // Builds (or reuses, if already present in the live DOM) the uploadedVideos[videoId]
                // entry for a registry entry that already has a videoId. Shared by rebuildQueueFromRegistry()
                // (adoption at script startup) and applyStatusSnapshot() (adoption on the fly, when a status
                // update arrives for a video this script instance doesn't know about yet).
                function adoptRegistryEntry(registryEntry) {
                    let item;
                    const liveRow = findLiveQueueRow(registryEntry.queueId);

                    if (liveRow) {
                        item = {
                            row: liveRow,
                            bar: liveRow.querySelector('[data-role="upload-bar"]'),
                            statusEl: liveRow.querySelector('[data-role="upload-status"]'),
                            transcodeWrapper: liveRow.querySelector('[data-role="transcode-wrapper"]'),
                            transcodeStatusEl: liveRow.querySelector('[data-role="transcode-status"]'),
                            cleared: false,
                            queueId: registryEntry.queueId,
                        };
                    } else {
                        item = createQueueRow(registryEntry.title, registryEntry.size, registryEntry.queueId);
                        queueList.appendChild(item.row);
                        currentQueueItems.push(item);
                    }

                    setUploadBarPercent(item.bar, 100);
                    item.statusEl.textContent = 'Done';
                    item.transcodeWrapper.classList.remove('hidden');

                    setTranscodeBarStage(item.bar, registryEntry.status, registryEntry.stage);
                    if (registryEntry.progress > 0) {
                        item.bar.style.width = registryEntry.progress + '%';
                    }
                    item.transcodeStatusEl.textContent = transcodeStatusText(registryEntry.status, registryEntry.stage, registryEntry.progress);

                    const entry = {
                        title: registryEntry.title,
                        item: item,
                        status: registryEntry.status,
                        stage: registryEntry.stage || null,
                        progress: registryEntry.progress || 0,
                        queueId: registryEntry.queueId,
                        videoId: registryEntry.videoId,
                    };

                    uploadedVideos[registryEntry.videoId] = entry;

                    return entry;
                }

                function rebuildQueueFromRegistry() {
                    const registry = window.__uploadQueueRegistry;

                    Object.keys(registry).forEach(function (queueId) {
                        const entry = registry[queueId];

                        // Failed upload kept across soft navigation: show it as an error row (not retried).
                        if (entry.status === 'error') {
                            const errorItem = createQueueRow(entry.title, entry.size, queueId);
                            queueList.appendChild(errorItem.row);
                            currentQueueItems.push(errorItem);
                            setUploadBarPercent(errorItem.bar, entry.uploadPercent);
                            renderErrorRow(errorItem.row, entry.statusText || 'Error: Upload failed.');
                            return;
                        }

                        // Already rendered via hydrateActiveVideos() from server-side DB state — avoid duplicating the row.
                        if (entry.videoId && uploadedVideos[entry.videoId]) {
                            return;
                        }

                        if (entry.videoId) {
                            adoptRegistryEntry(entry);
                            loadVideoHistory(entry.videoId);
                            return;
                        }

                        const item = createQueueRow(entry.title, entry.size, queueId);
                        queueList.appendChild(item.row);
                        currentQueueItems.push(item);

                        setUploadBarPercent(item.bar, entry.uploadPercent);
                        item.statusEl.textContent = (entry.statusText === LEGACY_WAITING_LABEL ? WAITING_LABEL : entry.statusText) || WAITING_LABEL;
                    });

                    updateQueueEmptyState();
                }

                // Started before hydrateActiveVideos()/rebuildQueueFromRegistry(): loadVideoHistory() and
                // applyStatusSnapshot() wait on it so replayed history is never rendered twice.
                recoverInterruptedUpload();
                replayPromise = runReplay(false);

                hydrateActiveVideos();
                rebuildQueueFromRegistry();

                // Soft-navigated back while an older instance still runs the shared upload runner: show its warning.
                syncUploadWarning();

                function activeVideoIds() {
                    const ids = Object.keys(uploadedVideos).filter(function (id) {
                        const v = uploadedVideos[id];
                        return v.status === 'pending' || v.status === 'processing';
                    });

                    // Registry entries that already have a videoId but haven't been adopted into
                    // uploadedVideos yet (see adoptRegistryEntry()) must still be included here, so a
                    // manual resyncStatus() (e.g. the visibilitychange handler) can also trigger adoption
                    // and catch-up, not just a live broadcast event.
                    Object.values(window.__uploadQueueRegistry).forEach(function (registryEntry) {
                        if (registryEntry.videoId && !uploadedVideos[registryEntry.videoId]) {
                            ids.push(String(registryEntry.videoId));
                        }
                    });

                    return Array.from(new Set(ids));
                }

                const MAX_RECONNECT_ATTEMPTS = 10;
                const BASE_RECONNECT_DELAY_MS = 3000;
                const MAX_RECONNECT_DELAY_MS = 30000;
                let reconnectAttempts = 0;

                async function resyncStatus() {
                    const ids = activeVideoIds();
                    if (ids.length === 0) {
                        return;
                    }

                    let data;
                    try {
                        data = await fetchWithRetry('/videos/status?ids=' + ids.join(','), {
                            headers: { 'Accept': 'application/json' },
                        }, 1);
                    } catch (err) {
                        return; // best-effort; the next reconnect (or the live WS event) will catch up
                    }

                    data.forEach(applyStatusSnapshot);
                }

                function handleVideoStatusUpdated(e) {
                    applyStatusSnapshot({ id: e.videoId, status: e.status, stage: e.stage, progress: e.progress });
                }

                function subscribeToVideoChannel() {
                    if (!window.Echo) {
                        return;
                    }

                    // Unbind only this page's handler; other listeners (e.g. the sidebar badge) must stay attached.
                    window.Echo.channel('videos').stopListening('.video.status-updated', handleVideoStatusUpdated);
                    window.Echo.channel('videos').listen('.video.status-updated', handleVideoStatusUpdated);
                }

                let reconnectTimeoutId = null;

                function handleConnectionStateChange(states) {
                    if (states.current === 'connected') {
                        reconnectAttempts = 0;
                        subscribeToVideoChannel();
                        resyncStatus();
                    } else if (states.current === 'unavailable' || states.current === 'failed') {
                        reconnectAttempts++;

                        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                            logClient('Lost real-time connection. Please reload the page to see the latest status.', { level: 'error' });
                            return;
                        }

                        const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

                        clearTimeout(reconnectTimeoutId);
                        reconnectTimeoutId = setTimeout(function () {
                            window.Echo.connector.pusher.connect();
                        }, delay);
                    }
                }

                function handleVisibilityChange() {
                    if (document.visibilityState === 'visible') {
                        if (!replayDone && !replayRetried) {
                            replayRetried = true;
                            replayPromise = runReplay(true);
                        }
                        resyncStatus();
                    }
                }

                function handleOutboxVisibility() {
                    // Flush when returning to the tab, and immediately when hiding it (keepalive lets the request
                    // outlive the page, so lines created right before leaving are not lost).
                    clearTimeout(outbox.timer);
                    outbox.timer = null;
                    flushOutbox();
                }

                function handlePageHide(event) {
                    // Queue the "upload interrupted" line first so the flush below sends it in the same request.
                    reportActiveInterrupted(event);
                    clearTimeout(outbox.timer);
                    outbox.timer = null;
                    flushOutbox();
                }

                function handleOnline() {
                    flushOutbox();
                }

                window.addEventListener('online', handleOnline);
                document.addEventListener('visibilitychange', handleOutboxVisibility);
                window.addEventListener('pagehide', handlePageHide);

                function initializeLiveUpdates() {
                    subscribeToVideoChannel();

                    if (window.Echo && window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.bind('state_change', handleConnectionStateChange);

                        if (window.Echo.connector.pusher.connection.state === 'connected') {
                            resyncStatus();
                        }
                    }

                    document.addEventListener('visibilitychange', handleVisibilityChange);
                }

                if (window.Echo) {
                    initializeLiveUpdates();
                } else {
                    document.addEventListener('DOMContentLoaded', initializeLiveUpdates);
                }

                window.__pageCleanup = function () {
                    window.removeEventListener('dragover', handleWindowDragOver);
                    window.removeEventListener('dragleave', handleWindowDragLeave);
                    window.removeEventListener('drop', handleWindowDrop);
                    clearTimeout(reconnectTimeoutId);
                    if (window.Echo) {
                        window.Echo.channel('videos').stopListening('.video.status-updated', handleVideoStatusUpdated);
                    }
                    if (window.Echo && window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.unbind('state_change', handleConnectionStateChange);
                    }
                    document.removeEventListener('visibilitychange', handleVisibilityChange);
                    window.removeEventListener('online', handleOnline);
                    document.removeEventListener('visibilitychange', handleOutboxVisibility);
                    window.removeEventListener('pagehide', handlePageHide);
                    copyLogBtn.removeEventListener('click', handleCopyLogClick);
                    clearTimeout(copyFeedbackTimerId);
                };

                async function applyStatusSnapshot(video) {
                    await replayPromise;
                    let entry = uploadedVideos[video.id];
                    let justAdopted = false;

                    if (!entry) {
                        const registryEntry = Object.values(window.__uploadQueueRegistry).find(function (r) {
                            return r.videoId === video.id;
                        });

                        if (registryEntry) {
                            entry = adoptRegistryEntry(registryEntry);
                            justAdopted = true;
                            await loadVideoHistory(registryEntry.videoId);
                        }
                    }

                    if (!entry) {
                        return;
                    }

                    const item = entry.item;
                    const statusChanged = justAdopted || entry.status !== video.status;
                    const progressChanged = justAdopted || entry.progress !== video.progress;
                    const stageChanged = justAdopted || entry.stage !== video.stage;

                    if (!statusChanged && !progressChanged && !stageChanged) {
                        return;
                    }

                    entry.status = video.status;
                    entry.stage = video.stage;
                    entry.progress = video.progress;

                    if (entry.queueId && window.__uploadQueueRegistry[entry.queueId]) {
                        const regEntry = window.__uploadQueueRegistry[entry.queueId];
                        regEntry.status = video.status;
                        regEntry.stage = video.stage;
                        regEntry.progress = video.progress;
                        notifyUploadRegistry(true);
                    }

                    function liveTranscodeEls() {
                        if (!item) {
                            return {};
                        }
                        const liveRow = findLiveQueueRow(item.queueId);
                        return {
                            row: liveRow || item.row,
                            wrapper: liveRow ? liveRow.querySelector('[data-role="transcode-wrapper"]') : item.transcodeWrapper,
                            bar: liveRow ? liveRow.querySelector('[data-role="upload-bar"]') : item.bar,
                            statusEl: liveRow ? liveRow.querySelector('[data-role="transcode-status"]') : item.transcodeStatusEl,
                        };
                    }

                    let lines = [];
                    const built = buildStatusMessages(video.id, entry.title, video.status, video.stage, video.progress);

                    if (video.status === 'pending' && !isMergingPending(video.status, video.stage)) {
                        // Queued progress is the upload share and may be re-sent: log only when status/stage changed.
                        if (statusChanged || stageChanged) {
                            lines = built;
                        }
                        if (item) {
                            const els = liveTranscodeEls();
                            if (els.wrapper) {
                                els.wrapper.classList.remove('hidden');
                            }
                            setTranscodeBarStage(els.bar, video.status, video.stage);
                            if (els.bar && video.progress > 0) {
                                els.bar.style.width = video.progress + '%';
                            }
                            if (els.statusEl) {
                                els.statusEl.textContent = transcodeStatusText(video.status, video.stage, video.progress);
                            }
                        }
                    } else if (video.status === 'processing' || isMergingPending(video.status, video.stage)) {
                        lines = built;
                        if (progressChanged || stageChanged) {
                            const statusText = transcodeStatusText(video.status, video.stage, video.progress);
                            if (item) {
                                const els = liveTranscodeEls();
                                if (els.wrapper) {
                                    els.wrapper.classList.remove('hidden');
                                }
                                setTranscodeBarStage(els.bar, video.status, video.stage);
                                if (els.bar) {
                                    els.bar.style.width = video.progress + '%';
                                }
                                if (els.statusEl) {
                                    els.statusEl.textContent = statusText;
                                }
                            }
                        }
                    } else if (video.status === 'ready') {
                        lines = built;
                        removeFinishedQueueRow(entry);
                    } else if (video.status === 'failed') {
                        lines = built;
                        removeFinishedQueueRow(entry);
                    }

                    lines.forEach(function (line) {
                        appendStatusLine(video.id, line.message, line.className);
                    });
                    if (video.status === 'ready' || video.status === 'failed') {
                        delete lastStatusLineByVideo[String(video.id)];
                    }
                }
            })();
        </script>
    @endpush
@endsection
