@php
    $badge = match ($video->status) {
        'pending' => ['bg-yellow-100 text-yellow-800', 'Pending'],
        'processing' => ['bg-amber-100 text-amber-800', 'Processing'],
        'ready' => ['bg-green-100 text-green-800', 'Ready'],
        'failed' => ['bg-red-100 text-red-800', 'Failed'],
        default => ['bg-gray-100 text-gray-800', $video->status],
    };

    $minutes = $video->duration ? floor($video->duration / 60) : 0;
    $seconds = $video->duration ? floor($video->duration % 60) : 0;
    $durationLabel = $video->duration ? sprintf('%02d:%02d', $minutes, $seconds) : '--:--';

    $thumbnailUrl = $video->thumbnail_path ? Storage::disk('r2')->url($video->thumbnail_path) : null;
    $playlistUrl = $video->playlist_path ? Storage::disk('r2')->url($video->playlist_path) : null;
@endphp

<tr>
    @if ($selectable ?? false)
        <td class="px-3 py-2">
            <input type="checkbox" name="selected_ids[]" value="{{ $video->id }}"
                   class="bulk-select-checkbox w-5 h-5 rounded border-gray-400 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                   form="bulk-delete-form">
        </td>
    @else
        <td class="px-3 py-2"></td>
    @endif

    <td class="px-3 py-2">
        <div class="w-20 h-12 bg-gray-200 rounded overflow-hidden flex items-center justify-center">
            @if ($thumbnailUrl)
                <img src="{{ $thumbnailUrl }}" alt="{{ $video->title }}" class="w-full h-full object-cover">
            @else
                <span class="text-gray-400 text-[10px]">No thumbnail</span>
            @endif
        </div>
    </td>

    <td class="px-3 py-2 font-medium text-gray-900 max-w-xs truncate">{{ $video->title }}</td>

    <td class="px-3 py-2">
        <span
            @if ($video->status === 'failed' && $video->error_message)
                title="{{ $video->error_message }}"
            @endif
            class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium {{ $badge[0] }}"
        >
            @if ($video->status === 'processing')
                <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                </svg>
            @endif
            {{ $badge[1] }}
        </span>

        @if ($video->status === 'processing')
            @php
                $stageLabel = match ($video->stage) {
                    'queued' => 'Queued',
                    'transcoding' => 'Transcoding',
                    'uploading_r2' => 'Uploading to R2',
                    default => $video->stage,
                };
            @endphp
            <div class="flex flex-col gap-1 mt-1 w-40">
                <div class="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                    <div class="h-full rounded-full bg-emerald-600" style="width: {{ $video->progress }}%"></div>
                </div>
                <p class="text-xs text-gray-500">{{ $stageLabel }} — {{ $video->progress }}%</p>
            </div>
        @elseif ($video->status === 'pending')
            <p class="text-xs text-gray-500 mt-1">Waiting in queue...</p>
        @endif
    </td>

    <td class="px-3 py-2 text-gray-500">{{ $durationLabel }}</td>

    <td class="px-3 py-2 text-gray-500">{{ $video->formatted_size }}</td>

    <td class="px-3 py-2 text-gray-500 text-xs">
        @if ($video->output_width && $video->output_height)
            <div>{{ $video->output_width }}×{{ $video->output_height }}</div>
            <div>{{ $video->output_fps ?? '—' }} fps · {{ $video->output_codec ? strtoupper($video->output_codec) : '—' }}</div>
            <div>{{ $video->output_bitrate_kbps ? number_format($video->output_bitrate_kbps) . ' kbps' : '—' }}</div>
        @else
            <span class="text-gray-400">—</span>
        @endif
    </td>

    <td class="px-3 py-2 text-gray-500">{{ $video->created_at->format('d/m/Y H:i') }}</td>

    <td class="px-3 py-2 text-right whitespace-nowrap">
        <div class="inline-flex items-center gap-2">
            @if ($video->status === 'ready' && $playlistUrl)
                <button type="button"
                        onclick="openVideoModal({{ \Illuminate\Support\Js::from($playlistUrl) }}, {{ \Illuminate\Support\Js::from($video->title) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800">
                    <x-lucide-eye class="w-3.5 h-3.5" /> View
                </button>

                <button type="button"
                        onclick="copyVideoLink(this, {{ \Illuminate\Support\Js::from($video->public_url) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                    <x-lucide-copy class="w-3.5 h-3.5" /> Copy Link
                </button>
            @endif

            @if ($thumbnailUrl)
                <button type="button"
                        onclick="copyThumbnailUrl(this, {{ \Illuminate\Support\Js::from($thumbnailUrl) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                    <x-lucide-copy class="w-3.5 h-3.5" /> Copy Thumbnail
                </button>
            @endif

            <form action="{{ route('videos.destroy', $video) }}" method="POST"
                  onsubmit="return confirmDelete(this)">
                @csrf
                @method('DELETE')
                <button type="submit"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100">
                    <x-lucide-trash-2 class="w-3.5 h-3.5" /> Delete
                </button>
            </form>
        </div>
    </td>
</tr>
