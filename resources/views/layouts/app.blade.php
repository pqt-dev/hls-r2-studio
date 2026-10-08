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
<body class="bg-background text-sm text-foreground antialiased">
    <div id="sidebar-backdrop" class="fixed inset-0 z-40 hidden bg-black/50 md:hidden" aria-hidden="true"></div>

    <div class="flex min-h-screen">
        <aside id="app-sidebar" class="fixed inset-y-0 left-0 z-50 w-64 md:max-lg:w-16 max-md:-translate-x-full max-md:invisible overflow-y-auto transition-[transform,visibility] duration-200 md:static md:z-auto md:overflow-visible shrink-0 bg-muted text-foreground border-r border-border flex flex-col">
            <div class="px-6 py-5 md:max-lg:px-0 border-b border-border flex items-center md:max-lg:justify-center gap-3 bg-background">
                <div class="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0 shadow-sm p-1.5">
                    <img src="{{ asset('img/logo.png') }}" alt="Logo" class="w-full h-full">
                </div>
                <div class="leading-tight md:max-lg:hidden">
                    <div class="text-base font-semibold text-foreground tracking-tight">HLS R2 Studio</div>
                    <div class="text-[11px] text-muted-foreground">Cloud Video Platform</div>
                </div>
            </div>
            <nav class="flex-1 px-3 md:max-lg:px-2 py-4 space-y-4">
                <div>
                    <p class="px-1 mb-2 md:max-lg:hidden text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dashboard</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 md:max-lg:p-1 space-y-1">
                        <a href="{{ route('dashboard.overview') }}"
                           title="Overview"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('dashboard.overview') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-layout-dashboard class="w-4 h-4 text-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Overview</span>
                        </a>
                        <a href="{{ route('logs.index') }}"
                           title="Logs"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('logs.index') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-scroll-text class="w-4 h-4 text-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Logs</span>
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 md:max-lg:hidden text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Video</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 md:max-lg:p-1 space-y-1">
                        <a href="{{ route('videos.index') }}"
                           title="Videos"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('videos.index') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-video class="w-4 h-4 text-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Videos</span>
                        </a>
                        <a href="{{ route('videos.create') }}"
                           title="Upload Video"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('videos.create') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-upload class="w-4 h-4 text-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Upload Video</span>
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 md:max-lg:hidden text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">System</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 md:max-lg:p-1 space-y-1">
                        <a href="{{ route('reports.index') }}"
                           title="Reports"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('reports.index') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-flag class="w-4 h-4 text-muted-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Reports</span>
                        </a>
                        <a href="{{ route('settings.edit') }}"
                           title="Settings"
                           class="flex items-center md:max-lg:justify-center gap-2.5 rounded-md px-2.5 md:max-lg:px-0 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('settings.edit') ? 'bg-primary text-primary-foreground shadow-sm [&>span:first-child]:bg-transparent [&_svg]:text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-settings class="w-4 h-4 text-muted-foreground" />
                            </span>
                            <span class="md:max-lg:sr-only">Settings</span>
                        </a>
                    </div>
                </div>

                <div>
                    <form action="{{ route('logout') }}" method="POST">
                        @csrf
                        <button type="submit" onclick="return confirmLogout(this.form)" title="Log out"
                                class="flex w-full items-center md:max-lg:justify-center gap-2.5 rounded-md bg-background border border-border shadow-sm px-2.5 md:max-lg:px-0 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-destructive/10">
                                <x-lucide-log-out class="w-4 h-4 text-destructive" />
                            </span>
                            <span class="md:max-lg:sr-only">Log out ({{ auth()->user()->username }})</span>
                        </button>
                    </form>
                </div>
            </nav>
        </aside>

        <div class="flex-1 min-w-0 flex flex-col">
            <header class="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background px-4 py-2.5 md:hidden">
                <button type="button" id="sidebar-toggle" aria-label="Open navigation menu" aria-controls="app-sidebar" aria-expanded="false"
                        class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <x-lucide-menu class="w-5 h-5" />
                </button>
                <img src="{{ asset('img/logo.png') }}" alt="Logo" class="w-8 h-8 shrink-0">
                <span class="truncate text-base font-semibold tracking-tight text-foreground">HLS R2 Studio</span>
            </header>

            <main class="flex-1 p-4 md:p-8">
                <div class="mb-6 pb-4 border-b border-border">
                    <h1 class="text-2xl font-semibold tracking-tight text-foreground break-words">@yield('page-title', 'HLS R2 Studio')</h1>
                    <p class="mt-1 text-sm text-muted-foreground">@yield('breadcrumb', 'Home')</p>
                </div>

                @if (session('success'))
                    <x-ui.alert variant="success" class="mb-6">
                        <x-lucide-circle-check class="w-4 h-4 shrink-0" /> <span class="min-w-0 break-words">{{ session('success') }}</span>
                    </x-ui.alert>
                @endif

                @if (session('error'))
                    <x-ui.alert variant="destructive" class="mb-6">
                        <x-lucide-circle-x class="w-4 h-4 shrink-0" /> <span class="min-w-0 break-words">{{ session('error') }}</span>
                    </x-ui.alert>
                @endif

                @if ($errors->any())
                    <x-ui.alert variant="destructive" class="mb-6">
                        <ul class="list-disc list-inside">
                            @foreach ($errors->all() as $error)
                                <li>{{ $error }}</li>
                            @endforeach
                        </ul>
                    </x-ui.alert>
                @endif

                @yield('content')
            </main>
        </div>
    </div>

    <a href="{{ route('logs.index') }}" id="in-progress-ring" data-in-progress-ring data-state="active"
       data-count-url="{{ route('videos.in-progress-count') }}"
       data-videos="{{ json_encode($inProgressVideos) }}"
       data-progress-stages="{{ json_encode(config('videos.progress.stages')) }}"
       @if (count($inProgressVideos) < 1) hidden @endif
       title="Processing videos"
       class="ip-ring fixed z-20 flex h-16 w-16 items-center justify-center rounded-full sm:h-[72px] sm:w-[72px]"
       style="right: max(1rem, env(safe-area-inset-right)); bottom: max(1rem, env(safe-area-inset-bottom));">
        <span class="ip-ring-glow" aria-hidden="true"></span>
        <svg class="ip-ring-spin absolute inset-0 h-full w-full" viewBox="0 0 72 72" fill="none" aria-hidden="true">
            <circle cx="36" cy="36" r="34" stroke="rgb(255 255 255 / 0.55)" stroke-width="2" stroke-linecap="round" stroke-dasharray="36 178" />
        </svg>
        <svg class="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 72 72" fill="none" aria-hidden="true">
            <defs>
                <linearGradient id="in-progress-ring-gradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#fbbf24" />
                    <stop offset="1" stop-color="#f97316" />
                </linearGradient>
            </defs>
            <circle cx="36" cy="36" r="30" stroke="rgb(255 255 255 / 0.15)" stroke-width="5" />
            <circle cx="36" cy="36" r="30" class="ip-ring-progress" stroke-width="5" stroke-linecap="round" stroke-dasharray="188.5" stroke-dashoffset="188.5" data-ring-progress />
        </svg>
        <span class="ip-ring-label relative text-[15px] font-extrabold leading-none tabular-nums sm:text-[18px]" aria-hidden="true" data-ring-label></span>
        <svg class="ip-ring-check relative h-7 w-7 sm:h-8 sm:w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span class="sr-only" role="status" aria-live="polite" data-ring-status></span>
    </a>

    <x-ui.dialog id="confirm-modal" role="alertdialog" class="z-[60] p-4" panelClass="max-w-sm" initialFocus="panel" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-message">
        <div class="grid gap-4 p-6">
            <x-ui.dialog-header class="flex-row items-start gap-3">
                <span id="confirm-modal-icon-wrap" class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-destructive/10">
                    <x-lucide-triangle-alert id="confirm-modal-icon" class="w-5 h-5 text-destructive" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5 pr-6">
                    <x-ui.dialog-title id="confirm-modal-title" class="text-base"></x-ui.dialog-title>
                    <x-ui.dialog-description id="confirm-modal-message" class="break-words"></x-ui.dialog-description>
                </div>
            </x-ui.dialog-header>
            <x-ui.dialog-footer>
                <x-ui.button variant="outline" id="confirm-modal-cancel">Cancel</x-ui.button>
                <x-ui.button variant="destructive" id="confirm-modal-confirm">Confirm</x-ui.button>
            </x-ui.dialog-footer>
        </div>
    </x-ui.dialog>

    <script>
        (function () {
            const modal = document.getElementById('confirm-modal');
            const iconWrap = document.getElementById('confirm-modal-icon-wrap');
            const icon = document.getElementById('confirm-modal-icon');
            const titleEl = document.getElementById('confirm-modal-title');
            const messageEl = document.getElementById('confirm-modal-message');
            const cancelBtn = document.getElementById('confirm-modal-cancel');
            const confirmBtn = document.getElementById('confirm-modal-confirm');

            const dangerIconWrapClasses = ['bg-destructive/10'];
            const dangerIconClasses = ['text-destructive'];
            const dangerConfirmClasses = ['bg-destructive', 'text-destructive-foreground', 'hover:bg-destructive/90'];

            const infoIconWrapClasses = ['bg-muted'];
            const infoIconClasses = ['text-foreground'];
            const infoConfirmClasses = ['bg-primary', 'text-primary-foreground', 'hover:bg-primary/90'];

            let activeResolve = null;

            function close(result) {
                window.uiDialog.close(modal);

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
                if (options.messageParts) {
                    messageEl.textContent = '';
                    options.messageParts.forEach(function (part) {
                        if (part.bold) {
                            const strong = document.createElement('strong');
                            strong.textContent = part.text;
                            messageEl.appendChild(strong);
                        } else {
                            messageEl.appendChild(document.createTextNode(part.text));
                        }
                    });
                } else {
                    messageEl.textContent = options.message || '';
                }
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

                // Escape, overlay click and the X button arrive as 'dialog:dismiss' (see below).
                // Initial focus: Cancel for destructive confirmations, Confirm otherwise. Enter then
                // activates the focused button natively.
                window.uiDialog.open(modal, { initialFocus: danger ? cancelBtn : confirmBtn });

                return new Promise(function (resolve) {
                    activeResolve = resolve;
                });
            }

            cancelBtn.addEventListener('click', function () {
                close(false);
            });

            confirmBtn.addEventListener('click', function () {
                close(true);
            });

            modal.addEventListener('dialog:dismiss', function (event) {
                event.preventDefault();
                close(false);
            });

            function confirmLogout(form) {
                confirmDialog({ title: 'Log out', message: 'Are you sure you want to log out?', confirmText: 'Log out', danger: true }).then(function (ok) {
                    if (!ok) return;
                    const btn = form.querySelector('button[type="submit"]');
                    btn.disabled = true;
                    btn.textContent = 'Logging out...';
                    btn.classList.add('opacity-60', 'cursor-not-allowed');
                    form.submit();
                });
                return false;
            }

            window.confirmDialog = confirmDialog;
            window.confirmLogout = confirmLogout;
        })();
    </script>

    @stack('scripts')
</body>
</html>
