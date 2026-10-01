@extends('layouts.app')

@section('title', 'Upload Logs - HLS R2 Studio')
@section('page-title', 'Upload Logs')
@section('breadcrumb', 'Home / Upload Logs')

@section('content')
    <div class="flex items-center justify-end mb-3.5">
        <button type="button" onclick="window.location.reload()"
                class="inline-flex items-center gap-2 rounded-lg bg-white border border-gray-200 shadow-sm px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <x-lucide-refresh-cw class="w-4 h-4" /> Refresh
        </button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-3.5">
        <div class="rounded-2xl bg-white border border-gray-200 shadow-sm p-4">
            <div class="w-11 h-11 rounded-full flex items-center justify-center bg-blue-50 mb-3">
                <x-lucide-upload class="w-5 h-5 text-blue-600" />
            </div>
            <div class="text-2xl font-bold text-gray-900 leading-tight">{{ $totalCount }}</div>
            <div class="text-sm text-gray-500 mt-1">Total Uploads</div>
        </div>
        <div class="rounded-2xl bg-white border border-gray-200 shadow-sm p-4">
            <div class="w-11 h-11 rounded-full flex items-center justify-center bg-emerald-50 mb-3">
                <x-lucide-circle-check class="w-5 h-5 text-emerald-600" />
            </div>
            <div class="text-2xl font-bold text-gray-900 leading-tight">{{ $successCount }}</div>
            <div class="text-sm text-gray-500 mt-1">Successful</div>
        </div>
        <div class="rounded-2xl bg-white border border-gray-200 shadow-sm p-4">
            <div class="w-11 h-11 rounded-full flex items-center justify-center bg-rose-50 mb-3">
                <x-lucide-circle-x class="w-5 h-5 text-rose-600" />
            </div>
            <div class="text-2xl font-bold text-gray-900 leading-tight">{{ $errorCount }}</div>
            <div class="text-sm text-gray-500 mt-1">Failed</div>
        </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        <div class="rounded-2xl border border-gray-200 overflow-hidden bg-white">
            <div class="bg-rose-600 px-4 py-2.5 flex items-center justify-between">
                <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-x class="w-4 h-4" /> Error Logs</h3>
                <span class="text-xs font-semibold text-white/90">{{ $errorCount }}</span>
            </div>
            <div class="divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
                @forelse ($errorLogs as $log)
                    <div class="px-4 py-3">
                        <div class="flex items-center justify-between gap-2">
                            <div class="font-medium text-gray-900 text-sm truncate">{{ $log->title }}</div>
                            <div class="text-xs text-gray-400 whitespace-nowrap shrink-0">{{ $log->created_at->toDisplay() }}</div>
                        </div>
                        <div class="text-xs text-gray-500 truncate">{{ $log->original_filename }}</div>
                        @if ($log->error_message)
                            <div class="text-xs text-rose-600 mt-1 line-clamp-3">{{ $log->error_message }}</div>
                        @endif
                    </div>
                @empty
                    <div class="px-4 py-6 text-center text-sm text-gray-500">No error logs.</div>
                @endforelse
            </div>
        </div>

        <div class="rounded-2xl border border-gray-200 overflow-hidden bg-white">
            <div class="bg-emerald-600 px-4 py-2.5 flex items-center justify-between">
                <h3 class="text-sm font-semibold text-white inline-flex items-center gap-2"><x-lucide-circle-check class="w-4 h-4" /> Success Logs</h3>
                <span class="text-xs font-semibold text-white/90">{{ $successCount }}</span>
            </div>
            <div class="divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
                @forelse ($successLogs as $log)
                    <div class="px-4 py-3">
                        <div class="flex items-center justify-between gap-2">
                            <div class="font-medium text-gray-900 text-sm truncate">{{ $log->title }}</div>
                            <div class="text-xs text-gray-400 whitespace-nowrap shrink-0">{{ $log->created_at->toDisplay() }}</div>
                        </div>
                        <div class="text-xs text-gray-500 truncate">{{ $log->original_filename }}</div>
                        <a href="{{ route('videos.index') }}" class="text-xs font-medium text-emerald-700 hover:underline">View in list</a>
                    </div>
                @empty
                    <div class="px-4 py-6 text-center text-sm text-gray-500">No success logs.</div>
                @endforelse
            </div>
        </div>
    </div>
@endsection
