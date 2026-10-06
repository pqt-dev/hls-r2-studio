@props(['variant' => 'default'])

@php
    $variants = [
        'default' => 'border-transparent bg-primary text-primary-foreground',
        'secondary' => 'border-transparent bg-secondary text-secondary-foreground',
        'outline' => 'text-foreground',
        'success' => 'border-transparent bg-green-100 text-green-800',
        'destructive' => 'border-transparent bg-destructive/10 text-destructive',
    ];
@endphp

<span {{ $attributes->merge(['class' => 'inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap '.($variants[$variant] ?? $variants['default'])]) }}>{{ $slot }}</span>
