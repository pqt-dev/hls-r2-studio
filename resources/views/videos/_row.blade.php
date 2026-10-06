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

    $embedAspectRatio = ($video->output_width && $video->output_height && $video->output_width > $video->output_height)
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

{{-- mobile-card:start (max-md:* classes turn this row into a card below md; md+ is unchanged) --}}
<tr class="max-md:grid max-md:grid-cols-[1.25rem_3rem_minmax(0,1fr)] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:p-3">
    @if ($selectable ?? false)
        <td class="px-3 py-2 max-md:row-span-2 max-md:self-center max-md:p-0">
            <input type="checkbox" name="selected_ids[]" value="{{ $video->id }}"
                   class="bulk-select-checkbox w-5 h-5 rounded border-gray-400 text-blue-600 focus:ring-blue-500 cursor-pointer"
                   form="bulk-delete-form">
        </td>
    @else
        <td class="px-3 py-2 max-md:hidden"></td>
    @endif

    <td class="px-3 py-2 max-md:row-span-2 max-md:p-0">
        <div class="w-12 h-12 bg-gray-200 rounded overflow-hidden flex items-center justify-center">
            @if ($thumbnailUrl)
                <img src="{{ $thumbnailUrl }}" alt="{{ $video->title }}" class="w-full h-full object-cover">
            @else
                <span class="text-gray-400 text-[10px]">No thumbnail</span>
            @endif
        </div>
    </td>

    <td class="px-3 py-2 font-medium text-gray-900 max-w-[10rem] md:max-w-xs max-md:min-w-0 max-md:max-w-none max-md:p-0">
        <div class="truncate">{{ $video->title }}</div>
        <div class="text-xs font-normal text-gray-400 truncate" title="{{ $video->disk_prefix ?? '—' }}">{{ $video->disk_prefix ?? '—' }}</div>
    </td>

    <td class="px-3 py-2 max-md:col-start-3 max-md:p-0">
        <span
            @if ($video->status === 'failed' && $video->error_message)
                title="{{ $video->error_message }}"
            @endif
            class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium {{ $badge[0] }}"
        >
            {{ $badge[1] }}
        </span>
    </td>

    <td class="hidden md:table-cell px-3 py-2 text-gray-500 max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-gray-400 max-md:mt-1 max-md:border-t max-md:border-gray-100 max-md:pt-2 max-md:before:content-['Duration']">{{ $durationLabel }}</td>

    <td class="hidden md:table-cell px-3 py-2 text-gray-500 max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-gray-400 max-md:before:content-['Size']">{{ $video->formatted_size }}</td>

    <td class="hidden md:table-cell px-3 py-2 max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-gray-400 max-md:before:content-['Source']">
        <span class="inline-flex items-center gap-1.5 text-xs text-gray-600" title="Cloudflare R2">
            <img src="{{ asset('img/cloudflare.png') }}" alt="Cloudflare" class="w-4 h-4">
            R2
        </span>
    </td>

    <td class="hidden md:table-cell px-3 py-2 text-gray-500 text-xs max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-gray-400 max-md:text-right max-md:before:text-left max-md:before:content-['Details']">
        @if ($video->output_width && $video->output_height)
            <div>{{ $video->output_width }}×{{ $video->output_height }}</div>
            <div>{{ $video->output_fps ?? '—' }} fps · {{ $video->output_codec ? strtoupper($video->output_codec) : '—' }}</div>
            <div>{{ $video->output_bitrate_kbps ? number_format($video->output_bitrate_kbps) . ' kbps' : '—' }}</div>
        @else
            <span class="text-gray-400">—</span>
        @endif
    </td>

    <td class="hidden md:table-cell px-3 py-2 text-gray-500 max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-gray-400 max-md:before:content-['Uploaded']">{{ $video->created_at->toDisplay() }}</td>

    <td class="px-3 py-2 text-right whitespace-nowrap max-md:col-span-full max-md:mt-1 max-md:border-t max-md:border-gray-100 max-md:p-0 max-md:pt-3 max-md:text-left">
        <div class="flex w-full flex-wrap gap-2 md:inline-flex md:w-auto md:flex-nowrap md:items-center">
            @if ($video->status === 'ready' && $playlistUrl)
                <button type="button"
                        onclick="openEmbedModal({{ \Illuminate\Support\Js::from($embedUrl) }}, {{ \Illuminate\Support\Js::from($video->public_url) }}, {{ \Illuminate\Support\Js::from($embedAspectRatio) }}, {{ \Illuminate\Support\Js::from($video->title) }}, {{ \Illuminate\Support\Js::from($previewImages) }})"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 max-md:min-h-10 max-md:flex-1 max-md:justify-center px-3 py-2 md:py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                    <x-lucide-code class="w-3.5 h-3.5" /> Embed &amp; Images
                </button>
            @endif

            <button type="button"
                    onclick="openEditModal({{ $video->id }}, {{ \Illuminate\Support\Js::from($video->title) }})"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 max-md:min-h-10 max-md:flex-1 max-md:justify-center px-3 py-2 md:py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100">
                <x-lucide-pencil class="w-3.5 h-3.5" /> Edit
            </button>

            <form action="{{ route('videos.destroy', $video) }}" method="POST" class="max-md:flex-1"
                  onsubmit="return confirmDelete(this, {{ \Illuminate\Support\Js::from($video->title) }})">
                @csrf
                @method('DELETE')
                <button type="submit"
                        class="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 max-md:min-h-10 max-md:w-full max-md:justify-center px-3 py-2 md:py-1.5 text-xs font-medium text-red-700 hover:bg-red-100">
                    <x-lucide-trash-2 class="w-3.5 h-3.5" /> Delete
                </button>
            </form>
        </div>
    </td>
</tr>
{{-- mobile-card:end --}}
