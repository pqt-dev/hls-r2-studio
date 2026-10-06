@extends('layouts.app')

@section('title', 'Videos - HLS R2 Studio')
@section('page-title', 'Videos')
@section('breadcrumb', 'Home / Videos')

@section('content')
    <form method="GET" action="{{ route('videos.index') }}" class="relative mb-4 flex flex-wrap items-center gap-2">
        <x-ui.input type="text" name="search" value="{{ $search }}" placeholder="Search by video name or filename..." class="max-w-sm" />
        <x-ui.button type="submit">
            Search
        </x-ui.button>

        <input type="hidden" name="range" id="date-filter-range-input" value="{{ $range }}">
        <input type="hidden" name="date_from" id="date-filter-from-input" value="{{ $dateFromInput }}">
        <input type="hidden" name="date_to" id="date-filter-to-input" value="{{ $dateToInput }}">

        <x-ui.dropdown-menu id="date-filter" class="md:relative" panel-id="date-filter-panel" panel-class="w-full md:w-60">
            <x-slot:trigger>
                <x-ui.button variant="outline" id="date-filter-toggle" data-dropdown-trigger aria-haspopup="menu" aria-expanded="false">
                    <span id="date-filter-label">{{ $rangeLabel }}</span>
                    <x-lucide-chevron-down class="w-4 h-4" />
                </x-ui.button>
            </x-slot:trigger>

            <x-ui.dropdown-menu-item class="date-filter-option" data-range="all">All time</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="custom">Custom</x-ui.dropdown-menu-item>
            <div role="separator" class="-mx-1 my-1 h-px bg-border"></div>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="today">Today</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="yesterday">Yesterday</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="this_week">This week (Sun - Today)</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="last_7_days">Last 7 days</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="last_week">Last week (Sun - Sat)</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="last_28_days">Last 28 days</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="last_30_days">Last 30 days</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="this_month">This month</x-ui.dropdown-menu-item>
            <x-ui.dropdown-menu-item class="date-filter-option" data-range="last_month">Last month</x-ui.dropdown-menu-item>

            <div id="date-filter-custom-panel" class="hidden border-t border-border p-2 space-y-2">
                <div class="space-y-2">
                    <x-ui.label for="date-filter-custom-from" class="block">From</x-ui.label>
                    <x-ui.input type="date" id="date-filter-custom-from" value="{{ $dateFromInput }}" />
                </div>
                <div class="space-y-2">
                    <x-ui.label for="date-filter-custom-to" class="block">To</x-ui.label>
                    <x-ui.input type="date" id="date-filter-custom-to" value="{{ $dateToInput }}" />
                </div>
                <x-ui.button size="sm" class="w-full" id="date-filter-custom-apply">
                    Apply
                </x-ui.button>
            </div>
        </x-ui.dropdown-menu>
    </form>

    <div>
        <div class="flex items-center justify-end mb-3">
            <div class="flex items-center gap-3">
                @if ($completedVideos->isNotEmpty())
                    <x-ui.button variant="destructive-outline" size="sm" type="submit" form="bulk-delete-form" id="bulk-delete-btn" disabled>
                        <x-lucide-trash-2 class="w-3.5 h-3.5" /> Delete<span hidden>&nbsp;(<span id="selected-count">0</span>)</span>
                    </x-ui.button>
                @endif
            </div>
        </div>
        <form id="bulk-delete-form" action="{{ route('videos.bulk-destroy') }}" method="POST" onsubmit="return confirmBulkDelete()">
            @csrf
            @method('DELETE')
        </form>
        @if ($completedVideos->isEmpty())
            <div class="rounded-lg border border-dashed border-input bg-background p-10 text-center text-muted-foreground">
                No completed videos yet. <a href="{{ route('videos.create') }}" class="text-foreground underline underline-offset-2">Upload your first video</a>.
            </div>
        @else
            <form method="GET" class="mb-3 flex flex-wrap items-center justify-between max-md:justify-start gap-2 md:text-xs text-sm text-muted-foreground">
                <span>{{ $completedVideos->total() }} {{ Str::plural('video', $completedVideos->total()) }}</span>
                <div class="flex items-center gap-2">
                    <input type="hidden" name="search" value="{{ request()->query('search') }}">
                    <input type="hidden" name="range" value="{{ request()->query('range') }}">
                    <input type="hidden" name="date_from" value="{{ request()->query('date_from') }}">
                    <input type="hidden" name="date_to" value="{{ request()->query('date_to') }}">
                    <label for="per_page" class="shrink-0">Videos per page:</label>
                    <x-ui.select name="per_page" id="per_page" onchange="this.form.submit()" class="!w-auto">
                        @foreach ($allowedPerPage as $option)
                            <option value="{{ $option }}" @selected($perPage == $option)>{{ $option }}</option>
                        @endforeach
                    </x-ui.select>
                </div>
            </form>
            <x-ui.card class="overflow-x-auto">
                {{-- mobile-card:start (below md the table is restyled as stacked cards via max-md:* classes; thead keeps only the select-all control) --}}
                <x-ui.table class="max-md:block">
                    <x-ui.table-header class="max-md:block">
                        <x-ui.table-row :hover="false" class="max-md:flex max-md:items-center">
                            <x-ui.table-head class="w-10 max-md:flex max-md:w-auto max-md:items-center max-md:gap-2">
                                <x-ui.checkbox id="select-all-checkbox" class="cursor-pointer" />
                                <x-ui.label for="select-all-checkbox" class="md:hidden cursor-pointer">Select all</x-ui.label>
                            </x-ui.table-head>
                            <x-ui.table-head class="max-md:hidden">Thumbnail</x-ui.table-head>
                            <x-ui.table-head class="max-md:hidden">Video Name</x-ui.table-head>
                            <x-ui.table-head class="max-md:hidden">Status</x-ui.table-head>
                            <x-ui.table-head class="hidden md:table-cell">Duration</x-ui.table-head>
                            <x-ui.table-head class="hidden md:table-cell">Size</x-ui.table-head>
                            <x-ui.table-head class="hidden xl:table-cell">Source</x-ui.table-head>
                            <x-ui.table-head class="hidden xl:table-cell">Details</x-ui.table-head>
                            <x-ui.table-head class="hidden md:table-cell">Upload Date</x-ui.table-head>
                            <x-ui.table-head align="right" class="max-md:hidden">Actions</x-ui.table-head>
                        </x-ui.table-row>
                    </x-ui.table-header>
                    <tbody class="[&_tr:last-child]:border-0 max-md:block">
                        @foreach ($completedVideos as $video)
                            @include('videos._row', ['video' => $video, 'selectable' => true])
                        @endforeach
                    </tbody>
                </x-ui.table>
                {{-- mobile-card:end --}}
            </x-ui.card>
            <div class="mt-4">{{ $completedVideos->appends(request()->query())->links('partials.pagination') }}</div>
        @endif
    </div>

    {{-- tabs:start (below md the dialog is a full-screen sheet; header and tab bar stay fixed, body scrolls) --}}
    <x-ui.dialog id="embed-modal" class="z-50 md:p-4" initialFocus="panel" aria-labelledby="embed-modal-heading"
                 panelClass="max-w-2xl flex flex-col overflow-hidden max-md:h-[100dvh] max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0">
    {{-- tabs:end --}}
            <x-ui.dialog-header class="px-4 sm:px-5 py-4 border-b border-border shrink-0">
                <div class="min-w-0 pr-8">
                    <x-ui.dialog-title id="embed-modal-heading" class="text-base">Player / Embed &amp; Images</x-ui.dialog-title>
                    <x-ui.dialog-description id="embed-modal-title" class="mt-1.5 break-words"></x-ui.dialog-description>
                </div>
            </x-ui.dialog-header>

            {{-- tabs:start --}}
            <div class="shrink-0 border-b border-border px-4 py-2 md:hidden">
                <x-ui.tabs-list aria-label="Embed sections" id="embed-tablist" class="min-h-11">
                    <x-ui.tabs-trigger id="embed-tab-preview" data-tab="preview" :active="true" aria-selected="true" aria-controls="embed-panel-preview" class="embed-tab">Preview</x-ui.tabs-trigger>
                    <x-ui.tabs-trigger id="embed-tab-links" data-tab="links" aria-selected="false" aria-controls="embed-panel-links" tabindex="-1" class="embed-tab">Links &amp; Code</x-ui.tabs-trigger>
                    <x-ui.tabs-trigger id="embed-tab-images" data-tab="images" aria-selected="false" aria-controls="embed-modal-images-section" tabindex="-1" class="embed-tab hidden">Images</x-ui.tabs-trigger>
                </x-ui.tabs-list>
            </div>
            {{-- tabs:end --}}

            <div class="p-4 sm:p-5 md:space-y-4 min-h-0 flex-1 overflow-y-auto">
                {{-- tabs:start --}}
                <div id="embed-panel-preview" role="tabpanel" aria-labelledby="embed-tab-preview" class="rounded-lg overflow-hidden bg-black">
                {{-- tabs:end --}}
                    <iframe id="embed-modal-preview" class="block w-full mx-auto" style="max-height:45vh; border:0;" frameborder="0" allowfullscreen allow="autoplay; fullscreen"></iframe>
                </div>

                {{-- tabs:start --}}
                <div id="embed-panel-links" role="tabpanel" aria-labelledby="embed-tab-links" class="space-y-4 max-md:hidden">
                {{-- tabs:end --}}
                <div>
                    <x-ui.label for="embed-modal-url" class="block mb-2">Embed URL</x-ui.label>
                    <div class="flex gap-2">
                        <x-ui.input id="embed-modal-url" type="text" readonly class="flex-1" />
                        <x-ui.button variant="outline" size="sm" class="shrink-0" data-copy-btn aria-live="polite" onclick="copyModalField('embed-modal-url', this)">
                            <x-lucide-copy class="w-3.5 h-3.5" /> <span data-copy-label>Copy</span>
                        </x-ui.button>
                    </div>
                </div>

                <div>
                    <x-ui.label for="embed-modal-m3u8" class="block mb-2">Link m3u8 / play</x-ui.label>
                    <div class="flex gap-2">
                        <x-ui.input id="embed-modal-m3u8" type="text" readonly class="flex-1" />
                        <x-ui.button variant="outline" size="sm" class="shrink-0" data-copy-btn aria-live="polite" onclick="copyModalField('embed-modal-m3u8', this)">
                            <x-lucide-copy class="w-3.5 h-3.5" /> <span data-copy-label>Copy</span>
                        </x-ui.button>
                    </div>
                </div>

                <div>
                    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
                        <x-ui.label for="embed-modal-code" class="block">Iframe code</x-ui.label>
                        <div class="flex items-center gap-3 text-muted-foreground">
                            <x-ui.label for="embed-modal-mute" class="inline-flex items-center gap-1.5 font-normal text-muted-foreground">
                                <x-ui.checkbox id="embed-modal-mute" />
                                Mute
                            </x-ui.label>
                            <x-ui.label for="embed-modal-autoplay" class="inline-flex items-center gap-1.5 font-normal text-muted-foreground">
                                <x-ui.checkbox id="embed-modal-autoplay" />
                                Autoplay
                            </x-ui.label>
                        </div>
                    </div>
                    <x-ui.textarea id="embed-modal-code" readonly rows="3" class="font-mono resize-none" />
                    <p class="mt-1 text-xs text-muted-foreground">Browsers may block autoplay with sound unless Mute is also enabled.</p>
                    <x-ui.button variant="outline" size="sm" class="mt-2" data-copy-btn aria-live="polite" onclick="copyModalField('embed-modal-code', this)">
                        <x-lucide-copy class="w-3.5 h-3.5" /> <span data-copy-label>Copy</span>
                    </x-ui.button>
                </div>
                {{-- tabs:start --}}
                </div>
                {{-- tabs:end --}}

                <div id="embed-modal-images-section" role="tabpanel" aria-labelledby="embed-tab-images" class="hidden max-md:hidden">
                    <x-ui.label class="block mb-2">Images</x-ui.label>
                    <div id="embed-modal-images" class="grid grid-cols-2 gap-3"></div>
                    <p id="embed-modal-images-error" class="hidden mt-2 text-xs text-destructive"></p>
                </div>
            </div>
    </x-ui.dialog>

    <x-ui.dialog id="edit-modal" class="z-50 p-4" panelClass="max-w-md" aria-labelledby="edit-modal-heading">
        <form id="edit-modal-form" method="POST" class="grid gap-4 p-6">
            @csrf
            @method('PUT')
            <x-ui.dialog-header>
                <x-ui.dialog-title id="edit-modal-heading">Edit video</x-ui.dialog-title>
                <x-ui.dialog-description>Change the title shown in the video list.</x-ui.dialog-description>
            </x-ui.dialog-header>
            <div>
                <x-ui.label for="edit-modal-title" class="block mb-2">Title</x-ui.label>
                <x-ui.input type="text" name="title" id="edit-modal-title" required maxlength="255" />
            </div>
            <x-ui.dialog-footer>
                <x-ui.button variant="outline" onclick="closeEditModal()">
                    Cancel
                </x-ui.button>
                <x-ui.button type="submit">
                    Save
                </x-ui.button>
            </x-ui.dialog-footer>
        </form>
    </x-ui.dialog>
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

            // The table rows are rendered at page load, so their openEmbedModal()
            // data goes stale after an upload/delete. Remember the latest custom
            // image per video (keyed by its upload URL) and prefer it on reopen.
            const COPY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
            // Idle classes mirror the ui button component outline variant; copied classes use the primary token.
            const COPY_BTN_IDLE_CLASSES = ['border-input', 'bg-background', 'text-foreground', 'hover:bg-accent', 'hover:text-accent-foreground'];
            const COPY_BTN_COPIED_CLASSES = ['border-primary', 'bg-primary', 'text-primary-foreground', 'hover:bg-primary/90', 'hover:text-primary-foreground'];

            function setCopyButtonState(button, copied) {
                button.querySelector('[data-copy-label]').textContent = copied ? 'Copied' : 'Copy';
                button.classList.remove(...(copied ? COPY_BTN_IDLE_CLASSES : COPY_BTN_COPIED_CLASSES));
                button.classList.add(...(copied ? COPY_BTN_COPIED_CLASSES : COPY_BTN_IDLE_CLASSES));
            }

            function resetCopyButtons() {
                document.querySelectorAll('#embed-modal [data-copy-btn]').forEach(function (button) {
                    setCopyButtonState(button, false);
                });
            }

            // Shared by every copy button. The "Copied" state is kept until the Embed modal is opened again.
            function copyTextToClipboard(text, button) {
                if (!navigator.clipboard) return;
                navigator.clipboard.writeText(text).then(function () {
                    setCopyButtonState(button, true);
                }).catch(function () {});
            }

            const customImageOverrides = {};
            const customImageMaxBytes = 5 * 1024 * 1024;
            const customImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

            function buildImageCard(image, extraButtons) {
                const card = document.createElement('div');
                card.className = 'flex flex-col min-w-0 rounded-lg border border-border overflow-hidden';

                const label = document.createElement('div');
                label.className = 'px-3 py-2 bg-muted text-xs font-medium text-muted-foreground truncate';
                label.textContent = image.label;

                const link = document.createElement('a');
                link.href = image.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.className = 'block aspect-square overflow-hidden bg-muted';

                const img = document.createElement('img');
                img.src = image.url;
                img.alt = image.label;
                img.loading = 'lazy';
                img.className = 'w-full h-full object-cover';
                link.appendChild(img);

                const actions = document.createElement('div');
                actions.className = 'flex flex-wrap justify-center gap-2 px-3 py-2 border-t border-border';

                const copyButton = document.createElement('button');
                copyButton.type = 'button';
                copyButton.className = 'inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 md:py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
                copyButton.setAttribute('data-copy-btn', '');
                copyButton.setAttribute('aria-live', 'polite');
                copyButton.innerHTML = COPY_ICON_SVG + '<span data-copy-label>Copy</span>';
                copyButton.addEventListener('click', function () {
                    copyThumbnailUrl(copyButton, image.url);
                });

                actions.appendChild(copyButton);
                (extraButtons || []).forEach(function (button) {
                    actions.appendChild(button);
                });
                card.appendChild(label);
                card.appendChild(link);
                card.appendChild(actions);
                return card;
            }

            function showImagesError(message) {
                const el = document.getElementById('embed-modal-images-error');
                el.textContent = message || '';
                el.classList.toggle('hidden', !message);
            }

            function validateCustomImageFile(file) {
                if (customImageTypes.indexOf(file.type) === -1) return 'Only JPG, PNG or WebP images are allowed.';
                if (file.size > customImageMaxBytes) return 'The image must not be larger than 5 MB.';
                return '';
            }

            const TRASH_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

            // Same classes as the ui button component destructive-outline variant, size sm (components/ui/button.blade.php).
            const DESTRUCTIVE_OUTLINE_BTN_CLASS = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:pointer-events-none px-3 py-2 md:py-1.5 text-xs border border-input bg-background text-destructive shadow-xs hover:bg-destructive/10 hover:text-destructive disabled:border-input disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent';

            function buildDeleteButton() {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = DESTRUCTIVE_OUTLINE_BTN_CLASS;
                button.innerHTML = TRASH_ICON_SVG + '<span data-label>Delete</span>';
                return button;
            }

            function setButtonLabel(button, text) {
                button.querySelector('[data-label]').textContent = text;
            }

            function buildSmallButton(text, className) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 md:py-1.5 text-xs font-medium disabled:opacity-50 ' + className;
                button.textContent = text;
                return button;
            }

            // Returns the decoded JSON, or throws an Error carrying a user-facing message.
            async function sendCustomImageRequest(url, method, body) {
                const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
                const response = await fetch(url, {
                    method: method,
                    headers: { 'X-CSRF-TOKEN': csrfToken, 'Accept': 'application/json' },
                    body: body || undefined,
                });
                let data = null;
                try {
                    data = await response.json();
                } catch (e) {
                    data = null;
                }
                if (!response.ok) {
                    const firstError = data && data.errors ? Object.values(data.errors)[0][0] : null;
                    throw new Error(firstError || (data && data.message) || 'Request failed. Please try again.');
                }
                return data;
            }

            function setCustomImage(state, image) {
                customImageOverrides[state.uploadUrl] = image;
                state.customImage = image;
                if (embedModalState === state) {
                    renderEmbedImages();
                }
            }

            function buildUploadTile(state) {
                const card = document.createElement('div');
                card.className = 'flex flex-col min-w-0 rounded-lg border border-border overflow-hidden';

                const label = document.createElement('div');
                label.className = 'px-3 py-2 bg-muted text-xs font-medium text-muted-foreground truncate';
                label.textContent = 'Custom image';

                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/jpeg,image/png,image/webp';
                input.className = 'hidden';

                const tile = document.createElement('button');
                tile.type = 'button';
                tile.className = 'flex flex-col items-center justify-center gap-1 aspect-square bg-muted text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50';
                tile.textContent = '+ Upload image';
                tile.addEventListener('click', function () {
                    input.click();
                });

                input.addEventListener('change', async function () {
                    const file = input.files && input.files[0];
                    input.value = '';
                    if (!file) return;

                    const fileError = validateCustomImageFile(file);
                    if (fileError) {
                        showImagesError(fileError);
                        return;
                    }

                    showImagesError('');
                    tile.disabled = true;
                    tile.textContent = 'Uploading...';

                    const formData = new FormData();
                    formData.append('image', file);

                    try {
                        const data = await sendCustomImageRequest(state.uploadUrl, 'POST', formData);
                        if (embedModalState === state) showImagesError('');
                        setCustomImage(state, { label: data.label, url: data.url });
                    } catch (error) {
                        if (embedModalState === state) {
                            showImagesError(error.message);
                            tile.disabled = false;
                            tile.textContent = '+ Upload image';
                        }
                    }
                });

                card.appendChild(label);
                card.appendChild(tile);
                card.appendChild(input);
                return card;
            }

            function buildCustomImageCard(state) {
                const replaceButton = buildSmallButton('Replace', 'border-border bg-muted text-foreground hover:bg-accent');
                const deleteButton = buildDeleteButton();

                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/jpeg,image/png,image/webp';
                input.className = 'hidden';

                replaceButton.addEventListener('click', function () {
                    input.click();
                });

                input.addEventListener('change', async function () {
                    const file = input.files && input.files[0];
                    input.value = '';
                    if (!file) return;

                    const fileError = validateCustomImageFile(file);
                    if (fileError) {
                        showImagesError(fileError);
                        return;
                    }

                    showImagesError('');
                    replaceButton.disabled = true;
                    deleteButton.disabled = true;
                    replaceButton.textContent = 'Uploading...';

                    const formData = new FormData();
                    formData.append('image', file);

                    try {
                        const data = await sendCustomImageRequest(state.uploadUrl, 'POST', formData);
                        setCustomImage(state, { label: data.label, url: data.url });
                    } catch (error) {
                        if (embedModalState === state) {
                            showImagesError(error.message);
                            replaceButton.disabled = false;
                            deleteButton.disabled = false;
                            replaceButton.textContent = 'Replace';
                        }
                    }
                });

                deleteButton.addEventListener('click', async function () {
                    const ok = await window.confirmDialog({ title: 'Delete image', message: 'Delete this custom image?', confirmText: 'Delete', danger: true });
                    if (!ok) return;

                    showImagesError('');
                    replaceButton.disabled = true;
                    deleteButton.disabled = true;
                    setButtonLabel(deleteButton, 'Deleting...');

                    try {
                        await sendCustomImageRequest(state.deleteUrl, 'DELETE');
                        setCustomImage(state, null);
                    } catch (error) {
                        if (embedModalState === state) {
                            showImagesError(error.message);
                            replaceButton.disabled = false;
                            deleteButton.disabled = false;
                            setButtonLabel(deleteButton, 'Delete');
                        }
                    }
                });

                const card = buildImageCard(state.customImage, [replaceButton, deleteButton]);
                card.appendChild(input);
                return card;
            }

            function renderEmbedImages() {
                const state = embedModalState;
                const imagesGrid = document.getElementById('embed-modal-images');
                imagesGrid.innerHTML = '';
                state.images.forEach(function (image) {
                    imagesGrid.appendChild(buildImageCard(image));
                });
                if (state.customImage) {
                    imagesGrid.appendChild(buildCustomImageCard(state));
                } else if (state.canUpload) {
                    imagesGrid.appendChild(buildUploadTile(state));
                }
                document.getElementById('embed-modal-images-section').classList.toggle('hidden', imagesGrid.children.length === 0);
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
                    tab.dataset.state = active ? 'active' : 'inactive';
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

            function openEmbedModal(embedUrl, publicUrl, aspectRatio, title, images, uploadUrl, deleteUrl, canUpload) {
                const allImages = images || [];
                const customImage = uploadUrl && uploadUrl in customImageOverrides
                    ? customImageOverrides[uploadUrl]
                    : (allImages.find(function (image) { return image.label === 'Custom image'; }) || null);

                embedModalState = {
                    embedUrl: embedUrl,
                    aspectRatio: aspectRatio,
                    images: allImages.filter(function (image) { return image.label !== 'Custom image'; }),
                    customImage: customImage,
                    uploadUrl: uploadUrl,
                    deleteUrl: deleteUrl,
                    canUpload: !!canUpload,
                };

                document.getElementById('embed-modal-title').textContent = title;
                document.getElementById('embed-modal-url').value = embedUrl;
                document.getElementById('embed-modal-m3u8').value = publicUrl;
                document.getElementById('embed-modal-mute').checked = false;
                document.getElementById('embed-modal-autoplay').checked = false;

                refreshEmbedModal();

                showImagesError('');
                renderEmbedImages();
                resetCopyButtons();
                setEmbedTab('preview'); // tabs

                window.uiDialog.open(document.getElementById('embed-modal'));
            }

            function closeEmbedModal() {
                document.getElementById('embed-modal-preview').src = '';
                embedModalState = null;
                document.getElementById('embed-modal-images').innerHTML = '';
                showImagesError('');
                document.getElementById('embed-modal-images-section').classList.add('hidden');
                setEmbedTab('preview'); // tabs

                window.uiDialog.close(document.getElementById('embed-modal'));
            }

            function copyModalField(elementId, button) {
                copyTextToClipboard(document.getElementById(elementId).value, button);
            }

            function openEditModal(videoId, title) {
                const form = document.getElementById('edit-modal-form');
                form.action = '/videos/' + videoId;
                document.getElementById('edit-modal-title').value = title;
                window.uiDialog.open(document.getElementById('edit-modal'), { initialFocus: document.getElementById('edit-modal-title') });
            }

            function closeEditModal() {
                window.uiDialog.close(document.getElementById('edit-modal'));
            }

            function copyThumbnailUrl(button, url) {
                copyTextToClipboard(url, button);
            }

            const selectAllCheckbox = document.getElementById('select-all-checkbox');
            const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
            const selectedCountEl = document.getElementById('selected-count');

            function updateBulkDeleteState() {
                const checked = document.querySelectorAll('.bulk-select-checkbox:checked');
                selectedCountEl.textContent = checked.length;
                selectedCountEl.parentElement.hidden = checked.length === 0;
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
                const message = @json($deleteFromR2 ? 'Delete {COUNT} videos? The files on Cloudflare R2 will also be PERMANENTLY deleted and cannot be recovered!' : 'Delete {COUNT} videos?');
                window.confirmDialog({ title: 'Delete videos', message: message.replace('{COUNT}', count), confirmText: 'Delete', danger: true }).then(function (ok) {
                    if (!ok) return;
                    document.getElementById('bulk-delete-form').submit();
                });
                return false;
            }

            // Escape, overlay click and the X button are handled by ui-dialog.js and
            // arrive as 'dialog:dismiss'; route them through the existing close functions.
            document.getElementById('embed-modal').addEventListener('dialog:dismiss', function (event) {
                event.preventDefault();
                closeEmbedModal();
            });
            document.getElementById('edit-modal').addEventListener('dialog:dismiss', function (event) {
                event.preventDefault();
                closeEditModal();
            });

            document.getElementById('embed-modal-mute').addEventListener('change', refreshEmbedModal);
            document.getElementById('embed-modal-autoplay').addEventListener('change', refreshEmbedModal);

            const dateFilter = document.getElementById('date-filter');
            const dateFilterToggle = document.getElementById('date-filter-toggle');
            const dateFilterCustomPanel = document.getElementById('date-filter-custom-panel');
            const dateFilterRangeInput = document.getElementById('date-filter-range-input');
            const dateFilterFromInput = document.getElementById('date-filter-from-input');
            const dateFilterToInput = document.getElementById('date-filter-to-input');
            const dateFilterCustomFrom = document.getElementById('date-filter-custom-from');
            const dateFilterCustomTo = document.getElementById('date-filter-custom-to');
            const dateFilterCustomApply = document.getElementById('date-filter-custom-apply');

            if (dateFilterToggle) {
                // Open/close, Escape, outside click and arrow keys are handled by ui-dropdown.js.
                dateFilter.addEventListener('dropdown:close', function () {
                    dateFilterCustomPanel.classList.add('hidden');
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
