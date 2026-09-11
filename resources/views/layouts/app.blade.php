<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'HLS R2 Studio')</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-white text-gray-800">
    <div class="flex min-h-screen">
        <aside class="w-64 shrink-0 bg-emerald-50 text-gray-700 border-r border-gray-200 flex flex-col">
            <div class="px-6 py-5 border-b border-gray-200 flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-lg bg-emerald-700 flex items-center justify-center shrink-0">
                    <x-lucide-clapperboard class="w-4 h-4 text-white" />
                </div>
                <span class="text-lg font-semibold text-gray-900">HLS R2 Studio</span>
            </div>
            <nav class="flex-1 px-3 py-4">
                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Overview</p>
                <div class="space-y-1 mb-4">
                    <a href="{{ route('dashboard.overview') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('dashboard.overview') ? 'bg-emerald-700 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <x-lucide-layout-dashboard class="w-4 h-4 shrink-0" /> Overview
                    </a>
                    <a href="{{ route('logs.index') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('logs.index') ? 'bg-emerald-700 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <x-lucide-scroll-text class="w-4 h-4 shrink-0" /> Logs
                    </a>
                </div>

                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Video</p>
                <div class="space-y-1">
                    <a href="{{ route('videos.index') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('videos.index') ? 'bg-emerald-700 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <x-lucide-video class="w-4 h-4 shrink-0" /> Videos
                    </a>
                    <a href="{{ route('videos.create') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('videos.create') ? 'bg-emerald-700 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <x-lucide-upload class="w-4 h-4 shrink-0" /> Upload Video
                    </a>
                </div>

                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">System</p>
                <div class="space-y-1">
                    <a href="{{ route('settings.edit') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('settings.edit') ? 'bg-emerald-700 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <x-lucide-settings class="w-4 h-4 shrink-0" /> Settings
                    </a>
                </div>
            </nav>

            <div class="px-3 py-4 border-t border-gray-200">
                <form action="{{ route('logout') }}" method="POST">
                    @csrf
                    <button type="submit"
                            class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 hover:text-red-700">
                        <x-lucide-log-out class="w-4 h-4 shrink-0" /> Log out ({{ auth()->user()->username }})
                    </button>
                </form>
            </div>
        </aside>

        <div class="flex-1 flex flex-col">
            <main class="flex-1 p-8">
                <div class="mb-6 pb-4 border-b border-gray-200">
                    <h1 class="text-2xl font-bold text-gray-900">@yield('page-title', 'HLS R2 Studio')</h1>
                    <p class="mt-1 text-xs text-gray-500">@yield('breadcrumb', 'Home')</p>
                </div>

                @if (session('success'))
                    <div class="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm flex items-center gap-2">
                        <x-lucide-circle-check class="w-4 h-4 shrink-0" /> {{ session('success') }}
                    </div>
                @endif

                @if (session('error'))
                    <div class="mb-6 rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm flex items-center gap-2">
                        <x-lucide-circle-x class="w-4 h-4 shrink-0" /> {{ session('error') }}
                    </div>
                @endif

                @if ($errors->any())
                    <div class="mb-6 rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
                        <ul class="list-disc list-inside">
                            @foreach ($errors->all() as $error)
                                <li>{{ $error }}</li>
                            @endforeach
                        </ul>
                    </div>
                @endif

                @yield('content')
            </main>
        </div>
    </div>

    @stack('scripts')
</body>
</html>
