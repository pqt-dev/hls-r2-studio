@extends('layouts.app')

@section('title', 'Videos - HLS R2 Studio')
@section('page-title', 'Videos')
@section('breadcrumb', 'Home / Videos')

@section('content')
    <form method="GET" action="{{ route('videos.index') }}" class="relative mb-4 flex flex-wrap items-center gap-2">
        <input type="text" name="search" value="{{ $search }}" placeholder="Search by video name or filename..."
               class="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
        <button type="submit"
                class="inline-flex items-center rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700">
            Search
        </button>

        <input type="hidden" name="range" id="date-filter-range-input" value="{{ $range }}">
        <input type="hidden" name="date_from" id="date-filter-from-input" value="{{ $dateFromInput }}">
        <input type="hidden" name="date_to" id="date-filter-to-input" value="{{ $dateToInput }}">

        <div id="date-filter" class="md:relative">
            <button type="button" id="date-filter-toggle"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <span id="date-filter-label">{{ $rangeLabel }}</span>
                <x-lucide-chevron-down class="w-4 h-4" />
            </button>

            <div id="date-filter-panel" class="hidden absolute left-0 z-20 mt-1 w-full md:w-60 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                <ul class="text-sm text-gray-700">
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="all">All time</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="custom">Custom</button></li>
                    <li class="my-1 border-t border-gray-200"></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="today">Today</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="yesterday">Yesterday</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="this_week">This week (Sun - Today)</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="last_7_days">Last 7 days</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="last_week">Last week (Sun - Sat)</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="last_28_days">Last 28 days</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="last_30_days">Last 30 days</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="this_month">This month</button></li>
                    <li><button type="button" class="date-filter-option w-full rounded-md px-3 py-1.5 text-left hover:bg-gray-50" data-range="last_month">Last month</button></li>
                </ul>

                <div id="date-filter-custom-panel" class="hidden border-t border-gray-200 p-2 space-y-2">
                    <div>
                        <label for="date-filter-custom-from" class="block text-xs font-medium text-gray-700 mb-1">From</label>
                        <input type="date" id="date-filter-custom-from" value="{{ $dateFromInput }}"
                               class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
                    </div>
                    <div>
                        <label for="date-filter-custom-to" class="block text-xs font-medium text-gray-700 mb-1">To</label>
                        <input type="date" id="date-filter-custom-to" value="{{ $dateToInput }}"
                               class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
                    </div>
                    <button type="button" id="date-filter-custom-apply"
                            class="w-full rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-3 py-1.5 text-sm font-medium text-blue-700">
                        Apply
                    </button>
                </div>
            </div>
        </div>
    </form>

    <div>
        <div class="flex items-center justify-end mb-3">
            <div class="flex items-center gap-3">
                @if ($completedVideos->isNotEmpty())
                    <button type="submit" form="bulk-delete-form" id="bulk-delete-btn" disabled
                            class="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 md:py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed">
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
            <form method="GET" class="mb-3 flex flex-wrap items-center justify-between max-md:justify-start gap-2 md:text-xs text-sm text-gray-600">
                <span>{{ $completedVideos->total() }} {{ Str::plural('video', $completedVideos->total()) }}</span>
                <div class="flex items-center gap-2">
                    <input type="hidden" name="search" value="{{ request()->query('search') }}">
                    <input type="hidden" name="range" value="{{ request()->query('range') }}">
                    <input type="hidden" name="date_from" value="{{ request()->query('date_from') }}">
                    <input type="hidden" name="date_to" value="{{ request()->query('date_to') }}">
                    <label for="per_page" class="shrink-0">Videos per page:</label>
                    <select name="per_page" id="per_page" onchange="this.form.submit()"
                            class="w-auto rounded-lg border border-gray-300 px-2 max-md:py-2 md:py-1 text-base md:text-xs focus:outline-none focus:ring-2 focus:ring-blue-600">
                        @foreach ($allowedPerPage as $option)
                            <option value="{{ $option }}" @selected($perPage == $option)>{{ $option }}</option>
                        @endforeach
                    </select>
                </div>
            </form>
            <div class="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
                {{-- mobile-card:start (below md the table is restyled as stacked cards via max-md:* classes; thead keeps only the select-all control) --}}
                <table class="min-w-full divide-y divide-gray-200 text-sm max-md:block">
                    <thead class="bg-gray-50 max-md:block">
                        <tr class="max-md:flex max-md:items-center">
                            <th class="w-10 px-3 py-2 max-md:flex max-md:w-auto max-md:items-center max-md:gap-2">
                                <input type="checkbox" id="select-all-checkbox" class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer">
                                <label for="select-all-checkbox" class="md:hidden text-left text-sm font-medium text-gray-700 cursor-pointer">Select all</label>
                            </th>
                            <th class="px-3 py-2 text-left max-md:hidden">Thumbnail</th>
                            <th class="px-3 py-2 text-left max-md:hidden">Video Name</th>
                            <th class="px-3 py-2 text-left max-md:hidden">Status</th>
                            <th class="hidden md:table-cell px-3 py-2 text-left">Duration</th>
                            <th class="hidden md:table-cell px-3 py-2 text-left">Size</th>
                            <th class="hidden md:table-cell px-3 py-2 text-left">Source</th>
                            <th class="hidden md:table-cell px-3 py-2 text-left">Details</th>
                            <th class="hidden md:table-cell px-3 py-2 text-left">Upload Date</th>
                            <th class="px-3 py-2 text-right max-md:hidden">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100 max-md:block">
                        @foreach ($completedVideos as $video)
                            @include('videos._row', ['video' => $video, 'selectable' => true])
                        @endforeach
                    </tbody>
                </table>
                {{-- mobile-card:end --}}
            </div>
            <div class="mt-4">{{ $completedVideos->appends(request()->query())->links('partials.pagination') }}</div>
        @endif
    </div>

    <div id="embed-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/50 md:p-4">
        {{-- tabs:start (below md the dialog is a full-screen sheet; header and tab bar stay fixed, body scrolls) --}}
        <div class="bg-white w-full max-w-2xl shadow-xl max-md:flex max-md:h-[100dvh] max-md:max-h-none max-md:max-w-none max-md:flex-col max-md:overflow-hidden md:rounded-2xl md:overflow-hidden md:max-h-[90vh] md:overflow-y-auto">
        {{-- tabs:end --}}
            <div class="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-gray-200 max-md:shrink-0">
                <div class="min-w-0">
                    <h3 class="text-base font-semibold text-gray-900">Player / Embed &amp; Images</h3>
                    <p id="embed-modal-title" class="text-xs text-gray-500 break-words"></p>
                </div>
                <button type="button" onclick="closeEmbedModal()" class="shrink-0 p-2 -m-2 text-gray-400 hover:text-gray-600">
                    <x-lucide-x class="w-5 h-5" />
                </button>
            </div>

            {{-- tabs:start --}}
            <div role="tablist" aria-label="Embed sections" id="embed-tablist" class="md:hidden flex shrink-0 border-b border-gray-200 bg-white">
                <button type="button" role="tab" id="embed-tab-preview" data-tab="preview" aria-selected="true" aria-controls="embed-panel-preview"
                        class="embed-tab flex-1 min-h-[44px] px-3 text-sm font-medium border-b-2 border-blue-600 text-blue-700">Preview</button>
                <button type="button" role="tab" id="embed-tab-links" data-tab="links" aria-selected="false" aria-controls="embed-panel-links" tabindex="-1"
                        class="embed-tab flex-1 min-h-[44px] px-3 text-sm font-medium border-b-2 border-transparent text-gray-600 hover:text-gray-900">Links &amp; Code</button>
                <button type="button" role="tab" id="embed-tab-images" data-tab="images" aria-selected="false" aria-controls="embed-modal-images-section" tabindex="-1"
                        class="embed-tab hidden flex-1 min-h-[44px] px-3 text-sm font-medium border-b-2 border-transparent text-gray-600 hover:text-gray-900">Images</button>
            </div>
            {{-- tabs:end --}}

            <div class="p-4 sm:p-5 md:space-y-4 max-md:min-h-0 max-md:flex-1 max-md:overflow-y-auto">
                {{-- tabs:start --}}
                <div id="embed-panel-preview" role="tabpanel" aria-labelledby="embed-tab-preview" class="rounded-xl overflow-hidden bg-black">
                {{-- tabs:end --}}
                    <iframe id="embed-modal-preview" class="block w-full mx-auto" style="max-height:45vh; border:0;" frameborder="0" allowfullscreen allow="autoplay; fullscreen"></iframe>
                </div>

                {{-- tabs:start --}}
                <div id="embed-panel-links" role="tabpanel" aria-labelledby="embed-tab-links" class="space-y-4 max-md:hidden">
                {{-- tabs:end --}}
                <div>
                    <label class="block text-xs font-medium text-gray-700 mb-1">Embed URL</label>
                    <div class="flex gap-2">
                        <input id="embed-modal-url" type="text" readonly
                               class="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 bg-gray-50">
                        <button type="button" onclick="copyModalField('embed-modal-url', this)"
                                class="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100 shrink-0">
                            <x-lucide-copy class="w-3.5 h-3.5" /> Copy
                        </button>
                    </div>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-700 mb-1">Link m3u8 / play</label>
                    <div class="flex gap-2">
                        <input id="embed-modal-m3u8" type="text" readonly
                               class="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 bg-gray-50">
                        <button type="button" onclick="copyModalField('embed-modal-m3u8', this)"
                                class="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100 shrink-0">
                            <x-lucide-copy class="w-3.5 h-3.5" /> Copy
                        </button>
                    </div>
                </div>

                <div>
                    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1">
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
                            class="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
                        <x-lucide-copy class="w-3.5 h-3.5" /> Copy Iframe Code
                    </button>
                </div>
                {{-- tabs:start --}}
                </div>
                {{-- tabs:end --}}

                <div id="embed-modal-images-section" role="tabpanel" aria-labelledby="embed-tab-images" class="hidden max-md:hidden">
                    <label class="block text-xs font-medium text-gray-700 mb-1">Images</label>
                    <div id="embed-modal-images" class="grid grid-cols-2 gap-3"></div>
                </div>
            </div>
        </div>
    </div>

    <div id="edit-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/70 p-4">
        <div class="bg-white rounded-xl overflow-hidden w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div class="flex items-center justify-between px-4 py-2 bg-gray-900 text-white">
                <span class="text-sm font-medium">Edit video</span>
                <button type="button" onclick="closeEditModal()" class="shrink-0 p-2 -m-2 text-gray-300 hover:text-white">
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
                            class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 md:py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                        Cancel
                    </button>
                    <button type="submit"
                            class="rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 px-3 py-2 md:py-1.5 text-xs font-medium text-blue-700">
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
            function confirmDelete(form, title) {
                const suffix = @json($deleteFromR2 ? ' The file on Cloudflare R2 will also be PERMANENTLY deleted and cannot be recovered!' : '');
                window.confirmDialog({
                    title: 'Delete video',
                    messageParts: [
                        { text: 'Delete ' },
                        { text: title, bold: true },
                        { text: '?' + suffix }
                    ],
                    confirmText: 'Delete',
                    danger: true
                }).then(function (ok) {
                    if (!ok) return;
                    const btn = form.querySelector('button[type="submit"]');
                    btn.disabled = true;
                    btn.textContent = 'Deleting...';
                    btn.classList.add('opacity-60', 'cursor-not-allowed');
                    form.submit();
                });
                return false;
            }

            let embedModalState = null;

            function buildEmbedIframeCode(embedUrl, aspectRatio, muted, autoplay) {
                const params = [];
                if (autoplay) params.push('autoplay=1');
                if (muted) params.push('muted=1');
                const src = embedUrl + (params.length ? '?' + params.join('&') : '');
                return '<iframe src="' + src + '" style="width:100%; aspect-ratio:' + aspectRatio + '; max-height:45vh; border:0;" allowfullscreen allow="autoplay; fullscreen"></iframe>';
            }

            function refreshEmbedModal() {
                if (!embedModalState) return;
                const muted = document.getElementById('embed-modal-mute').checked;
                const autoplay = document.getElementById('embed-modal-autoplay').checked;

                const params = [];
                if (autoplay) params.push('autoplay=1');
                if (muted) params.push('muted=1');
                const previewSrc = embedModalState.embedUrl + (params.length ? '?' + params.join('&') : '');

                const previewFrame = document.getElementById('embed-modal-preview');
                previewFrame.style.aspectRatio = embedModalState.aspectRatio;
                previewFrame.src = previewSrc;
                document.getElementById('embed-modal-code').value = buildEmbedIframeCode(embedModalState.embedUrl, embedModalState.aspectRatio, muted, autoplay);
            }

            function buildImageCard(image) {
                const card = document.createElement('div');
                card.className = 'flex flex-col min-w-0 rounded-lg border border-gray-200 overflow-hidden';

                const label = document.createElement('div');
                label.className = 'px-3 py-2 bg-gray-50 text-xs font-medium text-gray-600 truncate';
                label.textContent = image.label;

                const link = document.createElement('a');
                link.href = image.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.className = 'block aspect-square overflow-hidden bg-gray-100';

                const img = document.createElement('img');
                img.src = image.url;
                img.alt = image.label;
                img.loading = 'lazy';
                img.className = 'w-full h-full object-cover';
                link.appendChild(img);

                const actions = document.createElement('div');
                actions.className = 'flex justify-center px-3 py-2 border-t border-gray-200';

                const copyButton = document.createElement('button');
                copyButton.type = 'button';
                copyButton.className = 'inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 md:py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100';
                copyButton.textContent = 'Copy Link';
                copyButton.addEventListener('click', function () {
                    copyThumbnailUrl(copyButton, image.url);
                });

                actions.appendChild(copyButton);
                card.appendChild(label);
                card.appendChild(link);
                card.appendChild(actions);
                return card;
            }

            // tabs:start
            const embedTabPanels = { preview: 'embed-panel-preview', links: 'embed-panel-links', images: 'embed-modal-images-section' };

            function setEmbedTab(name) {
                const imagesSection = document.getElementById('embed-modal-images-section');
                const imagesTab = document.getElementById('embed-tab-images');
                const hasImages = imagesSection.classList.contains('hidden') === false;
                imagesTab.classList.toggle('hidden', !hasImages);
                if (name === 'images' && !hasImages) name = 'preview';

                Object.keys(embedTabPanels).forEach(function (key) {
                    const active = key === name;
                    const tab = document.getElementById('embed-tab-' + key);
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                    tab.tabIndex = active ? 0 : -1;
                    tab.classList.toggle('border-blue-600', active);
                    tab.classList.toggle('text-blue-700', active);
                    tab.classList.toggle('border-transparent', !active);
                    tab.classList.toggle('text-gray-600', !active);
                    document.getElementById(embedTabPanels[key]).classList.toggle('max-md:hidden', !active);
                });
            }

            document.querySelectorAll('#embed-tablist .embed-tab').forEach(function (tab) {
                tab.addEventListener('click', function () {
                    setEmbedTab(tab.getAttribute('data-tab'));
                });
            });

            document.getElementById('embed-tablist').addEventListener('keydown', function (event) {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                const tabs = Array.prototype.filter.call(this.querySelectorAll('.embed-tab'), function (t) {
                    return !t.classList.contains('hidden');
                });
                const index = tabs.indexOf(document.activeElement);
                if (index === -1) return;
                event.preventDefault();
                const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                setEmbedTab(next.getAttribute('data-tab'));
                next.focus();
            });
            // tabs:end

            function openEmbedModal(embedUrl, publicUrl, aspectRatio, title, images) {
                embedModalState = { embedUrl: embedUrl, aspectRatio: aspectRatio };

                document.getElementById('embed-modal-title').textContent = title;
                document.getElementById('embed-modal-url').value = embedUrl;
                document.getElementById('embed-modal-m3u8').value = publicUrl;
                document.getElementById('embed-modal-mute').checked = false;
                document.getElementById('embed-modal-autoplay').checked = false;

                refreshEmbedModal();

                const imagesSection = document.getElementById('embed-modal-images-section');
                const imagesGrid = document.getElementById('embed-modal-images');
                imagesGrid.innerHTML = '';
                (images || []).forEach(function (image) {
                    imagesGrid.appendChild(buildImageCard(image));
                });
                imagesSection.classList.toggle('hidden', !(images && images.length));
                setEmbedTab('preview'); // tabs

                const modal = document.getElementById('embed-modal');
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }

            function closeEmbedModal() {
                document.getElementById('embed-modal-preview').src = '';
                embedModalState = null;
                document.getElementById('embed-modal-images').innerHTML = '';
                document.getElementById('embed-modal-images-section').classList.add('hidden');
                setEmbedTab('preview'); // tabs

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

                const originalClasses = ['border-blue-200', 'bg-blue-50', 'text-blue-700', 'hover:bg-blue-100'];
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
                window.confirmDialog({ title: 'Delete selected videos', message: message.replace('{COUNT}', count), confirmText: 'Delete', danger: true }).then(function (ok) {
                    if (!ok) return;
                    document.getElementById('bulk-delete-form').submit();
                });
                return false;
            }

            const embedModalOverlay = document.getElementById('embed-modal');
            let embedModalMouseDownOnOverlay = false;
            embedModalOverlay.addEventListener('mousedown', function (event) {
                embedModalMouseDownOnOverlay = event.target === embedModalOverlay;
            });
            embedModalOverlay.addEventListener('click', function (event) {
                if (event.target === embedModalOverlay && embedModalMouseDownOnOverlay) {
                    closeEmbedModal();
                }
                embedModalMouseDownOnOverlay = false;
            });

            document.getElementById('embed-modal-mute').addEventListener('change', refreshEmbedModal);
            document.getElementById('embed-modal-autoplay').addEventListener('change', refreshEmbedModal);

            const dateFilter = document.getElementById('date-filter');
            const dateFilterToggle = document.getElementById('date-filter-toggle');
            const dateFilterPanel = document.getElementById('date-filter-panel');
            const dateFilterCustomPanel = document.getElementById('date-filter-custom-panel');
            const dateFilterRangeInput = document.getElementById('date-filter-range-input');
            const dateFilterFromInput = document.getElementById('date-filter-from-input');
            const dateFilterToInput = document.getElementById('date-filter-to-input');
            const dateFilterCustomFrom = document.getElementById('date-filter-custom-from');
            const dateFilterCustomTo = document.getElementById('date-filter-custom-to');
            const dateFilterCustomApply = document.getElementById('date-filter-custom-apply');

            function openDateFilterPanel() {
                dateFilterPanel.classList.remove('hidden');
            }

            function closeDateFilterPanel() {
                dateFilterPanel.classList.add('hidden');
                dateFilterCustomPanel.classList.add('hidden');
            }

            if (dateFilterToggle) {
                dateFilterToggle.addEventListener('click', function () {
                    if (dateFilterPanel.classList.contains('hidden')) {
                        openDateFilterPanel();
                    } else {
                        closeDateFilterPanel();
                    }
                });

                document.querySelectorAll('.date-filter-option').forEach(function (option) {
                    option.addEventListener('click', function () {
                        const range = option.getAttribute('data-range');

                        if (range === 'custom') {
                            dateFilterCustomPanel.classList.remove('hidden');
                            return;
                        }

                        dateFilterRangeInput.value = range;
                        dateFilterFromInput.value = '';
                        dateFilterToInput.value = '';
                        dateFilterToggle.closest('form').submit();
                    });
                });

                dateFilterCustomApply.addEventListener('click', function () {
                    if (!dateFilterCustomFrom.value || !dateFilterCustomTo.value) {
                        return;
                    }

                    dateFilterRangeInput.value = 'custom';
                    dateFilterFromInput.value = dateFilterCustomFrom.value;
                    dateFilterToInput.value = dateFilterCustomTo.value;
                    dateFilterToggle.closest('form').submit();
                });

                document.addEventListener('click', function (event) {
                    if (!dateFilter.contains(event.target)) {
                        closeDateFilterPanel();
                    }
                });
            }

            // Exposed globally because they are referenced from inline
            // onclick/onsubmit attributes in the markup.
            window.confirmDelete = confirmDelete;
            window.confirmBulkDelete = confirmBulkDelete;
            window.openEditModal = openEditModal;
            window.closeEditModal = closeEditModal;
            window.copyThumbnailUrl = copyThumbnailUrl;
            window.openEmbedModal = openEmbedModal;
            window.closeEmbedModal = closeEmbedModal;
            window.copyModalField = copyModalField;
        })();
    </script>
@endpush
