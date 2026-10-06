<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>HLS R2 Studio — Admin Login</title>
    <link rel="icon" type="image/x-icon" href="{{ asset('favicon.ico') }}">
    <link rel="apple-touch-icon" href="{{ asset('apple-touch-icon.png') }}">
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-muted text-sm text-foreground antialiased">
    <div class="min-h-screen flex items-center justify-center p-4">
        <x-ui.card class="w-full max-w-sm">
            <x-ui.card-content>
            <div class="flex flex-col items-center text-center mb-6">
                <div class="w-12 h-12 rounded-lg bg-background border border-border flex items-center justify-center mb-3 shadow-sm p-2">
                    <img src="{{ asset('img/logo.png') }}" alt="Logo" class="w-full h-full">
                </div>
                <h1 class="text-2xl font-semibold tracking-tight text-foreground mb-1">HLS R2 Studio</h1>
                <p class="text-sm text-muted-foreground">Admin Login</p>
            </div>

            @if (session('error'))
                <x-ui.alert variant="destructive" class="mb-4">
                    {{ session('error') }}
                </x-ui.alert>
            @endif

            <form method="POST" action="{{ route('login.attempt') }}" class="space-y-5">
                @csrf

                <div>
                    <x-ui.label for="username" class="block mb-2">Username</x-ui.label>
                    <x-ui.input type="text" name="username" id="username" value="{{ old('username') }}" required autofocus />
                    @error('username')
                        <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <x-ui.label for="password" class="block mb-2">Password</x-ui.label>
                    <x-ui.input type="password" name="password" id="password" required />
                    @error('password')
                        <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                    @enderror
                </div>

                <x-ui.button class="w-full" type="submit">
                    Log in
                </x-ui.button>
            </form>
            </x-ui.card-content>
        </x-ui.card>
    </div>
</body>
</html>
