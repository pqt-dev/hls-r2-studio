@props(['variant' => 'default'])

@php
    $variants = [
        'default' => 'border-border bg-background text-foreground',
        'destructive' => 'border-destructive/30 bg-destructive/10 text-destructive',
        'success' => 'border-emerald-200 bg-emerald-50 text-emerald-800',
        'warning' => 'border-amber-200 bg-amber-50 text-amber-800',
    ];
@endphp

<div role="alert" {{ $attributes->merge(['class' => 'flex items-center gap-2 rounded-lg border px-4 py-3 text-sm '.($variants[$variant] ?? $variants['default'])]) }}>{{ $slot }}</div>
