@props(['align' => 'left'])

<th {{ $attributes->merge(['class' => 'h-10 px-3 align-middle font-medium text-muted-foreground whitespace-nowrap '.($align === 'right' ? 'text-right' : 'text-left')]) }}>{{ $slot }}</th>
