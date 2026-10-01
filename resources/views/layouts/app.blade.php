<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title', 'HLS R2 Studio')</title>
    <link rel="icon" type="image/x-icon" href="{{ asset('favicon.ico') }}">
    <link rel="apple-touch-icon" href="{{ asset('apple-touch-icon.png') }}">
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-white text-gray-800">
    <div class="flex min-h-screen">
        <aside class="w-64 shrink-0 bg-gray-50 text-gray-700 border-r border-gray-200 flex flex-col">
            <div class="px-6 py-5 border-b border-gray-200 flex items-center gap-3 bg-gradient-to-br from-cyan-50 via-teal-50 to-white">
                <div class="w-10 h-10 rounded-xl bg-white border border-gray-200 flex items-center justify-center shrink-0 shadow-sm p-1.5">
                    <img src="{{ asset('img/logo.png') }}" alt="Logo" class="w-full h-full">
                </div>
                <div class="leading-tight">
                    <div class="text-base font-extrabold text-gray-900 tracking-tight">HLS R2 Studio</div>
                    <div class="text-[11px] text-gray-500">Cloud Video Platform</div>
                </div>
            </div>
            <nav class="flex-1 px-3 py-4 space-y-4">
                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Dashboard</p>
                    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('dashboard.overview') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('dashboard.overview') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-rose-50">
                                <x-lucide-layout-dashboard class="w-4 h-4 text-rose-600" />
                            </span>
                            Overview
                        </a>
                        <a href="{{ route('logs.index') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('logs.index') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-amber-50">
                                <x-lucide-scroll-text class="w-4 h-4 text-amber-600" />
                            </span>
                            Logs
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Video</p>
                    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('videos.index') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('videos.index') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-sky-50">
                                <x-lucide-video class="w-4 h-4 text-sky-600" />
                            </span>
                            Videos
                        </a>
                        <a href="{{ route('videos.create') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('videos.create') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-50">
                                <x-lucide-upload class="w-4 h-4 text-blue-600" />
                            </span>
                            Upload Video
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">System</p>
                    <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('reports.index') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('reports.index') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-gray-100">
                                <x-lucide-flag class="w-4 h-4 text-gray-600" />
                            </span>
                            Reports
                        </a>
                        <a href="{{ route('settings.edit') }}"
                           class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium {{ request()->routeIs('settings.edit') ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-gray-100">
                                <x-lucide-settings class="w-4 h-4 text-gray-600" />
                            </span>
                            Settings
                        </a>
                    </div>
                </div>
            </nav>

            <div class="px-3 py-4">
                <form action="{{ route('logout') }}" method="POST">
                    @csrf
                    <button type="submit"
                            class="flex w-full items-center gap-2.5 rounded-xl bg-white border border-gray-200 shadow-sm px-2.5 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
                        <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-red-50">
                            <x-lucide-log-out class="w-4 h-4 text-red-600" />
                        </span>
                        Log out ({{ auth()->user()->username }})
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

    <div id="confirm-modal" class="fixed inset-0 z-[60] hidden items-center justify-center bg-black/50 p-4">
        <div class="bg-white rounded-2xl overflow-hidden w-full max-w-sm shadow-xl">
            <div class="p-5">
                <div class="flex items-start gap-3">
                    <span id="confirm-modal-icon-wrap" class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-red-50">
                        <x-lucide-triangle-alert id="confirm-modal-icon" class="w-5 h-5 text-red-600" />
                    </span>
                    <div class="flex-1 pt-0.5">
                        <h3 id="confirm-modal-title" class="text-sm font-semibold text-gray-900"></h3>
                        <p id="confirm-modal-message" class="mt-1 text-sm text-gray-500"></p>
                    </div>
                </div>
            </div>
            <div class="flex justify-end gap-2 px-5 py-3 bg-gray-50 border-t border-gray-200">
                <button type="button" id="confirm-modal-cancel"
                        class="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                    Cancel
                </button>
                <button type="button" id="confirm-modal-confirm"
                        class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">
                    Confirm
                </button>
            </div>
        </div>
    </div>

    <script>
        (function () {
            const modal = document.getElementById('confirm-modal');
            const iconWrap = document.getElementById('confirm-modal-icon-wrap');
            const icon = document.getElementById('confirm-modal-icon');
            const titleEl = document.getElementById('confirm-modal-title');
            const messageEl = document.getElementById('confirm-modal-message');
            const cancelBtn = document.getElementById('confirm-modal-cancel');
            const confirmBtn = document.getElementById('confirm-modal-confirm');

            const dangerIconWrapClasses = ['bg-red-50'];
            const dangerIconClasses = ['text-red-600'];
            const dangerConfirmClasses = ['bg-red-600', 'hover:bg-red-700'];

            const infoIconWrapClasses = ['bg-blue-50'];
            const infoIconClasses = ['text-blue-700'];
            const infoConfirmClasses = ['bg-blue-700', 'hover:bg-blue-800'];

            let activeResolve = null;
            let keydownHandler = null;

            function close(result) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');

                if (keydownHandler) {
                    document.removeEventListener('keydown', keydownHandler);
                    keydownHandler = null;
                }

                if (activeResolve) {
                    const resolve = activeResolve;
                    activeResolve = null;
                    resolve(result);
                }
            }

            function confirmDialog(options) {
                options = options || {};
                const danger = options.danger !== false;

                titleEl.textContent = options.title || '';
                messageEl.textContent = options.message || '';
                cancelBtn.textContent = options.cancelText || 'Cancel';
                confirmBtn.textContent = options.confirmText || 'Confirm';

                iconWrap.classList.remove(...dangerIconWrapClasses, ...infoIconWrapClasses);
                icon.classList.remove(...dangerIconClasses, ...infoIconClasses);
                confirmBtn.classList.remove(...dangerConfirmClasses, ...infoConfirmClasses);

                if (danger) {
                    iconWrap.classList.add(...dangerIconWrapClasses);
                    icon.classList.add(...dangerIconClasses);
                    confirmBtn.classList.add(...dangerConfirmClasses);
                } else {
                    iconWrap.classList.add(...infoIconWrapClasses);
                    icon.classList.add(...infoIconClasses);
                    confirmBtn.classList.add(...infoConfirmClasses);
                }

                modal.classList.remove('hidden');
                modal.classList.add('flex');

                return new Promise(function (resolve) {
                    activeResolve = resolve;

                    keydownHandler = function (event) {
                        if (event.key === 'Escape') {
                            close(false);
                        } else if (event.key === 'Enter') {
                            close(true);
                        }
                    };
                    document.addEventListener('keydown', keydownHandler);
                });
            }

            cancelBtn.addEventListener('click', function () {
                close(false);
            });

            confirmBtn.addEventListener('click', function () {
                close(true);
            });

            modal.addEventListener('click', function (event) {
                if (event.target === modal) {
                    close(false);
                }
            });

            window.confirmDialog = confirmDialog;
        })();
    </script>

    @stack('scripts')
</body>
</html>
