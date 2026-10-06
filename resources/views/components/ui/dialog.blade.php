@props(['id', 'panelClass' => 'max-w-lg', 'role' => 'dialog', 'initialFocus' => 'first', 'closeLabel' => 'Close'])

{{-- Overlay classes that need to differ per call site (z-index, padding) are passed through $attributes. Behavior lives in resources/js/ui-dialog.js. --}}
<div id="{{ $id }}" data-dialog data-initial-focus="{{ $initialFocus }}" role="{{ $role }}" aria-modal="true"
     {{ $attributes->merge(['class' => 'group fixed inset-0 hidden items-center justify-center bg-black/50 transition-opacity duration-150 motion-reduce:transition-none data-[state=closed]:opacity-0']) }}>
    <div data-dialog-panel tabindex="-1"
         class="relative w-full max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-background text-foreground shadow-lg outline-none transition duration-150 motion-reduce:transition-none group-data-[state=closed]:scale-95 group-data-[state=closed]:opacity-0 {{ $panelClass }}">
        {{ $slot }}
        <button type="button" data-dialog-close aria-label="{{ $closeLabel }}"
                class="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <x-lucide-x class="h-4 w-4" />
        </button>
    </div>
</div>
