@extends('layouts.app')

@section('title', 'Nhật ký upload - HLS R2 Studio')
@section('page-title', 'Nhật ký upload')
@section('breadcrumb', 'Trang chủ / Nhật ký upload')

@section('content')
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3.5">
        <div class="rounded-xl p-3 bg-white border" style="border-color:#e0e6eb">
            <div class="text-xs text-gray-500 mb-1">Tổng số lần upload</div>
            <div class="text-2xl font-bold text-gray-900">{{ $totalCount }}</div>
        </div>
        <div class="rounded-xl p-3 bg-white border" style="border-color:#e0e6eb">
            <div class="text-xs text-gray-500 mb-1">Thành công</div>
            <div class="text-2xl font-bold text-green-600">{{ $successCount }}</div>
        </div>
        <div class="rounded-xl p-3 bg-white border" style="border-color:#e0e6eb">
            <div class="text-xs text-gray-500 mb-1">Lỗi</div>
            <div class="text-2xl font-bold text-red-600">{{ $errorCount }}</div>
        </div>
    </div>

    <div class="rounded-xl border overflow-hidden bg-white" style="border-color:#e0e6eb">
        <div class="grid grid-cols-[88px_minmax(110px,130px)_minmax(0,1fr)_minmax(120px,150px)] gap-2 items-center px-3 py-2.5 text-xs font-extrabold" style="background:#d1fae5;color:#059669">
            <div class="text-center">Trạng thái</div>
            <div class="text-center">Thời gian</div>
            <div>Video</div>
            <div class="text-center">Thao tác</div>
        </div>
        @forelse ($logs as $log)
            <div class="grid grid-cols-[88px_minmax(110px,130px)_minmax(0,1fr)_minmax(120px,150px)] gap-2.5 items-start px-3 py-2.5 border-t"
                 style="border-color:#e0e6eb; {{ $log->status === 'ready' ? 'background:#f8fffb;border-color:#bbf7d0' : ($log->status === 'failed' ? 'background:#fff7f7;border-color:#fecaca' : '') }}">
                <div class="text-center text-xl">
                    @if ($log->status === 'ready') ✅
                    @elseif ($log->status === 'failed') ❌
                    @else ⏳
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
                        <a href="{{ route('videos.index') }}" class="text-xs font-medium text-emerald-600 hover:underline">Xem trong danh sách</a>
                    @else
                        <span class="text-xs text-gray-400">—</span>
                    @endif
                </div>
            </div>
        @empty
            <div class="px-3 py-6 text-center text-sm text-gray-500">Chưa có log nào.</div>
        @endforelse
    </div>

    <div class="mt-4">
        {{ $logs->links() }}
    </div>
@endsection
