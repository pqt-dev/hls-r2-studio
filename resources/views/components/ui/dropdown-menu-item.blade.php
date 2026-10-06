@props(['href' => null, 'active' => false])

@php
    $classes = 'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm text-popover-foreground outline-none transition-colors hover:bg-accent focus:bg-accent '
        .($active ? 'bg-accent font-medium' : '');
@endphp

@if ($href)
    <a href="{{ $href }}" role="menuitem" tabindex="-1" {{ $attributes->merge(['class' => $classes]) }}>{{ $slot }}</a>
@else
    <button type="button" role="menuitem" tabindex="-1" {{ $attributes->merge(['class' => $classes]) }}>{{ $slot }}</button>
@endif
