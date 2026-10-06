@extends('layouts.app')

@section('title', 'Upload Logs - HLS R2 Studio')
@section('page-title', 'Upload Logs')
@section('breadcrumb', 'Home / Upload Logs')

@section('content')
    <div class="flex items-center justify-end mb-3.5">
        <x-ui.button variant="outline" onclick="window.location.reload()">
            <x-lucide-refresh-cw class="w-4 h-4" /> Refresh
        </x-ui.button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-3.5">
        <x-ui.card>
            <x-ui.card-content>
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-muted mb-3">
                    <x-lucide-upload class="w-5 h-5 text-foreground" />
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $totalCount }}</div>
                <div class="text-sm text-muted-foreground mt-1">Total Uploads</div>
            </x-ui.card-content>
        </x-ui.card>
        <x-ui.card>
            <x-ui.card-content>
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-emerald-50 mb-3">
                    <x-lucide-circle-check class="w-5 h-5 text-emerald-600" />
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $successCount }}</div>
                <div class="text-sm text-muted-foreground mt-1">Successful</div>
            </x-ui.card-content>
        </x-ui.card>
        <x-ui.card>
            <x-ui.card-content>
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-rose-50 mb-3">
                    <x-lucide-circle-x class="w-5 h-5 text-rose-600" />
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $errorCount }}</div>
                <div class="text-sm text-muted-foreground mt-1">Failed</div>
            </x-ui.card-content>
        </x-ui.card>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        <x-ui.card class="overflow-hidden">
            <div class="bg-rose-600 px-4 py-2.5 flex items-center justify-between">
                <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-x class="w-4 h-4" /> Error Logs</h3>
                <span class="text-xs font-semibold text-white/90">{{ $errorCount }}</span>
            </div>
            <div class="divide-y divide-border max-h-[480px] overflow-y-auto">
                @forelse ($errorLogs as $log)
                    <div class="px-4 py-3">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0 font-medium text-foreground text-sm truncate">{{ $log->title }}</div>
                            <div class="text-xs text-muted-foreground whitespace-nowrap shrink-0">{{ $log->created_at->toDisplay() }}</div>
                        </div>
                        <div class="text-xs text-muted-foreground truncate">{{ $log->original_filename }}</div>
                        @if ($log->error_message)
                            <div class="text-xs text-rose-600 mt-1 line-clamp-3 break-words">{{ $log->error_message }}</div>
                        @endif
                    </div>
                @empty
                    <div class="px-4 py-6 text-center text-sm text-muted-foreground">No error logs.</div>
                @endforelse
            </div>
        </x-ui.card>

        <x-ui.card class="overflow-hidden">
            <div class="bg-emerald-600 px-4 py-2.5 flex items-center justify-between">
                <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-check class="w-4 h-4" /> Success Logs</h3>
                <span class="text-xs font-semibold text-white/90">{{ $successCount }}</span>
            </div>
            <div class="divide-y divide-border max-h-[480px] overflow-y-auto">
                @forelse ($successLogs as $log)
                    <div class="px-4 py-3">
                        <div class="flex items-center justify-between gap-2">
                            <div class="min-w-0 font-medium text-foreground text-sm truncate">{{ $log->title }}</div>
                            <div class="text-xs text-muted-foreground whitespace-nowrap shrink-0">{{ $log->created_at->toDisplay() }}</div>
                        </div>
                        <div class="text-xs text-muted-foreground truncate">{{ $log->original_filename }}</div>
                        <a href="{{ route('videos.index') }}" class="text-xs font-medium text-emerald-700 hover:underline">View in list</a>
                    </div>
                @empty
                    <div class="px-4 py-6 text-center text-sm text-muted-foreground">No success logs.</div>
                @endforelse
            </div>
        </x-ui.card>
    </div>
@endsection
