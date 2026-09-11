@extends('layouts.app')

@section('title', 'Upload Logs - HLS R2 Studio')
@section('page-title', 'Upload Logs')
@section('breadcrumb', 'Home / Upload Logs')

@section('content')
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3.5">
        <div class="relative overflow-hidden rounded-xl bg-indigo-500 text-white p-3">
            <div class="text-xs text-white/90 mb-1">Total Uploads</div>
            <div class="text-2xl font-bold">{{ $totalCount }}</div>
            <x-lucide-upload class="w-12 h-12 absolute -right-2 -bottom-2 text-white/20" />
        </div>
        <div class="relative overflow-hidden rounded-xl bg-emerald-500 text-white p-3">
            <div class="text-xs text-white/90 mb-1">Successful</div>
            <div class="text-2xl font-bold">{{ $successCount }}</div>
            <x-lucide-circle-check class="w-12 h-12 absolute -right-2 -bottom-2 text-white/20" />
        </div>
        <div class="relative overflow-hidden rounded-xl bg-rose-500 text-white p-3">
            <div class="text-xs text-white/90 mb-1">Failed</div>
            <div class="text-2xl font-bold">{{ $errorCount }}</div>
            <x-lucide-circle-x class="w-12 h-12 absolute -right-2 -bottom-2 text-white/20" />
        </div>
    </div>

    <div class="rounded-xl border border-gray-200 overflow-hidden bg-white">
        <div class="grid grid-cols-[88px_minmax(110px,130px)_minmax(0,1fr)_minmax(120px,150px)] gap-2 items-center px-3 py-2.5 text-xs font-extrabold bg-emerald-100 text-emerald-800">
            <div class="text-center">Status</div>
            <div class="text-center">Time</div>
            <div>Video</div>
            <div class="text-center">Actions</div>
        </div>
        @forelse ($logs as $log)
            <div class="grid grid-cols-[88px_minmax(110px,130px)_minmax(0,1fr)_minmax(120px,150px)] gap-2.5 items-start px-3 py-2.5 border-t {{ $log->status === 'ready' ? 'bg-emerald-50 border-emerald-100' : ($log->status === 'failed' ? 'bg-rose-50 border-rose-100' : 'border-gray-100') }}">
                <div class="text-center">
                    @if ($log->status === 'ready')
                        <x-lucide-circle-check class="w-5 h-5 mx-auto text-emerald-600" />
                    @elseif ($log->status === 'failed')
                        <x-lucide-circle-x class="w-5 h-5 mx-auto text-red-600" />
                    @else
                        <x-lucide-loader-circle class="w-5 h-5 mx-auto text-amber-500" />
                    @endif
                </div>
                <div class="text-center text-xs text-gray-500">{{ $log->created_at->format('d/m/Y H:i') }}</div>
                <div class="min-w-0">
                    <div class="font-medium text-gray-900 text-sm truncate">{{ $log->title }}</div>
                    <div class="text-xs text-gray-500 truncate">{{ $log->original_filename }}</div>
                    @if ($log->status === 'failed' && $log->error_message)
                        <div class="text-xs text-red-600 mt-1 line-clamp-3">{{ $log->error_message }}</div>
                    @endif
                </div>
                <div class="text-center">
                    @if ($log->status === 'ready')
                        <a href="{{ route('videos.index') }}" class="text-xs font-medium text-emerald-700 hover:underline">View in list</a>
                    @else
                        <span class="text-xs text-gray-400">—</span>
                    @endif
                </div>
            </div>
        @empty
            <div class="px-3 py-6 text-center text-sm text-gray-500">No logs yet.</div>
        @endforelse
    </div>

    <div class="mt-4">
        {{ $logs->links() }}
    </div>
@endsection
