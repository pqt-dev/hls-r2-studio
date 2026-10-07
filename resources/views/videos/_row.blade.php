@php
    $badge = match ($video->status) {
        'ready' => ['success', 'Ready'],
        'failed' => ['destructive', 'Failed'],
        default => ['secondary', $video->status],
    };

    $minutes = $video->duration ? floor($video->duration / 60) : 0;
    $seconds = $video->duration ? floor($video->duration % 60) : 0;
    $durationLabel = $video->duration ? sprintf('%02d:%02d', $minutes, $seconds) : '--:--';

    $thumbnailUrl = $video->thumbnail_path ? $disk->url($video->thumbnail_path) : null;
    $playlistUrl = $video->playlist_path ? $disk->url($video->playlist_path) : null;

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
                'url' => $disk->url($storyboard['path']),
            ];
        }
    }

    if ($video->custom_image_path) {
        $previewImages[] = ['label' => 'Custom image', 'url' => $disk->url($video->custom_image_path).'?v='.$video->updated_at->timestamp];
    }
@endphp

{{-- mobile-card:start (max-md:* classes turn this row into a card below md; md+ is unchanged) --}}
<x-ui.table-row class="max-md:grid max-md:grid-cols-[1.25rem_3rem_minmax(0,1fr)] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:p-3">
    @if ($selectable ?? false)
        <x-ui.table-cell class="max-md:row-span-2 max-md:self-center max-md:p-0">
            <x-ui.checkbox name="selected_ids[]" value="{{ $video->id }}"
                   class="bulk-select-checkbox cursor-pointer max-md:h-5 max-md:w-5"
                   form="bulk-delete-form" />
        </x-ui.table-cell>
    @else
        <x-ui.table-cell class="max-md:hidden"></x-ui.table-cell>
    @endif

    <x-ui.table-cell class="max-md:row-span-2 max-md:p-0">
        <div class="w-12 h-12 bg-border rounded overflow-hidden flex items-center justify-center">
            @if ($thumbnailUrl)
                <img src="{{ $thumbnailUrl }}" alt="{{ $video->title }}" class="w-full h-full object-cover">
            @else
                <span class="text-muted-foreground text-[10px]">No thumbnail</span>
            @endif
        </div>
    </x-ui.table-cell>

    <x-ui.table-cell class="font-medium text-foreground max-w-[10rem] md:max-w-[7rem] xl:max-w-[11rem] 2xl:max-w-xs max-md:min-w-0 max-md:max-w-none max-md:p-0">
        <div class="truncate">{{ $video->title }}</div>
        <div class="text-xs font-normal text-muted-foreground truncate" title="{{ $video->disk_prefix ?? '—' }}">{{ $video->disk_prefix ?? '—' }}</div>
    </x-ui.table-cell>

    <x-ui.table-cell class="max-md:col-start-3 max-md:p-0">
        <x-ui.badge :variant="$badge[0]"
            :title="$video->status === 'failed' && $video->error_message ? $video->error_message : null"
        >
            {{ $badge[1] }}
        </x-ui.badge>
    </x-ui.table-cell>

    <x-ui.table-cell class="hidden md:table-cell text-muted-foreground max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-muted-foreground max-md:mt-1 max-md:border-t max-md:border-border max-md:pt-2 max-md:before:content-['Duration']">{{ $durationLabel }}</x-ui.table-cell>

    <x-ui.table-cell class="hidden md:table-cell text-muted-foreground max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-muted-foreground max-md:before:content-['Size']">{{ $video->formatted_size }}</x-ui.table-cell>

    <x-ui.table-cell class="hidden xl:table-cell max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-muted-foreground max-md:before:content-['Source']">
        <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Cloudflare R2">
            <img src="{{ asset('img/r2.svg') }}" alt="Cloudflare R2" class="w-4 h-4 shrink-0">
            R2
        </span>
    </x-ui.table-cell>

    <x-ui.table-cell class="hidden xl:table-cell text-muted-foreground text-xs max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-muted-foreground max-md:text-right max-md:before:text-left max-md:before:content-['Details']">
        @if ($video->output_width && $video->output_height)
            <div>{{ $video->output_width }}×{{ $video->output_height }}</div>
            <div>{{ $video->output_fps ?? '—' }} fps · {{ $video->output_codec ? strtoupper($video->output_codec) : '—' }}</div>
            <div>{{ $video->output_bitrate_kbps ? number_format($video->output_bitrate_kbps) . ' kbps' : '—' }}</div>
        @else
            <span class="text-muted-foreground">—</span>
        @endif
    </x-ui.table-cell>

    <x-ui.table-cell class="hidden md:table-cell text-muted-foreground max-md:col-span-full max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:p-0 max-md:text-xs max-md:before:text-muted-foreground max-md:before:content-['Uploaded']">{{ $video->created_at->toDisplay() }}</x-ui.table-cell>

    <x-ui.table-cell align="right" class="whitespace-nowrap max-md:col-span-full max-md:mt-1 max-md:border-t max-md:border-border max-md:p-0 max-md:pt-3 max-md:text-left">
        <div class="flex w-full flex-wrap gap-2 md:inline-flex md:w-auto md:flex-nowrap md:items-center">
            @if ($video->status === 'ready' && $playlistUrl)
                <x-ui.button variant="outline" size="sm" class="max-md:min-h-10 max-md:flex-1 md:h-8 md:w-8 md:px-0 md:py-0" aria-label="Embed" title="Embed"
                        onclick="openEmbedModal({{ \Illuminate\Support\Js::from($embedUrl) }}, {{ \Illuminate\Support\Js::from($video->public_url) }}, {{ \Illuminate\Support\Js::from($embedAspectRatio) }}, {{ \Illuminate\Support\Js::from($video->title) }}, {{ \Illuminate\Support\Js::from($previewImages) }}, {{ \Illuminate\Support\Js::from(route('videos.image.store', $video)) }}, {{ \Illuminate\Support\Js::from(route('videos.image.destroy', $video)) }}, {{ \Illuminate\Support\Js::from((bool) $video->disk_prefix) }})"
                        >
                    <x-lucide-code class="w-3.5 h-3.5" /> <span class="max-md:inline md:sr-only">Embed</span>
                </x-ui.button>
            @endif

            <x-ui.button variant="outline" size="sm" class="max-md:min-h-10 max-md:flex-1 md:h-8 md:w-8 md:px-0 md:py-0" aria-label="Edit" title="Edit"
                    onclick="openEditModal({{ $video->id }}, {{ \Illuminate\Support\Js::from($video->title) }})">
                <x-lucide-pencil class="w-3.5 h-3.5" /> <span class="max-md:inline md:sr-only">Edit</span>
            </x-ui.button>

            <form action="{{ route('videos.destroy', $video) }}" method="POST" class="max-md:flex-1"
                  onsubmit="return confirmDelete(this, {{ \Illuminate\Support\Js::from($video->title) }})">
                @csrf
                @method('DELETE')
                <x-ui.button type="submit" variant="destructive-outline" size="sm" class="max-md:min-h-10 max-md:w-full md:h-8 md:w-8 md:px-0 md:py-0" aria-label="Delete" title="Delete">
                    <x-lucide-trash-2 class="w-3.5 h-3.5" /> <span class="max-md:inline md:sr-only">Delete</span>
                </x-ui.button>
            </form>
        </div>
    </x-ui.table-cell>
</x-ui.table-row>
{{-- mobile-card:end --}}
