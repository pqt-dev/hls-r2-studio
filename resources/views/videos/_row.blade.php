@php
    $badge = match ($video->status) {
        'ready' => ['bg-green-100 text-green-800', 'Ready'],
        'failed' => ['bg-red-100 text-red-800', 'Failed'],
        default => ['bg-gray-100 text-gray-800', $video->status],
    };

    $minutes = $video->duration ? floor($video->duration / 60) : 0;
    $seconds = $video->duration ? floor($video->duration % 60) : 0;
    $durationLabel = $video->duration ? sprintf('%02d:%02d', $minutes, $seconds) : '--:--';

    $thumbnailUrl = $video->thumbnail_path ? Storage::disk('r2')->url($video->thumbnail_path) : null;
    $playlistUrl = $video->playlist_path ? Storage::disk('r2')->url($video->playlist_path) : null;

    $embedAspectRatio = ($video->output_width && $video->output_height)
        ? "{$video->output_width} / {$video->output_height}"
        : '16 / 9';

    $embedUrl = route('embed.show', $video);

    // The candidate images a user can pick a feature image from: the
    // thumbnail plus every storyboard grid that was generated. Videos
    // processed before storyboards existed (or whose generation failed) may
    // have some or all of these missing.
    $previewImages = [];

    if ($thumbnailUrl) {
        $previewImages[] = ['label' => 'Thumbnail', 'url' => $thumbnailUrl];
    }

    foreach ($video->storyboards ?? [] as $gridKey => $storyboard) {
        if (! empty($storyboard['path'])) {
            $previewImages[] = [
                'label' => 'Storyboard '.$gridKey,
                'url' => Storage::disk('r2')->url($storyboard['path']),
            ];
        }
    }
@endphp

<tr>
    @if ($selectable ?? false)
        <td class="px-3 py-2">
            <input type="checkbox" name="selected_ids[]" value="{{ $video->id }}"
                   class="bulk-select-checkbox w-5 h-5 rounded border-gray-400 text-blue-600 focus:ring-blue-500 cursor-pointer"
                   form="bulk-delete-form">
        </td>
    @else
        <td class="px-3 py-2"></td>
    @endif

    <td class="px-3 py-2">
        <div class="w-12 h-12 bg-gray-200 rounded overflow-hidden flex items-center justify-center">
            @if ($thumbnailUrl)
                <img src="{{ $thumbnailUrl }}" alt="{{ $video->title }}" class="w-full h-full object-cover">
            @else
                <span class="text-gray-400 text-[10px]">No thumbnail</span>
            @endif
        </div>
    </td>

    <td class="px-3 py-2 font-medium text-gray-900 max-w-xs">
        <div class="truncate">{{ $video->title }}</div>
        <div class="text-xs font-normal text-gray-400 truncate" title="{{ $video->disk_prefix ?? '—' }}">{{ $video->disk_prefix ?? '—' }}</div>
    </td>

    <td class="px-3 py-2">
        <span
            @if ($video->status === 'failed' && $video->error_message)
                title="{{ $video->error_message }}"
            @endif
            class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium {{ $badge[0] }}"
        >
            {{ $badge[1] }}
        </span>
    </td>

    <td class="px-3 py-2 text-gray-500">{{ $durationLabel }}</td>

    <td class="px-3 py-2 text-gray-500">{{ $video->formatted_size }}</td>

    <td class="px-3 py-2">
        <span class="inline-flex items-center gap-1.5 text-xs text-gray-600" title="Cloudflare R2">
            <img src="{{ asset('img/cloudflare.png') }}" alt="Cloudflare" class="w-4 h-4">
            R2
        </span>
    </td>

    <td class="px-3 py-2 text-gray-500 text-xs">
        @if ($video->output_width && $video->output_height)
            <div>{{ $video->output_width }}×{{ $video->output_height }}</div>
            <div>{{ $video->output_fps ?? '—' }} fps · {{ $video->output_codec ? strtoupper($video->output_codec) : '—' }}</div>
            <div>{{ $video->output_bitrate_kbps ? number_format($video->output_bitrate_kbps) . ' kbps' : '—' }}</div>
        @else
            <span class="text-gray-400">—</span>
        @endif
    </td>

    <td class="px-3 py-2 text-gray-500">{{ $video->created_at->toDisplay() }}</td>

    <td class="px-3 py-2 text-right whitespace-nowrap">
        <div class="inline-flex items-center gap-2">
            @if ($video->status === 'ready' && $playlistUrl)
                <button type="button"
                        onclick="openEmbedModal({{ \Illuminate\Support\Js::from($embedUrl) }}, {{ \Illuminate\Support\Js::from($video->public_url) }}, {{ \Illuminate\Support\Js::from($embedAspectRatio) }}, {{ \Illuminate\Support\Js::from($video->title) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                    <x-lucide-code class="w-3.5 h-3.5" /> Embed
                </button>
            @endif

            @if ($previewImages)
                <button type="button"
                        onclick="openPreviewModal({{ \Illuminate\Support\Js::from($previewImages) }}, {{ \Illuminate\Support\Js::from($video->title) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                    <x-lucide-images class="w-3.5 h-3.5" /> Images
                </button>
            @endif

            <button type="button"
                    onclick="openEditModal({{ $video->id }}, {{ \Illuminate\Support\Js::from($video->title) }})"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                <x-lucide-pencil class="w-3.5 h-3.5" /> Edit
            </button>

            <form action="{{ route('videos.destroy', $video) }}" method="POST"
                  onsubmit="return confirmDelete(this, {{ \Illuminate\Support\Js::from($video->title) }})">
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
