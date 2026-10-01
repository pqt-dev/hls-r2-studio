@extends('layouts.app')

@section('title', 'Videos - HLS R2 Studio')
@section('page-title', 'Videos')
@section('breadcrumb', 'Home / Videos')

@section('content')
    <form method="GET" action="{{ route('videos.index') }}" class="mb-4 flex items-center gap-2">
        @if (request()->query('status'))
            <input type="hidden" name="status" value="{{ request()->query('status') }}">
        @endif
        <input type="text" name="search" value="{{ $search }}" placeholder="Search by video name or filename..."
               class="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
        <button type="submit"
                class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
            Search
        </button>
    </form>

    <div class="flex gap-2 mb-4 border-b border-gray-200">
        @php
            $tabs = [
                ['value' => null, 'label' => 'All'],
                ['value' => 'pending', 'label' => 'Pending'],
                ['value' => 'processing', 'label' => 'Processing'],
                ['value' => 'ready', 'label' => 'Completed'],
                ['value' => 'failed', 'label' => 'Failed'],
            ];
            $currentStatus = request()->query('status');
        @endphp
        @foreach ($tabs as $tab)
            <a href="{{ route('videos.index', array_filter(['status' => $tab['value'], 'search' => $search])) }}"
               class="px-3 py-2 text-sm font-medium border-b-2 {{ $currentStatus === $tab['value'] ? 'border-blue-700 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700' }}">
                {{ $tab['label'] }}
            </a>
        @endforeach
    </div>

    @if ($status)
        <div>
            @if ($filteredVideos->isEmpty())
                <div class="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
                    No videos found.
                </div>
            @else
                <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
                    <table class="min-w-full divide-y divide-gray-200 text-sm">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="w-10 px-3 py-2"></th>
                                <th class="px-3 py-2 text-left">Thumbnail</th>
                                <th class="px-3 py-2 text-left">Video Name</th>
                                <th class="px-3 py-2 text-left">Status</th>
                                <th class="px-3 py-2 text-left">Duration</th>
                                <th class="px-3 py-2 text-left">Size</th>
                                <th class="px-3 py-2 text-left">Source</th>
                                <th class="px-3 py-2 text-left">Details</th>
                                <th class="px-3 py-2 text-left">Upload Date</th>
                                <th class="px-3 py-2 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            @foreach ($filteredVideos as $video)
                                @include('videos._row', ['video' => $video])
                            @endforeach
                        </tbody>
                    </table>
                </div>
                <div class="mt-4">{{ $filteredVideos->appends(request()->query())->links() }}</div>
            @endif
        </div>
    @else
    @if ($activeVideos->isNotEmpty())
        <div class="mb-8">
            <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 inline-flex items-center gap-2"><x-lucide-loader-circle class="w-4 h-4 text-amber-500" /> Processing / Queue ({{ $activeVideos->count() }})</h2>
            <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
                <table class="min-w-full divide-y divide-gray-200 text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="w-10 px-3 py-2"></th>
                            <th class="px-3 py-2 text-left">Thumbnail</th>
                            <th class="px-3 py-2 text-left">Video Name</th>
                            <th class="px-3 py-2 text-left">Status</th>
                            <th class="px-3 py-2 text-left">Duration</th>
                            <th class="px-3 py-2 text-left">Size</th>
                            <th class="px-3 py-2 text-left">Source</th>
                            <th class="px-3 py-2 text-left">Details</th>
                            <th class="px-3 py-2 text-left">Upload Date</th>
                            <th class="px-3 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        @foreach ($activeVideos as $video)
                            @include('videos._row', ['video' => $video])
                        @endforeach
                    </tbody>
                </table>
            </div>
        </div>
    @endif

    <div>
        <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold text-gray-500 uppercase tracking-wide inline-flex items-center gap-2"><x-lucide-circle-check class="w-4 h-4 text-emerald-600" /> Completed</h2>
            <div class="flex items-center gap-3">
                <button type="button" onclick="if (window.softNav) { window.softNav.reload(); } else { window.location.reload(); }"
                        class="inline-flex items-center gap-2 rounded-lg bg-white border border-gray-200 shadow-sm px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                    <x-lucide-refresh-cw class="w-4 h-4" /> Refresh
                </button>
                @if ($completedVideos->isNotEmpty())
                    <button type="submit" form="bulk-delete-form" id="bulk-delete-btn" disabled
                            class="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed">
                        Delete Selected (<span id="selected-count">0</span>)
                    </button>
                @endif
            </div>
        </div>
        <form id="bulk-delete-form" action="{{ route('videos.bulk-destroy') }}" method="POST" onsubmit="return confirmBulkDelete()">
            @csrf
            @method('DELETE')
        </form>
        @if ($completedVideos->isEmpty())
            <div class="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
                No completed videos yet. <a href="{{ route('videos.create') }}" class="text-blue-700 underline">Upload your first video</a>.
            </div>
        @else
            <form method="GET" class="mb-3 flex items-center justify-end gap-2 text-xs text-gray-600">
                <label for="per_page">Videos per page:</label>
                <select name="per_page" id="per_page" onchange="this.form.submit()"
                        class="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-600">
                    @foreach ($allowedPerPage as $option)
                        <option value="{{ $option }}" @selected($perPage == $option)>{{ $option }}</option>
                    @endforeach
                </select>
            </form>
            <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
                <table class="min-w-full divide-y divide-gray-200 text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="w-10 px-3 py-2">
                                <input type="checkbox" id="select-all-checkbox" class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer">
                            </th>
                            <th class="px-3 py-2 text-left">Thumbnail</th>
                            <th class="px-3 py-2 text-left">Video Name</th>
                            <th class="px-3 py-2 text-left">Status</th>
                            <th class="px-3 py-2 text-left">Duration</th>
                            <th class="px-3 py-2 text-left">Size</th>
                            <th class="px-3 py-2 text-left">Source</th>
                            <th class="px-3 py-2 text-left">Details</th>
                            <th class="px-3 py-2 text-left">Upload Date</th>
                            <th class="px-3 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        @php $lastDate = null; @endphp
                        @foreach ($completedVideos as $video)
                            @php $currentDate = $video->created_at->toDisplay('d/m/Y'); @endphp
                            @if ($currentDate !== $lastDate)
                                @php $lastDate = $currentDate; @endphp
                                <tr>
                                    <td colspan="10" class="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-400 uppercase tracking-wide">{{ $currentDate }}</td>
                                </tr>
                            @endif
                            @include('videos._row', ['video' => $video, 'selectable' => true])
                        @endforeach
                    </tbody>
                </table>
            </div>
            <div class="mt-4">{{ $completedVideos->appends(request()->query())->links() }}</div>
        @endif
    </div>
    @endif

    <div id="embed-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/50 p-4">
        <div class="bg-white rounded-2xl overflow-hidden w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
            <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                <div>
                    <h3 class="text-base font-semibold text-gray-900">Player / Embed</h3>
                    <p id="embed-modal-title" class="text-xs text-gray-500"></p>
                </div>
                <button type="button" onclick="closeEmbedModal()" class="text-gray-400 hover:text-gray-600">
                    <x-lucide-x class="w-5 h-5" />
                </button>
            </div>

            <div class="p-5 space-y-4">
                <div class="rounded-xl overflow-hidden bg-black">
                    <iframe id="embed-modal-preview" class="w-full aspect-video" frameborder="0" allowfullscreen allow="autoplay; fullscreen"></iframe>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-700 mb-1">Embed URL</label>
                    <div class="flex gap-2">
                        <input id="embed-modal-url" type="text" readonly
                               class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 bg-gray-50">
                        <button type="button" onclick="copyModalField('embed-modal-url', this)"
                                class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100 shrink-0">
                            <x-lucide-copy class="w-3.5 h-3.5" /> Copy
                        </button>
                    </div>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-700 mb-1">Link m3u8 / play</label>
                    <div class="flex gap-2">
                        <input id="embed-modal-m3u8" type="text" readonly
                               class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 bg-gray-50">
                        <button type="button" onclick="copyModalField('embed-modal-m3u8', this)"
                                class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100 shrink-0">
                            <x-lucide-copy class="w-3.5 h-3.5" /> Copy
                        </button>
                    </div>
                </div>

                <div>
                    <div class="flex items-center justify-between mb-1">
                        <label class="block text-xs font-medium text-gray-700">Iframe code</label>
                        <div class="flex items-center gap-3 text-xs text-gray-600">
                            <label class="inline-flex items-center gap-1.5">
                                <input id="embed-modal-mute" type="checkbox" class="rounded text-blue-600 focus:ring-blue-500">
                                Mute
                            </label>
                            <label class="inline-flex items-center gap-1.5">
                                <input id="embed-modal-autoplay" type="checkbox" class="rounded text-blue-600 focus:ring-blue-500">
                                Autoplay
                            </label>
                        </div>
                    </div>
                    <textarea id="embed-modal-code" readonly rows="3"
                              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono text-gray-700 bg-gray-50 resize-none"></textarea>
                    <p class="mt-1 text-xs text-gray-400">Browsers may block autoplay with sound unless Mute is also enabled.</p>
                    <button type="button" onclick="copyModalField('embed-modal-code', this)"
                            class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800">
                        <x-lucide-copy class="w-3.5 h-3.5" /> Copy Iframe Code
                    </button>
                </div>
            </div>
        </div>
    </div>

    <div id="preview-modal" class="fixed inset-0 z-50 hidden overflow-y-auto bg-black/70 p-4">
        <div class="bg-white rounded-xl overflow-hidden w-full max-w-4xl mx-auto my-8 flex flex-col">
            <div class="flex items-center justify-between px-4 py-2 bg-gray-900 text-white sticky top-0">
                <span id="preview-modal-title" class="text-sm font-medium"></span>
                <button type="button" onclick="closePreviewModal()" class="text-gray-300 hover:text-white">
                    <x-lucide-x class="w-5 h-5" />
                </button>
            </div>
            <div id="preview-modal-body" class="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4"></div>
        </div>
    </div>

    <div id="edit-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/70 p-4">
        <div class="bg-white rounded-xl overflow-hidden w-full max-w-md">
            <div class="flex items-center justify-between px-4 py-2 bg-gray-900 text-white">
                <span class="text-sm font-medium">Edit video</span>
                <button type="button" onclick="closeEditModal()" class="text-gray-300 hover:text-white">
                    <x-lucide-x class="w-5 h-5" />
                </button>
            </div>
            <form id="edit-modal-form" method="POST" class="p-4 space-y-4">
                @csrf
                @method('PUT')
                <div>
                    <label for="edit-modal-title" class="block text-xs font-medium text-gray-700 mb-1">Title</label>
                    <input type="text" name="title" id="edit-modal-title" required maxlength="255"
                           class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                </div>
                <div class="flex justify-end gap-2">
                    <button type="button" onclick="closeEditModal()"
                            class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                        Cancel
                    </button>
                    <button type="submit"
                            class="rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700">
                        Save
                    </button>
                </div>
            </form>
        </div>
    </div>
