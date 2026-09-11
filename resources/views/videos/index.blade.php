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
               class="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
        <button type="submit"
                class="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
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
               class="px-3 py-2 text-sm font-medium border-b-2 {{ $currentStatus === $tab['value'] ? 'border-emerald-700 text-emerald-700' : 'border-transparent text-gray-500 hover:text-gray-700' }}">
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
            @if ($completedVideos->isNotEmpty())
                <div class="flex items-center gap-3">
                    <label class="flex items-center gap-1.5 text-xs text-gray-600">
                        <input type="checkbox" id="select-all-checkbox" class="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500">
                        Select all (this page)
                    </label>
                    <button type="submit" form="bulk-delete-form" id="bulk-delete-btn" disabled
                            class="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed">
                        Delete Selected (<span id="selected-count">0</span>)
                    </button>
                </div>
            @endif
        </div>
        <form id="bulk-delete-form" action="{{ route('videos.bulk-destroy') }}" method="POST" onsubmit="return confirmBulkDelete()">
            @csrf
            @method('DELETE')
        </form>
        @if ($completedVideos->isEmpty())
            <div class="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
                No completed videos yet. <a href="{{ route('videos.create') }}" class="text-emerald-700 underline">Upload your first video</a>.
            </div>
        @else
            <form method="GET" class="mb-3 flex items-center justify-end gap-2 text-xs text-gray-600">
                <label for="per_page">Videos per page:</label>
                <select name="per_page" id="per_page" onchange="this.form.submit()"
                        class="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @foreach ($allowedPerPage as $option)
                        <option value="{{ $option }}" @selected($perPage == $option)>{{ $option }}</option>
                    @endforeach
                </select>
            </form>
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
                            <th class="px-3 py-2 text-left">Details</th>
                            <th class="px-3 py-2 text-left">Upload Date</th>
                            <th class="px-3 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        @php $lastDate = null; @endphp
                        @foreach ($completedVideos as $video)
                            @php $currentDate = $video->created_at->format('d/m/Y'); @endphp
                            @if ($currentDate !== $lastDate)
                                @php $lastDate = $currentDate; @endphp
                                <tr>
                                    <td colspan="9" class="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-400 uppercase tracking-wide">{{ $currentDate }}</td>
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

    <div id="video-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/70 p-4">
        <div class="bg-black rounded-xl overflow-hidden w-full max-w-3xl">
            <div class="flex items-center justify-between px-4 py-2 bg-gray-900 text-white">
                <span id="video-modal-title" class="text-sm font-medium"></span>
                <button type="button" onclick="closeVideoModal()" class="text-gray-300 hover:text-white">
                    <x-lucide-x class="w-5 h-5" />
                </button>
            </div>
            <video id="video-modal-player" class="w-full aspect-video" controls></video>
        </div>
    </div>
@endsection

@push('scripts')
    <script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"
            integrity="sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni"
            crossorigin="anonymous"></script>
    <script>
        let hlsInstance = null;

        function confirmDelete(form) {
            const message = @json($deleteFromR2 ? 'Delete this video? The file on Cloudflare R2 will also be PERMANENTLY deleted and cannot be recovered!' : 'Delete this video?');
            if (!confirm(message)) return false;
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.textContent = 'Deleting...';
            btn.classList.add('opacity-60', 'cursor-not-allowed');
            return true;
        }

        function openVideoModal(src, title) {
            const modal = document.getElementById('video-modal');
            const video = document.getElementById('video-modal-player');
            document.getElementById('video-modal-title').textContent = title;

            if (Hls.isSupported()) {
                hlsInstance = new Hls();
                hlsInstance.loadSource(src);
                hlsInstance.attachMedia(video);
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = src;
            }

            modal.classList.remove('hidden');
            modal.classList.add('flex');
            video.play();
        }

        function copyVideoLink(button, url) {
            navigator.clipboard.writeText(url);

            const originalHTML = button.innerHTML;
            const originalClasses = ['border-gray-200', 'bg-gray-50', 'text-gray-700'];
            const successClasses = ['border-emerald-300', 'bg-emerald-50', 'text-emerald-700'];

            button.innerHTML = originalHTML.replace(/Copy Link/, 'Copied!');
            button.classList.remove(...originalClasses);
            button.classList.add(...successClasses);

            setTimeout(function () {
                button.innerHTML = originalHTML;
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

        function closeVideoModal() {
            const modal = document.getElementById('video-modal');
            const video = document.getElementById('video-modal-player');
            video.pause();
            video.removeAttribute('src');
            video.load();

            if (hlsInstance) {
                hlsInstance.destroy();
                hlsInstance = null;
            }

            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }

        @if ($hasActive)
            setInterval(function () {
                window.location.reload();
            }, 5000);
        @endif
    </script>
@endpush
