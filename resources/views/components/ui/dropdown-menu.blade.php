@props(['panelId' => null, 'panelClass' => 'w-44'])

{{-- Behavior lives in resources/js/ui-dropdown.js. Pass position classes (relative / md:relative) via $attributes. The trigger slot must carry data-dropdown-trigger. --}}
<div data-dropdown {{ $attributes }}>
    {{ $trigger }}
    <div @if ($panelId) id="{{ $panelId }}" @endif data-dropdown-panel role="menu"
         class="hidden absolute left-0 z-20 mt-1 max-w-[calc(100vw-2rem)] origin-top-left rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md transition duration-150 motion-reduce:transition-none data-[state=closed]:scale-95 data-[state=closed]:opacity-0 {{ $panelClass }}">
        {{ $slot }}
    </div>
</div>
