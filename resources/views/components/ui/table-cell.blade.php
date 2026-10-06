@props(['align' => 'left'])

<td {{ $attributes->merge(['class' => 'px-3 py-2 align-middle '.($align === 'right' ? 'text-right' : '')]) }}>{{ $slot }}</td>
