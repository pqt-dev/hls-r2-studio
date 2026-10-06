@props(['active' => false])

<button type="button" role="tab" data-state="{{ $active ? 'active' : 'inactive' }}"
        {{ $attributes->merge(['class' => 'flex flex-1 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-3 py-1 text-sm font-medium text-muted-foreground transition-[color,box-shadow] hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:opacity-50 disabled:pointer-events-none data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm']) }}>{{ $slot }}</button>
