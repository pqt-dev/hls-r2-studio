@extends('layouts.app')

@section('title', 'Upload Video - HLS R2 Studio')
@section('page-title', 'Upload Video')
@section('breadcrumb', 'Home / Upload Video')

@section('content')
    <div class="max-w-xl bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div class="bg-blue-50 border-b border-blue-100 px-6 py-4">
            <h2 class="text-base font-semibold text-blue-700 inline-flex items-center gap-2"><x-lucide-cloud-upload class="w-4 h-4" /> Upload Video</h2>
        </div>

        <form id="upload-form" class="p-6 space-y-5"
              data-max-size-mb="{{ config('videos.max_upload_size_mb') }}"
              data-chunk-size-mb="{{ config('videos.chunk_size_mb') }}">
            <div id="title-field-wrapper">
                <label for="title" class="block text-sm font-medium text-gray-700 mb-1">Title (optional)</label>
                <input type="text" name="title" id="title" value="{{ old('title') }}"
                       class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
                <p id="title-multi-note" class="mt-1 text-xs text-gray-500 hidden">Title is automatically taken from the filename when uploading multiple videos.</p>
            </div>

            <div>
                <label for="video" class="block text-sm font-medium text-gray-700 mb-1">Video File</label>
                <input type="file" name="video" id="video" accept=".mp4,.mov,.mkv,.avi,.webm" multiple required class="hidden">
                <div id="dropzone"
                     class="rounded-2xl border-2 border-dashed border-gray-300 px-6 py-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/40">
                    <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50">
                        <x-lucide-cloud-upload class="w-8 h-8 text-blue-700" />
                    </div>
                    <p id="dropzone-instruction" class="text-sm text-gray-600 mb-3">Drag and drop video here, or</p>
                    <span class="pointer-events-none inline-flex items-center gap-2 rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
                        <x-lucide-upload class="w-4 h-4" /> Choose Video File
                    </span>
                </div>
                <p class="mt-1 text-xs text-gray-500">Formats: mp4, mov, mkv, avi, webm. Maximum size {{ config('videos.max_upload_size_mb') }} MB.</p>
                <div id="selected-files-list" class="mt-2 space-y-1 hidden"></div>
            </div>

            <div id="upload-error" class="hidden rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm"></div>

            <button type="submit" id="upload-submit"
                    class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                Upload
            </button>

            <div id="upload-warning" class="hidden rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm flex items-center gap-2">
                <x-lucide-triangle-alert class="w-4 h-4 shrink-0" />
                Please do not reload or close this tab while the upload is in progress.
            </div>

            <div id="upload-progress-card" class="rounded-2xl border border-gray-200 overflow-hidden">
                <div class="bg-blue-50 border-b border-blue-100 px-4 py-2 flex items-center justify-between">
                    <h3 class="text-sm font-semibold text-blue-700 inline-flex items-center gap-2"><x-lucide-activity class="w-4 h-4" /> Upload Progress</h3>
                    <button type="button" id="clear-queue-btn"
                            class="inline-flex items-center gap-1 rounded-lg border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear queue
                    </button>
                </div>
                <div class="p-4">
                    <div id="upload-queue" class="space-y-3"></div>
                    <p id="upload-queue-empty" class="text-sm text-gray-500 text-center py-4">No files in queue.</p>
                </div>
            </div>

            <div class="rounded-2xl border border-gray-200 overflow-hidden">
                <div class="bg-blue-50 border-b border-blue-100 px-4 py-2 flex items-center justify-between">
                    <h3 class="text-sm font-semibold text-blue-700 inline-flex items-center gap-2"><x-lucide-scroll-text class="w-4 h-4" /> Log</h3>
                    <button type="button" id="clear-log-btn"
                            class="inline-flex items-center gap-1 rounded-lg border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Clear log
                    </button>
                </div>
                <div class="p-4">
                    <div id="upload-log" class="font-mono text-xs text-gray-600 space-y-1 max-h-40 overflow-y-auto">
                        <p class="text-gray-400" data-log-placeholder>Ready.</p>
                    </div>
                </div>
            </div>

            <div id="upload-summary" class="hidden">
                <a href="{{ route('videos.index') }}" class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
                    View Video List
                </a>
            </div>
        </form>
    </div>

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

                const LOG_CACHE_KEY = 'hls_upload_log_cache';
                const LOG_CACHE_MAX_VIDEOS = 5;
                const LOG_DISMISSED_KEY = 'hls_upload_log_dismissed';

                function loadLogCache() {
                    try {
                        const raw = localStorage.getItem(LOG_CACHE_KEY);
                        if (!raw) {
                            return { order: [], entries: {} };
                        }
                        const parsed = JSON.parse(raw);
                        return { order: parsed.order || [], entries: parsed.entries || {} };
                    } catch (e) {
                        return { order: [], entries: {} };
                    }
                }

                function saveLogCache(cache) {
                    try {
                        localStorage.setItem(LOG_CACHE_KEY, JSON.stringify(cache));
                    } catch (e) {
                        // localStorage unavailable (private mode, quota, etc.) — cache is best-effort only
                    }
                }

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

                function recordLogEntry(videoId, message, logClass, time) {
                    const cache = loadLogCache();
                    const key = String(videoId);

                    if (!cache.entries[key]) {
                        cache.entries[key] = [];
                        cache.order.push(key);
                    }

                    cache.entries[key].push({ message: message, logClass: logClass || null, time: time });

                    while (cache.order.length > LOG_CACHE_MAX_VIDEOS) {
                        const evicted = cache.order.shift();
                        delete cache.entries[evicted];
                    }

                    saveLogCache(cache);
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
                        row.className = 'flex items-center justify-between text-xs bg-gray-50 rounded-lg px-3 py-2 border border-gray-200';

                        const leftWrap = document.createElement('span');
                        leftWrap.className = 'flex items-center gap-2 min-w-0';

                        const iconEl = document.createElement('span');
                        iconEl.className = 'text-blue-700 shrink-0';
                        iconEl.innerHTML = FILE_ICON_SVG;

                        const nameEl = document.createElement('span');
                        nameEl.className = 'text-gray-700 truncate';
                        nameEl.textContent = file.name;

                        leftWrap.appendChild(iconEl);
                        leftWrap.appendChild(nameEl);

                        const sizeEl = document.createElement('span');
                        sizeEl.className = 'text-gray-400 ml-2 shrink-0';
                        sizeEl.textContent = formatSize(file.size);

                        const removeBtn = document.createElement('button');
                        removeBtn.type = 'button';
                        removeBtn.className = 'text-gray-400 hover:text-red-600 shrink-0 ml-2';
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
                    saveLogCache({ order: [], entries: {} });

                    const visibleIds = recentVideos.map(function (video) {
                        return String(video.id);
                    }).concat(Object.keys(uploadedVideos));
                    saveDismissedLog(Array.from(new Set(visibleIds)));

                    logBox.innerHTML = '<p class="text-gray-400" data-log-placeholder>Ready.</p>';
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
                    transcodeWrapper.className = 'hidden mt-2 pt-2 border-t border-gray-100';

                    const transcodeLabel = document.createElement('p');
                    transcodeLabel.className = 'text-xs font-medium text-gray-500 mb-1';
                    transcodeLabel.textContent = 'Transcoding';

                    const transcodeBarWrapper = document.createElement('div');
                    transcodeBarWrapper.className = 'w-full bg-gray-200 rounded-full h-2.5';

                    const transcodeBar = document.createElement('div');
                    transcodeBar.className = 'bg-orange-500 h-2.5 rounded-full transition-[width] duration-[500ms] ease-linear';
                    transcodeBar.style.width = '0%';
                    transcodeBarWrapper.appendChild(transcodeBar);

                    const transcodeStatusEl = document.createElement('p');
                    transcodeStatusEl.className = 'mt-1 text-xs text-gray-500';

                    transcodeWrapper.appendChild(transcodeLabel);
                    transcodeWrapper.appendChild(transcodeBarWrapper);
                    transcodeWrapper.appendChild(transcodeStatusEl);

                    return { wrapper: transcodeWrapper, bar: transcodeBar, statusEl: transcodeStatusEl };
                }

                function createQueueRow(name, size) {
                    const row = document.createElement('div');
                    row.className = 'rounded-lg border border-gray-200 p-3';

                    const header = document.createElement('div');
                    header.className = 'flex items-center justify-between text-sm';

                    const nameEl = document.createElement('span');
                    nameEl.className = 'font-medium text-gray-800 truncate mr-2';
                    nameEl.textContent = name;

                    const sizeEl = document.createElement('span');
                    sizeEl.className = 'text-gray-500 text-xs whitespace-nowrap';
                    sizeEl.textContent = formatSize(size);

                    header.appendChild(nameEl);
                    header.appendChild(sizeEl);

                    const uploadLabel = document.createElement('p');
                    uploadLabel.className = 'text-xs font-medium text-gray-500 mb-1 mt-2';
                    uploadLabel.textContent = 'Uploading';

                    const barWrapper = document.createElement('div');
                    barWrapper.className = 'w-full bg-gray-200 rounded-full h-2.5 mt-2';

                    const bar = document.createElement('div');
                    bar.className = 'bg-blue-600 h-2.5 rounded-full transition-[width] duration-300 ease-linear';
                    bar.style.width = '0%';
                    barWrapper.appendChild(bar);

                    const statusEl = document.createElement('p');
                    statusEl.className = 'mt-1 text-xs text-gray-500';
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
                    };
                }

                function buildQueueUI(files) {
                    const items = files.map(function (file) {
                        const item = createQueueRow(file.name, file.size);
                        item.file = file;
                        queueList.appendChild(item.row);
                        return item;
                    });

                    updateQueueEmptyState();

                    return items;
                }

                function setItemProgress(item, percent) {
                    item.bar.style.width = percent + '%';
                    item.statusEl.textContent = 'Uploading — ' + percent + '%';
                }

                function setItemStatus(item, text) {
                    item.statusEl.textContent = text;
                }

                async function uploadFile(item) {
                    const file = item.file;
                    const title = fileInput.files.length > 1 ? '' : titleInput.value;

                    setItemStatus(item, 'Uploading...');
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
                        };
                        item.transcodeWrapper.classList.remove('hidden');
                        item.transcodeStatusEl.textContent = 'Queued for processing...';

                        recordLogEntry(completeData.video_id, 'Uploading ' + file.name + '...', null, uploadStartTime);
                        recordLogEntry(completeData.video_id, 'Finishing upload for ' + file.name + '...', null, processingStartTime);
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
                            appendLog(item.file.name + ' uploaded successfully. (' + successCount + '/' + consideredCount + ')', 'text-blue-600 font-medium');
                            if (videoId) {
                                recordLogEntry(videoId, item.file.name + ' uploaded successfully. (' + successCount + '/' + consideredCount + ')', 'text-blue-600 font-medium', new Date().toLocaleTimeString());
                            }
                        } catch (err) {
                            setItemStatus(item, 'Error: ' + (err.message || 'An error occurred during upload.'));
                            appendLog(item.file.name + ' failed: ' + (err.message || 'An error occurred during upload.'));
                        }
                    }

                    submitButton.disabled = false;
                    fileInput.disabled = false;
                    isUploading = false;
                    uploadWarning.classList.add('hidden');

                    summaryBox.classList.remove('hidden');
                    appendLog('Upload finished: ' + successCount + '/' + consideredCount + ' succeeded.', 'text-blue-600 font-medium');
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

                function hydrateRecentLog() {
                    const cache = loadLogCache();
                    const dismissedIds = loadDismissedLog();

                    recentVideos.forEach(function (video) {
                        const idKey = String(video.id);
                        const cached = cache.entries[idKey];

                        if (cached && cached.length > 0) {
                            cached.forEach(function (entry) {
                                appendLog(entry.message, entry.logClass, entry.time);
                            });
                            return;
                        }

                        if (dismissedIds.includes(idKey)) {
                            return;
                        }

                        const name = video.title || video.original_filename;
                        appendLog(name + ' uploaded successfully.', 'text-blue-600 font-medium', video.created_at);

                        if (video.status === 'ready') {
                            appendLog(name + ' finished transcoding.', 'text-orange-600 font-medium', video.updated_at);
                        } else if (video.status === 'failed') {
                            appendLog(name + ' failed to process.', null, video.updated_at);
                        }
                    });
                }

                hydrateActiveVideos();
                hydrateRecentLog();

                function activeVideoIds() {
                    return Object.keys(uploadedVideos).filter(function (id) {
                        const v = uploadedVideos[id];
                        return v.status === 'pending' || v.status === 'processing';
                    });
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

                document.addEventListener('DOMContentLoaded', function () {
                    if (window.Echo) {
                        window.Echo.channel('videos').stopListening('.video.status-updated');
                        window.Echo.channel('videos').listen('.video.status-updated', function (e) {
                            applyStatusSnapshot({ id: e.videoId, status: e.status, stage: e.stage, progress: e.progress });
                        });
                    }

                    if (window.Echo && window.Echo.connector && window.Echo.connector.pusher) {
                        window.Echo.connector.pusher.connection.bind('state_change', function (states) {
                            console.log('[Echo] connection state changed:', states.previous, '->', states.current);

                            if (states.current === 'connected') {
                                reconnectAttempts = 0;

                                if (hasConnectedBefore) {
                                    resyncStatus();
                                }
                                hasConnectedBefore = true;
                            } else if (states.current === 'unavailable' || states.current === 'failed') {
                                reconnectAttempts++;

                                if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                                    appendLog('Lost real-time connection. Please reload the page to see the latest status.', 'text-red-600 font-medium');
                                    return;
                                }

                                const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

                                setTimeout(function () {
                                    window.Echo.connector.pusher.connect();
                                }, delay);
                            }
                        });
                    }
                });

                function applyStatusSnapshot(video) {
                    const entry = uploadedVideos[video.id];
                    if (!entry) {
                        return;
                    }

                    const item = entry.item;
                    const statusChanged = entry.status !== video.status;
                    const progressChanged = entry.progress !== video.progress;
                    const stageChanged = entry.stage !== video.stage;

                    if (!statusChanged && !progressChanged && !stageChanged) {
                        return;
                    }

                    entry.status = video.status;
                    entry.stage = video.stage;
                    entry.progress = video.progress;

                    let message = null;
                    let logClass = null;

                    if (video.status === 'pending') {
                        message = entry.title + ' is queued for processing.';
                        if (item) {
                            item.transcodeWrapper.classList.remove('hidden');
                            item.transcodeStatusEl.textContent = 'Queued for processing...';
                        }
                    } else if (video.status === 'processing') {
                        if (progressChanged || stageChanged) {
                            const statusText = formatStageStatus(video.stage, video.progress);
                            message = entry.title + ': ' + statusText;
                            if (item) {
                                item.transcodeWrapper.classList.remove('hidden');
                                item.transcodeBar.style.width = video.progress + '%';
                                item.transcodeStatusEl.textContent = statusText;
                            }
                        }
                    } else if (video.status === 'ready') {
                        message = entry.title + ' finished transcoding.';
                        logClass = 'text-orange-600 font-medium';
                        if (item) {
                            item.row.remove();
                            currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                            updateQueueEmptyState();
                        }
                    } else if (video.status === 'failed') {
                        message = entry.title + ' failed to process.';
                        if (item) {
                            item.row.remove();
                            currentQueueItems = currentQueueItems.filter(function (qi) { return qi !== item; });
                            updateQueueEmptyState();
                        }
                    }

                    if (message) {
                        appendLog(message, logClass);
                        recordLogEntry(video.id, message, logClass, new Date().toLocaleTimeString());
                    }
                }
            })();
        </script>
    @endpush
@endsection
