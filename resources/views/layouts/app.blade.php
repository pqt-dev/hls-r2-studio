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
        <aside id="app-sidebar" class="fixed inset-y-0 left-0 z-50 w-64 max-md:-translate-x-full max-md:invisible overflow-y-auto transition-[transform,visibility] duration-200 md:static md:z-auto md:overflow-visible shrink-0 bg-muted text-foreground border-r border-border flex flex-col">
            <div class="px-6 py-5 border-b border-border flex items-center gap-3 bg-background">
                <div class="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center shrink-0 shadow-sm p-1.5">
                    <img src="{{ asset('img/logo.png') }}" alt="Logo" class="w-full h-full">
                </div>
                <div class="leading-tight">
                    <div class="text-base font-semibold text-foreground tracking-tight">HLS R2 Studio</div>
                    <div class="text-[11px] text-muted-foreground">Cloud Video Platform</div>
                </div>
            </div>
            <nav class="flex-1 px-3 py-4 space-y-4">
                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dashboard</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('dashboard.overview') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('dashboard.overview') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-layout-dashboard class="w-4 h-4 text-foreground" />
                            </span>
                            Overview
                        </a>
                        <a href="{{ route('logs.index') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('logs.index') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-scroll-text class="w-4 h-4 text-foreground" />
                            </span>
                            Logs
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Video</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('videos.index') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('videos.index') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-video class="w-4 h-4 text-foreground" />
                            </span>
                            Videos
                        </a>
                        <a href="{{ route('videos.create') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('videos.create') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-upload class="w-4 h-4 text-foreground" />
                            </span>
                            Upload Video
                        </a>
                    </div>
                </div>

                <div>
                    <p class="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">System</p>
                    <div class="bg-background rounded-lg border border-border shadow-sm p-1.5 space-y-1">
                        <a href="{{ route('reports.index') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('reports.index') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-flag class="w-4 h-4 text-muted-foreground" />
                            </span>
                            Reports
                        </a>
                        <a href="{{ route('settings.edit') }}"
                           class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 {{ request()->routeIs('settings.edit') ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent' }}">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
                                <x-lucide-settings class="w-4 h-4 text-muted-foreground" />
                            </span>
                            Settings
                        </a>
                    </div>
                </div>

                <div>
                    <form action="{{ route('logout') }}" method="POST">
                        @csrf
                        <button type="submit" onclick="return confirmLogout(this.form)"
                                class="flex w-full items-center gap-2.5 rounded-md bg-background border border-border shadow-sm px-2.5 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                            <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-destructive/10">
                                <x-lucide-log-out class="w-4 h-4 text-destructive" />
                            </span>
                            Log out ({{ auth()->user()->username }})
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
