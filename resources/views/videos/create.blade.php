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
                     class="rounded-2xl border-2 border-dashed border-gray-300 px-6 py-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/40 transition-colors">
                    <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50">
                        <x-lucide-cloud-upload class="w-8 h-8 text-blue-700" />
                    </div>
                    <p class="text-sm text-gray-600 mb-3">Drag and drop video here, or</p>
                    <span class="pointer-events-none inline-flex items-center gap-2 rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
                        <x-lucide-upload class="w-4 h-4" /> Choose Video File
                    </span>
                </div>
                <p class="mt-1 text-xs text-gray-500">Formats: mp4, mov, mkv, avi, webm. Maximum size {{ config('videos.max_upload_size_mb') }} MB.</p>
                <div id="selected-files-list" class="mt-2 space-y-1 hidden"></div>
            </div>

            <div id="upload-error" class="hidden rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm"></div>

            <div id="upload-summary" class="hidden rounded-lg bg-gray-50 border border-gray-200 text-gray-800 px-4 py-3 text-sm">
                <p id="upload-summary-text"></p>
                <a href="{{ route('videos.index') }}" class="mt-2 inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
                    View Video List
                </a>
            </div>

            <button type="submit" id="upload-submit"
                    class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                Upload
            </button>

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
                <div class="bg-blue-50 border-b border-blue-100 px-4 py-2">
                    <h3 class="text-sm font-semibold text-blue-700 inline-flex items-center gap-2"><x-lucide-scroll-text class="w-4 h-4" /> Log</h3>
                </div>
                <div class="p-4">
                    <div id="upload-log" class="font-mono text-xs text-gray-600 space-y-1 max-h-40 overflow-y-auto">
                        <p class="text-gray-400" data-log-placeholder>Ready.</p>
                    </div>
                </div>
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
                const summaryText = document.getElementById('upload-summary-text');
                const logBox = document.getElementById('upload-log');

                const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
                const allowedExtensions = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
                const maxSizeBytes = parseInt(form.dataset.maxSizeMb, 10) * 1024 * 1024;
                const CHUNK_SIZE = parseInt(form.dataset.chunkSizeMb, 10) * 1024 * 1024;
                const FILE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3v-6Z"/></svg>';

                let currentQueueItems = [];

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
                    summaryText.textContent = '';
                }

                function appendLog(message, extraClass) {
                    const placeholder = logBox.querySelector('[data-log-placeholder]');
                    if (placeholder) {
                        placeholder.remove();
                    }
                    const time = new Date().toLocaleTimeString();
                    const line = document.createElement('p');
                    if (extraClass) {
                        line.className = extraClass;
                    }
                    line.textContent = '[' + time + '] ' + message;
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

                    files.forEach(function (file) {
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

                        row.appendChild(leftWrap);
                        row.appendChild(sizeEl);
                        selectedFilesList.appendChild(row);
                    });
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

                dropzone.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    dropzone.classList.add('border-blue-400', 'bg-blue-50/40');
                });

                dropzone.addEventListener('dragleave', function (e) {
                    e.preventDefault();
                    dropzone.classList.remove('border-blue-400', 'bg-blue-50/40');
                });

                dropzone.addEventListener('drop', function (e) {
                    e.preventDefault();
                    dropzone.classList.remove('border-blue-400', 'bg-blue-50/40');

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

                function updateQueueEmptyState() {
                    if (queueList.children.length === 0) {
                        queueEmptyPlaceholder.classList.remove('hidden');
                    } else {
                        queueEmptyPlaceholder.classList.add('hidden');
                    }
                }

                function buildQueueUI(files) {
                    queueList.innerHTML = '';

                    const items = files.map(function (file) {
                        const row = document.createElement('div');
                        row.className = 'rounded-lg border border-gray-200 p-3';

                        const header = document.createElement('div');
                        header.className = 'flex items-center justify-between text-sm';

                        const nameEl = document.createElement('span');
                        nameEl.className = 'font-medium text-gray-800 truncate mr-2';
                        nameEl.textContent = file.name;

                        const sizeEl = document.createElement('span');
                        sizeEl.className = 'text-gray-500 text-xs whitespace-nowrap';
                        sizeEl.textContent = formatSize(file.size);

                        header.appendChild(nameEl);
                        header.appendChild(sizeEl);

                        const barWrapper = document.createElement('div');
                        barWrapper.className = 'w-full bg-gray-200 rounded-full h-2.5 mt-2';

                        const bar = document.createElement('div');
                        bar.className = 'bg-blue-600 h-2.5 rounded-full';
                        bar.style.width = '0%';

                        barWrapper.appendChild(bar);

                        const statusEl = document.createElement('p');
                        statusEl.className = 'mt-1 text-xs text-gray-500';
                        statusEl.textContent = 'Pending';

                        row.appendChild(header);
                        row.appendChild(barWrapper);
                        row.appendChild(statusEl);
                        queueList.appendChild(row);

                        return {
                            file: file,
                            row: row,
                            bar: bar,
                            statusEl: statusEl,
                            cleared: false,
                        };
                    });

                    updateQueueEmptyState();

                    return items;
                }

                function setItemProgress(item, percent) {
                    item.bar.style.width = percent + '%';
                    item.statusEl.textContent = 'Uploading (' + percent + '%)';
                }

                function setItemStatus(item, text) {
                    item.statusEl.textContent = text;
                }

                async function uploadFile(item) {
                    const file = item.file;
                    const title = fileInput.files.length > 1 ? '' : titleInput.value;

                    setItemStatus(item, 'Uploading...');
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

                    setItemStatus(item, 'Processing...');
                    appendLog('Processing ' + file.name + '...');

                    await fetchWithRetry('/uploads/' + uploadId + '/complete', {
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

                    setItemStatus(item, 'Done');
                    appendLog(file.name + ' uploaded successfully.');
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

                    appendLog('Starting upload of ' + files.length + ' file(s).');

                    hideSelectedFilesList();

                    const items = buildQueueUI(files);
                    currentQueueItems = items;

                    let successCount = 0;

                    for (const item of items) {
                        if (item.cleared) {
                            continue;
                        }
                        try {
                            await uploadFile(item);
                            successCount++;
                        } catch (err) {
                            setItemStatus(item, 'Error: ' + (err.message || 'An error occurred during upload.'));
                            appendLog(item.file.name + ' failed: ' + (err.message || 'An error occurred during upload.'));
                        }
                    }

                    submitButton.disabled = false;
                    fileInput.disabled = false;

                    const consideredCount = items.filter(function (item) {
                        return !item.cleared;
                    }).length;

                    summaryText.textContent = 'Successfully uploaded ' + successCount + '/' + consideredCount + ' videos.';
                    summaryBox.classList.remove('hidden');
                    appendLog('Upload finished: ' + successCount + '/' + consideredCount + ' succeeded.', 'text-blue-600 font-medium');
                });
            })();
        </script>
    @endpush
@endsection
