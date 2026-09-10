@extends('layouts.app')

@section('title', 'Tổng quan - HLS R2 Studio')
@section('page-title', 'Tổng quan')
@section('breadcrumb', 'Trang chủ / Tổng quan')

@section('content')
    <div class="rounded-[22px] p-6 relative overflow-hidden border mb-3.5" style="background:linear-gradient(135deg,rgba(16,185,129,.14),rgba(16,185,129,.08) 42%,rgba(255,255,255,.98));border-color:rgba(16,185,129,.16);box-shadow:0 18px 42px rgba(16,185,129,.08)">
        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-extrabold mb-3" style="background:rgba(16,185,129,.1);color:#047857">☁️ DASHBOARD TỔNG QUAN</div>
        <h2 class="text-[28px] leading-tight font-bold mb-2 text-gray-900">Tổng quan hệ thống</h2>
        <p class="text-sm text-gray-500 max-w-xl">Quản lý nhanh toàn bộ luồng upload, băm HLS và lưu trữ video trên Cloudflare R2.</p>
    </div>

    <div class="bg-white rounded-[22px] p-4 border flex flex-col justify-between gap-3 mb-3.5" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
        <div class="flex items-center gap-3">
            <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl" style="background:#d1fae5">🎬</div>
            <div>
                <div class="font-extrabold text-gray-900 mb-1">Chào mừng trở lại!</div>
                <div class="text-gray-500 text-sm">{{ now()->translatedFormat('l, d/m/Y H:i') }}</div>
            </div>
        </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-3.5">
        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">🖥️ CPU hệ thống</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $cpuPercent !== null ? $cpuPercent.'%' : 'N/A' }}</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Core: {{ $cpuCores ?? 'N/A' }} • Load 1m: {{ $loadAvg1min ?? 'N/A' }}</div>
        </div>

        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">🧠 RAM hệ thống</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $ramPercent !== null ? $ramPercent.'%' : 'N/A' }}</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Used: {{ $ramUsedGb ?? 'N/A' }} GB / {{ $ramTotalGb ?? 'N/A' }} GB</div>
        </div>

        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">💾 DiskDrive server</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $diskPercent }}%</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Used: {{ $diskUsedGb ?? 'N/A' }} GB / {{ $diskTotalGb ?? 'N/A' }} GB</div>
        </div>

        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">🎬 Tổng video</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $totalVideos }}</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Tất cả video trong thư viện</div>
        </div>

        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">✅ Sẵn sàng</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $readyCount }}</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Video đã xử lý xong</div>
        </div>

        <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
            <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
            <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">⏳ Đang xử lý</div>
            <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $processingCount }}</div>
            <div class="relative text-xs mt-1.5" style="color:#7b8893">Đang chờ/đang băm HLS</div>
        </div>

        @if ($failedCount > 0)
            <div class="relative overflow-hidden rounded-[10px] p-4 bg-white border" style="border-color:#e0e6eb;box-shadow:0px 1px 4px 0px #8592ad33">
                <div class="absolute rounded-full pointer-events-none" style="width:70px;height:70px;right:-18px;top:-18px;background:color-mix(in oklab, #059669 12%, transparent)"></div>
                <div class="relative text-xs uppercase tracking-wider mb-2" style="color:#7b8893;letter-spacing:.08em">❌ Lỗi</div>
                <div class="relative text-[28px] font-bold" style="color:#1f2a3d">{{ $failedCount }}</div>
                <div class="relative text-xs mt-1.5" style="color:#7b8893">Video xử lý thất bại</div>
            </div>
        @endif
    </div>
@endsection
