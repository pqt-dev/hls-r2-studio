@if ($paginator->hasPages())
    <nav class="flex flex-wrap items-center justify-center gap-1">
        @if ($paginator->onFirstPage())
            <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-md text-sm text-muted-foreground/50">&lsaquo;</span>
        @else
            <x-ui.button variant="ghost" :href="$paginator->previousPageUrl()" class="w-9 h-9 md:w-8 md:h-8 !p-0">&lsaquo;</x-ui.button>
        @endif

        @for ($page = 1; $page <= $paginator->lastPage(); $page++)
            @if ($page == $paginator->currentPage())
                <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-md border border-input bg-background text-sm font-semibold text-foreground shadow-sm">{{ $page }}</span>
            @else
                <x-ui.button variant="ghost" :href="$paginator->url($page)" class="w-9 h-9 md:w-8 md:h-8 !p-0">{{ $page }}</x-ui.button>
            @endif
        @endfor

        @if ($paginator->hasMorePages())
            <x-ui.button variant="ghost" :href="$paginator->nextPageUrl()" class="w-9 h-9 md:w-8 md:h-8 !p-0">&rsaquo;</x-ui.button>
        @else
            <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-md text-sm text-muted-foreground/50">&rsaquo;</span>
        @endif
    </nav>
@endif
