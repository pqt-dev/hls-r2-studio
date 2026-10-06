@props(['variant' => 'default', 'size' => 'default', 'href' => null, 'type' => 'button'])

@php
    $variants = [
        'default' => 'bg-primary text-primary-foreground hover:bg-primary/90',
        'secondary' => 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        'outline' => 'border border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground',
        'ghost' => 'text-foreground hover:bg-accent hover:text-accent-foreground',
        'destructive' => 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    ];

    $sizes = [
        'default' => 'h-9 px-4 py-2 text-sm',
        'sm' => 'px-3 py-2 md:py-1.5 text-xs',
        'icon' => 'h-9 w-9',
    ];

    $classes = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:opacity-50 disabled:pointer-events-none '
        .($variants[$variant] ?? $variants['default']).' '
        .($sizes[$size] ?? $sizes['default']);
@endphp

@if ($href)
    <a href="{{ $href }}" {{ $attributes->merge(['class' => $classes]) }}>{{ $slot }}</a>
@else
    <button type="{{ $type }}" {{ $attributes->merge(['class' => $classes]) }}>{{ $slot }}</button>
@endif
