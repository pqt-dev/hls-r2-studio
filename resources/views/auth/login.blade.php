<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>HLS R2 Studio — Đăng nhập admin</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-gray-100 text-gray-800">
    <div class="min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <h1 class="text-lg font-semibold text-gray-900 mb-1">HLS R2 Studio</h1>
            <p class="text-xs text-gray-500 mb-6">Đăng nhập admin</p>

            @if (session('error'))
                <div class="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
                    {{ session('error') }}
                </div>
            @endif

            <form method="POST" action="{{ route('login.attempt') }}" class="space-y-5">
                @csrf

                <div>
                    <label for="username" class="block text-sm font-medium text-gray-700 mb-1">Tên đăng nhập</label>
                    <input type="text" name="username" id="username" value="{{ old('username') }}" required autofocus
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('username')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Mật khẩu</label>
                    <input type="password" name="password" id="password" required
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('password')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <button type="submit"
                        class="inline-flex w-full items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                    Đăng nhập
                </button>
            </form>
        </div>
    </div>
</body>
</html>