@endsection

@push('scripts')
    <script>
        (function () {
            let statusRefreshTimer = null;

            // Called by the soft-navigation module right before this page is
            // swapped out, so the refresh timer never accumulates.
            window.__pageCleanup = function () {
                if (statusRefreshTimer !== null) {
                    clearInterval(statusRefreshTimer);
                    statusRefreshTimer = null;
                }
            };

            function confirmDelete(form) {
                const message = @json($deleteFromR2 ? 'Delete this video? The file on Cloudflare R2 will also be PERMANENTLY deleted and cannot be recovered!' : 'Delete this video?');
                if (!confirm(message)) return false;
                const btn = form.querySelector('button[type="submit"]');
                btn.disabled = true;
                btn.textContent = 'Deleting...';
                btn.classList.add('opacity-60', 'cursor-not-allowed');
                return true;
            }

            let embedModalState = null;

            function buildEmbedIframeCode(embedUrl, aspectRatio, muted, autoplay) {
                const params = [];
                if (autoplay) params.push('autoplay=1');
                if (muted) params.push('muted=1');
                const src = embedUrl + (params.length ? '?' + params.join('&') : '');
                return '<iframe src="' + src + '" style="width:100%; aspect-ratio:' + aspectRatio + '; max-height:60vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>';
            }

            function refreshEmbedModal() {
                if (!embedModalState) return;
                const muted = document.getElementById('embed-modal-mute').checked;
                const autoplay = document.getElementById('embed-modal-autoplay').checked;

                const params = [];
                if (autoplay) params.push('autoplay=1');
                if (muted) params.push('muted=1');
                const previewSrc = embedModalState.embedUrl + (params.length ? '?' + params.join('&') : '');

                document.getElementById('embed-modal-preview').src = previewSrc;
                document.getElementById('embed-modal-code').value = buildEmbedIframeCode(embedModalState.embedUrl, embedModalState.aspectRatio, muted, autoplay);
            }

            function openEmbedModal(embedUrl, publicUrl, aspectRatio, title) {
                embedModalState = { embedUrl: embedUrl, aspectRatio: aspectRatio };

                document.getElementById('embed-modal-title').textContent = title;
                document.getElementById('embed-modal-url').value = embedUrl;
                document.getElementById('embed-modal-m3u8').value = publicUrl;
                document.getElementById('embed-modal-mute').checked = false;
                document.getElementById('embed-modal-autoplay').checked = false;

                refreshEmbedModal();

                const modal = document.getElementById('embed-modal');
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }

            function closeEmbedModal() {
                document.getElementById('embed-modal-preview').src = '';
                embedModalState = null;

                const modal = document.getElementById('embed-modal');
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }

            function copyModalField(elementId, button) {
                const el = document.getElementById(elementId);
                navigator.clipboard.writeText(el.value);

                const originalHTML = button.innerHTML;
                button.innerHTML = originalHTML.replace(/Copy.*/, 'Copied!');

                setTimeout(function () {
                    button.innerHTML = originalHTML;
                }, 1500);
            }

            function openPreviewModal(images, title) {
                const modal = document.getElementById('preview-modal');
                const body = document.getElementById('preview-modal-body');
                document.getElementById('preview-modal-title').textContent = title;
                body.innerHTML = '';

                images.forEach(function (image) {
                    const card = document.createElement('div');
                    card.className = 'flex flex-col rounded-lg border border-gray-200 overflow-hidden';

                    const label = document.createElement('div');
                    label.className = 'px-3 py-2 bg-gray-50 text-xs font-medium text-gray-600';
                    label.textContent = image.label;

                    const link = document.createElement('a');
                    link.href = image.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.className = 'block bg-gray-100';

                    const img = document.createElement('img');
                    img.src = image.url;
                    img.alt = image.label;
                    img.loading = 'lazy';
                    img.className = 'w-full h-56 object-contain';
                    link.appendChild(img);

                    const actions = document.createElement('div');
                    actions.className = 'px-3 py-2 border-t border-gray-200';

                    const copyButton = document.createElement('button');
                    copyButton.type = 'button';
                    copyButton.className = 'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100';
                    copyButton.textContent = 'Copy Link';
                    copyButton.addEventListener('click', function () {
                        copyThumbnailUrl(copyButton, image.url);
                    });

                    actions.appendChild(copyButton);
                    card.appendChild(label);
                    card.appendChild(link);
                    card.appendChild(actions);
                    body.appendChild(card);
                });

                modal.classList.remove('hidden');
            }

            function closePreviewModal() {
                const modal = document.getElementById('preview-modal');
                document.getElementById('preview-modal-body').innerHTML = '';
                modal.classList.add('hidden');
            }

            function openEditModal(videoId, title) {
                const modal = document.getElementById('edit-modal');
                const form = document.getElementById('edit-modal-form');
                form.action = '/videos/' + videoId;
                document.getElementById('edit-modal-title').value = title;
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }

            function closeEditModal() {
                const modal = document.getElementById('edit-modal');
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }

            function copyThumbnailUrl(button, url) {
                navigator.clipboard.writeText(url);

                const originalClasses = ['border-gray-200', 'bg-gray-50', 'text-gray-700'];
                const successClasses = ['border-emerald-300', 'bg-emerald-50', 'text-emerald-700'];

                button.classList.remove(...originalClasses);
                button.classList.add(...successClasses);

                setTimeout(function () {
                    button.classList.remove(...successClasses);
                    button.classList.add(...originalClasses);
                }, 1500);
            }

            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
            const selectedCountEl = document.getElementById('selected-count');

            function updateBulkDeleteState() {
                const checked = document.querySelectorAll('.bulk-select-checkbox:checked');
                selectedCountEl.textContent = checked.length;
                bulkDeleteBtn.disabled = checked.length === 0;
            }

            document.querySelectorAll('.bulk-select-checkbox').forEach(function (cb) {
                cb.addEventListener('change', updateBulkDeleteState);
            });

            if (selectAllCheckbox) {
                selectAllCheckbox.addEventListener('change', function () {
                    document.querySelectorAll('.bulk-select-checkbox').forEach(function (cb) {
                        cb.checked = selectAllCheckbox.checked;
                    });
                    updateBulkDeleteState();
                });
            }

            function confirmBulkDelete() {
                const count = document.querySelectorAll('.bulk-select-checkbox:checked').length;
                const message = @json($deleteFromR2 ? 'Delete {COUNT} selected videos? The files on Cloudflare R2 will also be PERMANENTLY deleted and cannot be recovered!' : 'Delete {COUNT} selected videos?');
                return confirm(message.replace('{COUNT}', count));
            }

            @if ($hasActive)
                statusRefreshTimer = setInterval(function () {
                    // Refresh in place instead of reloading the document, so
                    // an upload running in this tab is not aborted.
                    if (window.softNav) {
                        window.softNav.reload();
                    }
                }, 5000);
            @endif

            document.getElementById('embed-modal-mute').addEventListener('change', refreshEmbedModal);
            document.getElementById('embed-modal-autoplay').addEventListener('change', refreshEmbedModal);

            // Exposed globally because they are referenced from inline
            // onclick/onsubmit attributes in the markup.
            window.confirmDelete = confirmDelete;
            window.confirmBulkDelete = confirmBulkDelete;
            window.openPreviewModal = openPreviewModal;
            window.closePreviewModal = closePreviewModal;
            window.openEditModal = openEditModal;
            window.closeEditModal = closeEditModal;
            window.copyThumbnailUrl = copyThumbnailUrl;
            window.openEmbedModal = openEmbedModal;
            window.closeEmbedModal = closeEmbedModal;
            window.copyModalField = copyModalField;
        })();
    </script>
@endpush
