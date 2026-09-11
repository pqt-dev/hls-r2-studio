@extends('layouts.app')

@section('title', 'Overview - HLS R2 Studio')
@section('page-title', 'Overview')
@section('breadcrumb', 'Home / Overview')

@section('content')
    <div class="bg-white -m-8 p-8">
    <div class="rounded-[22px] p-6 relative overflow-hidden border mb-3.5" style="background:linear-gradient(135deg,rgba(16,185,129,.14),rgba(16,185,129,.08) 42%,rgba(255,255,255,.98));border-color:rgba(16,185,129,.16);box-shadow:0 18px 42px rgba(16,185,129,.08)">
        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-extrabold mb-3 bg-emerald-100 text-emerald-700"><x-lucide-layout-dashboard class="w-3.5 h-3.5" /> DASHBOARD OVERVIEW</div>
        <h2 class="text-[28px] leading-tight font-bold mb-2 text-gray-900">System Overview</h2>
        <p class="text-sm text-gray-500 max-w-xl">Quickly manage the entire upload, HLS transcoding, and video storage workflow on Cloudflare R2.</p>
    </div>

    <div class="bg-white rounded-[22px] p-4 border border-gray-200 flex flex-col justify-between gap-3 mb-3.5" style="box-shadow:0px 1px 4px 0px #8592ad33">
        <div class="flex items-center gap-3">
            <div class="w-14 h-14 rounded-2xl flex items-center justify-center bg-emerald-100"><x-lucide-clapperboard class="w-7 h-7 text-emerald-700" /></div>
            <div>
                <div class="font-extrabold text-gray-900 mb-1">Welcome back!</div>
                <div class="text-gray-500 text-sm">{{ now()->translatedFormat('l, d/m/Y H:i') }}</div>
            </div>
        </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-3.5">
        <div class="relative overflow-hidden rounded-xl bg-sky-500 text-white shadow-sm">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $cpuPercent !== null ? $cpuPercent.'%' : '—' }}</div>
                <div class="text-sm text-white/90 mt-1">System CPU</div>
                <div class="text-xs text-white/75 mt-1">Core: {{ $cpuCores ?? '—' }} • Load 1m: {{ $loadAvg1min ?? '—' }}</div>
            </div>
            <x-lucide-cpu class="w-14 h-14 absolute -right-2 -top-2 text-white/20" />
        </div>

        <div class="relative overflow-hidden rounded-xl bg-violet-500 text-white shadow-sm">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $ramPercent !== null ? $ramPercent.'%' : '—' }}</div>
                <div class="text-sm text-white/90 mt-1">System RAM</div>
                <div class="text-xs text-white/75 mt-1">Used: {{ $ramUsedGb ?? '—' }} GB / {{ $ramTotalGb ?? '—' }} GB</div>
            </div>
            <x-lucide-memory-stick class="w-14 h-14 absolute -right-2 -top-2 text-white/20" />
        </div>

        <div class="relative overflow-hidden rounded-xl bg-orange-500 text-white shadow-sm">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $diskPercent }}%</div>
                <div class="text-sm text-white/90 mt-1">Server Disk</div>
                <div class="text-xs text-white/75 mt-1">Used: {{ $diskUsedGb ?? '—' }} GB / {{ $diskTotalGb ?? '—' }} GB</div>
            </div>
            <x-lucide-hard-drive class="w-14 h-14 absolute -right-2 -top-2 text-white/20" />
        </div>

        <a href="{{ route('videos.index') }}" class="group relative overflow-hidden rounded-xl bg-indigo-500 text-white shadow-sm hover:bg-indigo-600 transition-colors block">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $totalVideos }}</div>
                <div class="text-sm text-white/90 mt-1">Total Videos</div>
            </div>
            <x-lucide-video class="w-20 h-20 absolute -right-3 -top-3 text-white/20" />
            <div class="relative z-10 border-t border-white/20 px-4 py-2 text-xs font-medium flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        <a href="{{ route('videos.index', ['status' => 'ready']) }}" class="group relative overflow-hidden rounded-xl bg-emerald-500 text-white shadow-sm hover:bg-emerald-600 transition-colors block">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $readyCount }}</div>
                <div class="text-sm text-white/90 mt-1">Ready</div>
            </div>
            <x-lucide-circle-check class="w-20 h-20 absolute -right-3 -top-3 text-white/20" />
            <div class="relative z-10 border-t border-white/20 px-4 py-2 text-xs font-medium flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        <a href="{{ route('videos.index', ['status' => 'processing']) }}" class="group relative overflow-hidden rounded-xl bg-amber-500 text-white shadow-sm hover:bg-amber-600 transition-colors block">
            <div class="relative z-10 p-4">
                <div class="text-3xl font-bold leading-tight">{{ $processingCount }}</div>
                <div class="text-sm text-white/90 mt-1">Processing</div>
            </div>
            <x-lucide-loader-circle class="w-20 h-20 absolute -right-3 -top-3 text-white/20" />
            <div class="relative z-10 border-t border-white/20 px-4 py-2 text-xs font-medium flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        @if ($failedCount > 0)
            <a href="{{ route('videos.index', ['status' => 'failed']) }}" class="group relative overflow-hidden rounded-xl bg-rose-500 text-white shadow-sm hover:bg-rose-600 transition-colors block">
                <div class="relative z-10 p-4">
                    <div class="text-3xl font-bold leading-tight">{{ $failedCount }}</div>
                    <div class="text-sm text-white/90 mt-1">Failed</div>
                </div>
                <x-lucide-circle-x class="w-20 h-20 absolute -right-3 -top-3 text-white/20" />
                <div class="relative z-10 border-t border-white/20 px-4 py-2 text-xs font-medium flex items-center justify-between">
                    <span>View details</span>
                    <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </div>
            </a>
        @endif
    </div>
    </div>
@endsection
