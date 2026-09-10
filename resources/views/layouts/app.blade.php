<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'HLS R2 Studio')</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-gray-100 text-gray-800">
    <div class="flex min-h-screen">
        <aside class="w-64 shrink-0 bg-emerald-50 text-gray-700 border-r border-gray-200 flex flex-col">
            <div class="px-6 py-5 text-lg font-semibold text-gray-900 border-b border-gray-200">
                HLS R2 Studio
            </div>
            <nav class="flex-1 px-3 py-4">
                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Tổng quan</p>
                <div class="space-y-1 mb-4">
                    <a href="{{ route('dashboard.overview') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('dashboard.overview') ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <span>🏠</span> Tổng quan
                    </a>
                    <a href="{{ route('logs.index') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('logs.index') ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <span>📜</span> Nhật ký
                    </a>
                </div>

                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Video</p>
                <div class="space-y-1">
                    <a href="{{ route('videos.index') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('videos.index') ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <span>🎞️</span> Danh sách video
                    </a>
                    <a href="{{ route('videos.create') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('videos.create') ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <span>⬆️</span> Tải lên video
                    </a>
                </div>

                <p class="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Hệ thống</p>
                <div class="space-y-1">
                    <a href="{{ route('settings.edit') }}"
                       class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium {{ request()->routeIs('settings.edit') ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-emerald-100 hover:text-gray-900' }}">
                        <span>⚙️</span> Cài đặt
                    </a>
                </div>
            </nav>

            <div class="px-3 py-4 border-t border-gray-200">
                <form action="{{ route('logout') }}" method="POST">
                    @csrf
                    <button type="submit"
                            class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 hover:text-red-700">
                        <span>🚪</span> Đăng xuất ({{ auth()->user()->email }})
                    </button>
                </form>
            </div>
        </aside>

        <div class="flex-1 flex flex-col">
            <main class="flex-1 p-8">
                <div class="mb-6">
                    <h1 class="text-2xl font-bold text-gray-900">@yield('page-title', 'HLS R2 Studio')</h1>
                    <p class="mt-1 text-xs text-gray-500">@yield('breadcrumb', 'Trang chủ')</p>
                </div>

                @if (session('success'))
                    <div class="mb-6 rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">
                        {{ session('success') }}
                    </div>
                @endif

                @if (session('error'))
                    <div class="mb-6 rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
                        {{ session('error') }}
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
