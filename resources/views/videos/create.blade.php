@extends('layouts.app')

@section('title', 'Upload Video - HLS R2 Studio')
@section('page-title', 'Upload Video')
@section('breadcrumb', 'Home / Upload Video')

@section('content')
    <x-ui.card class="max-w-xl overflow-hidden">
        <x-ui.card-header class="border-b border-border">
            <x-ui.card-title class="inline-flex items-center gap-2"><x-lucide-cloud-upload class="w-4 h-4" /> Upload Video</x-ui.card-title>
        </x-ui.card-header>

        <form id="upload-form" class="p-6 space-y-5"
              data-max-size-mb="{{ config('videos.max_upload_size_mb') }}"
              data-chunk-size-mb="{{ config('videos.chunk_size_mb') }}">
            <div id="title-field-wrapper">
                <x-ui.label for="title" class="block mb-2">Title (optional)</x-ui.label>
                <x-ui.input type="text" name="title" id="title" value="{{ old('title') }}" />
                <p id="title-multi-note" class="mt-1 text-xs text-muted-foreground hidden">Title is automatically taken from the filename when uploading multiple videos.</p>
            </div>

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
                <p class="mt-1 text-xs text-muted-foreground">Formats: mp4, mov, mkv, avi, webm. Maximum size {{ config('videos.max_upload_size_mb') }} MB.</p>
                <div id="selected-files-list" class="mt-2 space-y-1 hidden"></div>
            </div>

            <x-ui.alert variant="destructive" id="upload-error" class="hidden"></x-ui.alert>

            <x-ui.button type="submit" id="upload-submit">
                Upload
            </x-ui.button>

            <x-ui.alert variant="warning" id="upload-warning" class="hidden">
                <x-lucide-triangle-alert class="w-4 h-4 shrink-0" />
                Please do not reload or close this tab while the upload is in progress.
            </x-ui.alert>

            <x-ui.card id="upload-progress-card" class="overflow-hidden">
                <div class="bg-muted border-b border-border px-4 py-2 flex items-center justify-between gap-2">
                    <h3 class="text-sm font-semibold text-foreground inline-flex items-center gap-2"><x-lucide-activity class="w-4 h-4" /> Upload Progress</h3>
                    <x-ui.button variant="outline" size="sm" id="clear-queue-btn">
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear queue
                    </x-ui.button>
                </div>
                <div class="p-4">
                    <div id="upload-queue" class="space-y-3"></div>
                    <p id="upload-queue-empty" class="text-sm text-muted-foreground text-center py-4">No files in queue.</p>
                </div>
            </x-ui.card>

            <x-ui.card class="overflow-hidden">
                <div class="bg-muted border-b border-border px-4 py-2 flex items-center justify-between gap-2">
                    <h3 class="text-sm font-semibold text-foreground inline-flex items-center gap-2"><x-lucide-scroll-text class="w-4 h-4" /> Log</h3>
                    <x-ui.button variant="outline" size="sm" id="clear-log-btn">
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear log
                    </x-ui.button>
                </div>
                <div class="p-4">
                    <div id="upload-log" class="font-mono text-xs text-muted-foreground space-y-1 max-h-40 overflow-y-auto break-words">
                        <p class="text-muted-foreground" data-log-placeholder>Ready.</p>
                    </div>
                </div>
            </x-ui.card>

            <div id="upload-summary" class="hidden">
                <x-ui.button href="{{ route('videos.index') }}">
                    View video list
                </x-ui.button>
            </div>
        </form>
    </x-ui.card>

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
                const uploadWarning = document.getElementById('upload-warning');

                const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
                const allowedExtensions = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
                const maxSizeBytes = parseInt(form.dataset.maxSizeMb, 10) * 1024 * 1024;
                const CHUNK_SIZE = parseInt(form.dataset.chunkSizeMb, 10) * 1024 * 1024;
                const FILE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/></svg>';
                const TRASH_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

                let currentQueueItems = [];
                let isUploading = false;
                const uploadedVideos = {};
                const historyLoadedForVideoIds = new Set();

                window.__uploadQueueRegistry = window.__uploadQueueRegistry || {};

                function generateQueueId() {
                    return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                }

                const LOG_DISMISSED_KEY = 'hls_upload_log_dismissed';

                function loadDismissedLog() {
                    try {
                        const raw = localStorage.getItem(LOG_DISMISSED_KEY);
                        if (!raw) {
                            return [];
                        }
                        const parsed = JSON.parse(raw);
                        return Array.isArray(parsed) ? parsed : [];
                    } catch (e) {
                        return [];
                    }
                }

                function saveDismissedLog(ids) {
                    try {
                        localStorage.setItem(LOG_DISMISSED_KEY, JSON.stringify(ids));
                    } catch (e) {
                        // localStorage unavailable (private mode, quota, etc.) — cache is best-effort only
                    }
                }

                const transcodeStageLabels = {
                    queued: 'Queued',
                    transcoding: 'Transcoding',
                    generating_thumbnail: 'Generating thumbnail',
                    generating_storyboard: 'Generating storyboard',
                    uploading_r2: 'Uploading to R2',
                };

                const STAGES_WITHOUT_PERCENT = ['generating_thumbnail', 'generating_storyboard'];

                function formatStageStatus(stage, progress) {
                    const stageLabel = transcodeStageLabels[stage] || stage;
                    if (STAGES_WITHOUT_PERCENT.includes(stage)) {
                        return stageLabel;
                    }
                    return stageLabel + ' — ' + progress + '%';
                }

                window.addEventListener('beforeunload', function (e) {
                    if (isUploading) {
                        e.preventDefault();
                        e.returnValue = '';
                    }
                });

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

                function appendLog(message, extraClass, time) {
                    const placeholder = logBox.querySelector('[data-log-placeholder]');
                    if (placeholder) {
                        placeholder.remove();
                    }
                    const line = document.createElement('p');
                    if (extraClass) {
                        line.className = extraClass;
                    }
                    line.textContent = '[' + (time || new Date().toLocaleTimeString()) + '] ' + message;
                    logBox.appendChild(line);
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

                async function fetchWithRetry(url, options, maxRetries = 3) {
                    let lastError;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        try {
                            const response = await fetch(url, options);
                            if (!response.ok) {
                                let message = `Request failed (HTTP ${response.status}).`;
                                try {
                                    const data = await response.json();
                                    if (data && data.message) {
                                        message = data.message;
                                    }
                                } catch (e) {
                                    // ignore JSON parse error, keep default message
                                }
                                throw new Error(message);
                            }
                            return await response.json();
                        } catch (err) {
                            lastError = err;
                            if (attempt < maxRetries) {
                                await sleep(1000);
                            }
                        }
                    }
                    throw lastError;
                }

                async function loadVideoHistory(videoId) {
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

                    logs.forEach(function (log) {
                        const time = new Date(log.created_at).toLocaleTimeString();
                        let message = null;
                        let logClass = null;

                        if (log.status === 'pending') {
                            message = entry.title + ' is queued for processing.';
                        } else if (log.status === 'processing') {
                            message = entry.title + ': ' + formatStageStatus(log.stage, log.progress);
                        } else if (log.status === 'ready') {
                            message = entry.title + ' finished transcoding.';
                            logClass = 'text-orange-600 font-medium';
                        } else if (log.status === 'failed') {
                            message = entry.title + ' failed to process.';
                        }

                        if (message) {
                            appendLog(message, logClass, time);
                        }
                    });

                    const lastLog = logs[logs.length - 1];
                    entry.status = lastLog.status;
                    entry.stage = lastLog.stage;
                    entry.progress = lastLog.progress;
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

                window.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    setDropzoneDragging(isPointerOverDropzone(e));
                });

                window.addEventListener('dragleave', function (e) {
                    if (!e.relatedTarget) {
                        setDropzoneDragging(false);
                    }
                });

                window.addEventListener('drop', function (e) {
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
                });

                clearQueueBtn.addEventListener('click', function () {
                    let clearedCount = 0;
                    currentQueueItems.forEach(function (item) {
                        if (!item.cleared && item.statusEl.textContent === 'Pending') {
                            item.cleared = true;
                            item.row.remove();
                            if (item.queueId) {
                                delete window.__uploadQueueRegistry[item.queueId];
                            }
                            clearedCount++;
                        }
                    });
                    updateQueueEmptyState();
                    if (clearedCount > 0) {
                        appendLog('Cleared pending file(s) from queue.');
                    }
                });

                const clearLogBtn = document.getElementById('clear-log-btn');

                clearLogBtn.addEventListener('click', function () {
                    const visibleIds = recentVideos.map(function (video) {
                        return String(video.id);
                    }).concat(Object.keys(uploadedVideos));
                    saveDismissedLog(Array.from(new Set(visibleIds)));

                    logBox.innerHTML = '<p class="text-muted-foreground" data-log-placeholder>Ready.</p>';
                });

                function updateQueueEmptyState() {
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
                    transcodeLabel.textContent = 'Transcoding';

                    const transcodeBarWrapper = document.createElement('div');
                    transcodeBarWrapper.className = 'w-full bg-border rounded-full h-2.5';

                    const transcodeBar = document.createElement('div');
                    transcodeBar.className = 'bg-orange-500 h-2.5 rounded-full';
                    transcodeBar.style.width = '0%';
                    transcodeBar.dataset.role = 'transcode-bar';
                    transcodeBarWrapper.appendChild(transcodeBar);

                    const transcodeStatusEl = document.createElement('p');
                    transcodeStatusEl.className = 'mt-1 text-xs text-muted-foreground break-words';
                    transcodeStatusEl.dataset.role = 'transcode-status';

                    transcodeWrapper.dataset.role = 'transcode-wrapper';
                    transcodeWrapper.appendChild(transcodeLabel);
                    transcodeWrapper.appendChild(transcodeBarWrapper);
                    transcodeWrapper.appendChild(transcodeStatusEl);

                    return { wrapper: transcodeWrapper, bar: transcodeBar, statusEl: transcodeStatusEl };
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
                    barWrapper.className = 'w-full bg-border rounded-full h-2.5 mt-2';

                    const bar = document.createElement('div');
                    bar.className = 'bg-primary h-2.5 rounded-full transition-[width] duration-300 ease-linear';
                    bar.style.width = '0%';
                    bar.dataset.role = 'upload-bar';
                    barWrapper.appendChild(bar);

                    const statusEl = document.createElement('p');
                    statusEl.className = 'mt-1 text-xs text-muted-foreground break-words';
                    statusEl.dataset.role = 'upload-status';
                    statusEl.textContent = 'Pending';

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
                        transcodeBar: transcodeSection.bar,
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
                            statusText: 'Pending',
                            videoId: null,
                            stage: null,
                            progress: 0,
                        };

                        return item;
                    });

                    updateQueueEmptyState();

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

                    if (bar) {
                        bar.style.width = percent + '%';
                    }
                    if (statusEl) {
                        statusEl.textContent = text;
                    }

                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        const entry = window.__uploadQueueRegistry[item.queueId];
                        entry.status = 'uploading';
                        entry.uploadPercent = percent;
                        entry.statusText = text;
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
                    }
                }

                async function uploadFile(item) {
                    const file = item.file;
                    const title = fileInput.files.length > 1 ? '' : titleInput.value;

                    setItemStatus(item, 'Uploading...');
                    if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                        window.__uploadQueueRegistry[item.queueId].status = 'uploading';
                    }
                    const uploadStartTime = new Date().toLocaleTimeString();
                    appendLog('Uploading ' + file.name + '...');

                    const initData = await fetchWithRetry('/uploads/init', {
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
                    }, 1);

                    const uploadId = initData.upload_id;
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
                        });

                        bytesSent += (end - start);
                        setItemProgress(item, Math.round((bytesSent / file.size) * 100));
                    }

                    setItemStatus(item, 'Merging chunk');
                    const processingStartTime = new Date().toLocaleTimeString();
                    appendLog('Finishing upload for ' + file.name + '...');

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
                    }, 1);

                    if (completeData && completeData.video_id) {
                        uploadedVideos[completeData.video_id] = {
                            title: completeData.video_title || file.name,
                            item: item,
                            status: 'pending',
                            stage: null,
                            progress: 0,
                            queueId: item.queueId,
                        };

                        const liveRowAfterComplete = findLiveQueueRow(item.queueId);
                        const transcodeWrapper = liveRowAfterComplete ? liveRowAfterComplete.querySelector('[data-role="transcode-wrapper"]') : item.transcodeWrapper;
                        const transcodeStatusEl = liveRowAfterComplete ? liveRowAfterComplete.querySelector('[data-role="transcode-status"]') : item.transcodeStatusEl;
                        if (transcodeWrapper) {
                            transcodeWrapper.classList.remove('hidden');
                        }
                        if (transcodeStatusEl) {
                            transcodeStatusEl.textContent = 'Queued for processing...';
                        }

                        if (item.queueId && window.__uploadQueueRegistry[item.queueId]) {
                            const regEntry = window.__uploadQueueRegistry[item.queueId];
                            regEntry.videoId = completeData.video_id;
                            regEntry.status = 'pending';
                            regEntry.stage = null;
                            regEntry.progress = 0;
                        }

                        loadVideoHistory(completeData.video_id);
                    }

                    setItemStatus(item, 'Done');

                    return completeData && completeData.video_id ? completeData.video_id : null;
                }

                form.addEventListener('submit', async function (e) {
                    e.preventDefault();
                    hideError();
                    hideSummary();

                    const files = Array.from(fileInput.files);
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

                    submitButton.disabled = true;
                    fileInput.disabled = true;
                    isUploading = true;
                    uploadWarning.classList.remove('hidden');

                    appendLog('Starting upload of ' + files.length + ' file(s).');

                    hideSelectedFilesList();

                    const items = buildQueueUI(files);
                    currentQueueItems = currentQueueItems.concat(items);

                    const consideredCount = items.filter(function (item) {
                        return !item.cleared;
                    }).length;

                    let successCount = 0;

                    for (const item of items) {
                        if (item.cleared) {
                            continue;
                        }
                        try {
                            const videoId = await uploadFile(item);
                            successCount++;
                            appendLog(item.file.name + ' uploaded successfully. (' + successCount + '/' + consideredCount + ')', 'text-foreground font-medium');
                        } catch (err) {
                            setItemStatus(item, 'Error: ' + (err.message || 'An error occurred during upload.'));
                            appendLog(item.file.name + ' failed: ' + (err.message || 'An error occurred during upload.'));
                            if (item.queueId) {
                                delete window.__uploadQueueRegistry[item.queueId];
                            }
                        }
                    }

                    submitButton.disabled = false;
                    fileInput.disabled = false;
                    isUploading = false;
                    uploadWarning.classList.add('hidden');

                    summaryBox.classList.remove('hidden');
                    appendLog('Upload finished: ' + successCount + '/' + consideredCount + ' succeeded.', 'text-foreground font-medium');
                });

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
                        const item = createQueueRow(video.title || video.original_filename, video.original_size_bytes || 0);
                        item.bar.style.width = '100%';
                        item.statusEl.textContent = 'Done';
                        queueList.appendChild(item.row);
                        currentQueueItems.push(item);

                        item.transcodeWrapper.classList.remove('hidden');
                        if (video.status === 'pending') {
                            item.transcodeStatusEl.textContent = 'Queued for processing...';
                        } else {
                            item.transcodeBar.style.width = (video.progress || 0) + '%';
                            item.transcodeStatusEl.textContent = formatStageStatus(video.stage || 'transcoding', video.progress || 0);
                        }

                        uploadedVideos[video.id] = {
                            title: video.title || video.original_filename,
                            item: item,
                            status: video.status,
                            stage: video.stage,
                            progress: video.progress,
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
                            transcodeBar: liveRow.querySelector('[data-role="transcode-bar"]'),
                            transcodeStatusEl: liveRow.querySelector('[data-role="transcode-status"]'),
                            cleared: false,
                            queueId: registryEntry.queueId,
                        };
                    } else {
                        item = createQueueRow(registryEntry.title, registryEntry.size, registryEntry.queueId);
                        queueList.appendChild(item.row);
                        currentQueueItems.push(item);
                    }

                    item.bar.style.width = '100%';
                    item.statusEl.textContent = 'Done';
                    item.transcodeWrapper.classList.remove('hidden');

                    if (registryEntry.status === 'pending') {
                        item.transcodeStatusEl.textContent = 'Queued for processing...';
                    } else {
                        item.transcodeBar.style.width = (registryEntry.progress || 0) + '%';
                        item.transcodeStatusEl.textContent = formatStageStatus(registryEntry.stage || 'transcoding', registryEntry.progress || 0);
                    }

                    const entry = {
                        title: registryEntry.title,
                        item: item,
                        status: registryEntry.status,
                        stage: registryEntry.stage || null,
                        progress: registryEntry.progress || 0,
                        queueId: registryEntry.queueId,
                    };

                    uploadedVideos[registryEntry.videoId] = entry;

                    return entry;
                }

                function rebuildQueueFromRegistry() {
                    const registry = window.__uploadQueueRegistry;

                    Object.keys(registry).forEach(function (queueId) {
                        const entry = registry[queueId];

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

                        item.bar.style.width = (entry.uploadPercent || 0) + '%';
                        item.statusEl.textContent = entry.statusText || 'Pending';
                    });

                    updateQueueEmptyState();
                }

                @php
                    $recentVideosForJs = $recentVideos->map(function ($video) {
                        return [
                            'id' => $video->id,
                            'title' => $video->title,
                            'original_filename' => $video->original_filename,
                            'status' => $video->status,
                            'created_at' => optional($video->created_at)->toDisplay('H:i:s'),
                            'updated_at' => optional($video->updated_at)->toDisplay('H:i:s'),
                        ];
                    });
                @endphp
                const recentVideos = @json($recentVideosForJs);

                hydrateActiveVideos();
                rebuildQueueFromRegistry();

                const dismissedLogIds = loadDismissedLog();

                recentVideos.forEach(function (video) {
                    const videoIdStr = String(video.id);

                    if (dismissedLogIds.includes(videoIdStr)) {
                        return;
                    }

                    if (!uploadedVideos[video.id]) {
                        uploadedVideos[video.id] = {
                            title: video.title || video.original_filename,
                            item: null,
                            status: video.status,
                            stage: null,
                            progress: 0,
                        };
                    }

                    loadVideoHistory(video.id);
                });

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

                let hasConnectedBefore = false;

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

                function subscribeToVideoChannel() {
                    if (!window.Echo) {
                        return;
                    }

                    window.Echo.channel('videos').stopListening('.video.status-updated');
                    window.Echo.channel('videos').listen('.video.status-updated', function (e) {
                        applyStatusSnapshot({ id: e.videoId, status: e.status, stage: e.stage, progress: e.progress });
                    });
                }

                function handleConnectionStateChange(states) {
                    console.log('[Echo] connection state changed:', states.previous, '->', states.current);

                    if (states.current === 'connected') {
                        reconnectAttempts = 0;
                        subscribeToVideoChannel();
                        resyncStatus();
                        hasConnectedBefore = true;
                    } else if (states.current === 'unavailable' || states.current === 'failed') {
                        reconnectAttempts++;

                        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                            appendLog('Lost real-time connection. Please reload the page to see the latest status.', 'text-destructive font-medium');
                            return;
                        }

                        const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

                        setTimeout(function () {
                            window.Echo.connector.pusher.connect();
                        }, delay);
                    }
                }

                function handleVisibilityChange() {
                    if (document.visibilityState === 'visible') {
                        resyncStatus();
                    }
                }

                function initializeLiveUpdates() {
                    subscribeToVideoChannel();

                    if (window.Echo && window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.bind('state_change', handleConnectionStateChange);
                    }

                    document.addEventListener('visibilitychange', handleVisibilityChange);
                }

                if (window.Echo) {
                    initializeLiveUpdates();
                } else {
                    document.addEventListener('DOMContentLoaded', initializeLiveUpdates);
                }

                window.__pageCleanup = function () {
                    if (window.Echo) {
                        window.Echo.channel('videos').stopListening('.video.status-updated');
                    }
                    if (window.Echo && window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.unbind('state_change', handleConnectionStateChange);
                    }
                    document.removeEventListener('visibilitychange', handleVisibilityChange);
                };

                async function applyStatusSnapshot(video) {
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
                    }

                    function liveTranscodeEls() {
                        if (!item) {
                            return {};
                        }
                        const liveRow = findLiveQueueRow(item.queueId);
                        return {
                            row: liveRow || item.row,
                            wrapper: liveRow ? liveRow.querySelector('[data-role="transcode-wrapper"]') : item.transcodeWrapper,
                            bar: liveRow ? liveRow.querySelector('[data-role="transcode-bar"]') : item.transcodeBar,
                            statusEl: liveRow ? liveRow.querySelector('[data-role="transcode-status"]') : item.transcodeStatusEl,
                        };
                    }

                    let message = null;
                    let logClass = null;

                    if (video.status === 'pending') {
                        message = entry.title + ' is queued for processing.';
                        if (item) {
                            const els = liveTranscodeEls();
                            if (els.wrapper) {
                                els.wrapper.classList.remove('hidden');
                            }
                            if (els.statusEl) {
                                els.statusEl.textContent = 'Queued for processing...';
                            }
                        }
                    } else if (video.status === 'processing') {
                        if (progressChanged || stageChanged) {
                            const statusText = formatStageStatus(video.stage, video.progress);
                            message = entry.title + ': ' + statusText;
                            if (item) {
                                const els = liveTranscodeEls();
                                if (els.wrapper) {
                                    els.wrapper.classList.remove('hidden');
                                }
                                if (els.bar) {
                                    els.bar.style.width = video.progress + '%';
                                }
                                if (els.statusEl) {
                                    els.statusEl.textContent = statusText;
                                }
                            }
                        }
                    } else if (video.status === 'ready') {
                        message = entry.title + ' finished transcoding.';
                        logClass = 'text-orange-600 font-medium';
                        if (item) {
                            const els = liveTranscodeEls();
                            if (els.row) {
                                els.row.remove();
                            }
                            currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                            updateQueueEmptyState();
                        }
                        if (entry.queueId) {
                            delete window.__uploadQueueRegistry[entry.queueId];
                        }
                    } else if (video.status === 'failed') {
                        message = entry.title + ' failed to process.';
                        if (item) {
                            const els = liveTranscodeEls();
                            if (els.row) {
                                els.row.remove();
                            }
                            currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                            updateQueueEmptyState();
                        }
                        if (entry.queueId) {
                            delete window.__uploadQueueRegistry[entry.queueId];
                        }
                    }

                    if (message) {
                        appendLog(message, logClass);
                    }
                }
            })();
        </script>
    @endpush
@endsection
