@extends('layouts.app')

@section('title', 'Overview - HLS R2 Studio')
@section('page-title', 'Overview')
@section('breadcrumb', 'Home / Overview')

@section('content')
    <div class="bg-background -m-4 p-4 md:-m-8 md:p-8">
    <div class="rounded-[22px] p-4 sm:p-6 relative overflow-hidden border mb-3.5" style="background:linear-gradient(135deg,rgba(99,102,241,.14),rgba(99,102,241,.08) 42%,rgba(255,255,255,.98));border-color:rgba(99,102,241,.16);box-shadow:0 18px 42px rgba(99,102,241,.08)">
        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-3 bg-secondary text-secondary-foreground"><x-lucide-layout-dashboard class="w-3.5 h-3.5" /> DASHBOARD OVERVIEW</div>
        <h2 class="text-2xl sm:text-[28px] leading-tight font-semibold mb-2 text-foreground">System Overview</h2>
        <p class="text-sm text-muted-foreground max-w-xl">Quickly manage the entire upload, HLS transcoding, and video storage workflow on Cloudflare R2.</p>
    </div>

    <div class="bg-background rounded-[22px] p-4 border border-border flex flex-col justify-between gap-3 mb-3.5" style="box-shadow:0px 1px 4px 0px #8592ad33">
        <div class="flex items-center gap-3">
            <div class="w-14 h-14 rounded-lg flex items-center justify-center bg-muted"><x-lucide-clapperboard class="w-7 h-7 text-foreground" /></div>
            <div>
                <div class="font-semibold text-foreground mb-1">Welcome back!</div>
                <div class="text-muted-foreground text-sm">{{ now()->translatedFormat('l, d/m/Y H:i') }}</div>
            </div>
        </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-3.5">
        <x-ui.card>
            <x-ui.card-content>
                <div class="flex items-center justify-between mb-3">
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-sky-50">
                        <x-lucide-cpu class="w-5 h-5 text-sky-600" />
                    </div>
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $cpuPercent !== null ? $cpuPercent.'%' : '—' }}</div>
                <div class="text-sm text-muted-foreground mt-1">System CPU</div>
                <div class="text-xs text-muted-foreground mt-1">Core: {{ $cpuCores ?? '—' }} • Load 1m: {{ $loadAvg1min ?? '—' }}</div>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card>
            <x-ui.card-content>
                <div class="flex items-center justify-between mb-3">
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-violet-50">
                        <x-lucide-memory-stick class="w-5 h-5 text-violet-600" />
                    </div>
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $ramPercent !== null ? $ramPercent.'%' : '—' }}</div>
                <div class="text-sm text-muted-foreground mt-1">System RAM</div>
                <div class="text-xs text-muted-foreground mt-1">Used: {{ $ramUsedGb ?? '—' }} GB / {{ $ramTotalGb ?? '—' }} GB</div>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card>
            <x-ui.card-content>
                <div class="flex items-center justify-between mb-3">
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-orange-50">
                        <x-lucide-hard-drive class="w-5 h-5 text-orange-600" />
                    </div>
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $diskPercent }}%</div>
                <div class="text-sm text-muted-foreground mt-1">Server Disk</div>
                <div class="text-xs text-muted-foreground mt-1">Used: {{ $diskUsedGb ?? '—' }} GB / {{ $diskTotalGb ?? '—' }} GB</div>
            </x-ui.card-content>
        </x-ui.card>

        <a href="{{ route('videos.index') }}" class="group rounded-lg bg-background border border-border shadow-sm p-6 block hover:border-foreground/30 hover:shadow-sm transition">
            <div class="flex items-center justify-between mb-3">
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-muted">
                    <x-lucide-video class="w-5 h-5 text-foreground" />
                </div>
            </div>
            <div class="text-2xl font-semibold text-foreground leading-tight">{{ $totalVideos }}</div>
            <div class="text-sm text-muted-foreground mt-1">Total Videos</div>
            <div class="border-t border-border pt-2 mt-3 text-xs font-medium text-foreground flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        <a href="{{ route('videos.index') }}" class="group rounded-lg bg-background border border-border shadow-sm p-6 block hover:border-emerald-300 hover:shadow-sm transition">
            <div class="flex items-center justify-between mb-3">
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-emerald-50">
                    <x-lucide-circle-check class="w-5 h-5 text-emerald-600" />
                </div>
            </div>
            <div class="text-2xl font-semibold text-foreground leading-tight">{{ $readyCount }}</div>
            <div class="text-sm text-muted-foreground mt-1">Ready</div>
            <div class="border-t border-border pt-2 mt-3 text-xs font-medium text-emerald-600 flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        <a href="{{ route('videos.index') }}" class="group rounded-lg bg-background border border-border shadow-sm p-6 block hover:border-amber-300 hover:shadow-sm transition">
            <div class="flex items-center justify-between mb-3">
                <div class="w-11 h-11 rounded-full flex items-center justify-center bg-amber-50">
                    <x-lucide-loader-circle class="w-5 h-5 text-amber-600" />
                </div>
            </div>
            <div class="text-2xl font-semibold text-foreground leading-tight">{{ $processingCount }}</div>
            <div class="text-sm text-muted-foreground mt-1">Processing</div>
            <div class="border-t border-border pt-2 mt-3 text-xs font-medium text-amber-600 flex items-center justify-between">
                <span>View details</span>
                <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </div>
        </a>

        @if ($failedCount > 0)
            <a href="{{ route('videos.index') }}" class="group rounded-lg bg-background border border-border shadow-sm p-6 block hover:border-rose-300 hover:shadow-sm transition">
                <div class="flex items-center justify-between mb-3">
                    <div class="w-11 h-11 rounded-full flex items-center justify-center bg-rose-50">
                        <x-lucide-circle-x class="w-5 h-5 text-rose-600" />
                    </div>
                </div>
                <div class="text-2xl font-semibold text-foreground leading-tight">{{ $failedCount }}</div>
                <div class="text-sm text-muted-foreground mt-1">Failed</div>
                <div class="border-t border-border pt-2 mt-3 text-xs font-medium text-rose-600 flex items-center justify-between">
                    <span>View details</span>
                    <x-lucide-arrow-right class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </div>
            </a>
        @endif
    </div>
    </div>
@endsection
