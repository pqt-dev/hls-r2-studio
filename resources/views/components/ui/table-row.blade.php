@props(['hover' => true])

<tr {{ $attributes->merge(['class' => 'border-b border-border transition-colors '.($hover ? 'hover:bg-muted/50' : '')]) }}>{{ $slot }}</tr>
