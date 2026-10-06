@if ($paginator->hasPages())
    <nav class="flex flex-wrap items-center justify-center gap-1">
        @if ($paginator->onFirstPage())
            <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm text-gray-300">&lsaquo;</span>
        @else
            <a href="{{ $paginator->previousPageUrl() }}" class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm text-gray-600 hover:bg-gray-100">&lsaquo;</a>
        @endif

        @for ($page = 1; $page <= $paginator->lastPage(); $page++)
            @if ($page == $paginator->currentPage())
                <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm font-semibold bg-blue-600 text-white">{{ $page }}</span>
            @else
                <a href="{{ $paginator->url($page) }}" class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm text-gray-600 hover:bg-gray-100">{{ $page }}</a>
            @endif
        @endfor

        @if ($paginator->hasMorePages())
            <a href="{{ $paginator->nextPageUrl() }}" class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm text-gray-600 hover:bg-gray-100">&rsaquo;</a>
        @else
            <span class="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg text-sm text-gray-300">&rsaquo;</span>
        @endif
    </nav>
@endif
