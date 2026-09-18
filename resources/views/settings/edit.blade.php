@extends('layouts.app')

@section('title', 'Settings - HLS R2 Studio')
@section('page-title', 'Settings')
@section('breadcrumb', 'Home / Settings')

@section('content')
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-9 h-9 rounded-lg bg-sky-100 flex items-center justify-center shrink-0">
                    <x-lucide-key-round class="w-4 h-4 text-sky-600" />
                </div>
                <h2 class="text-lg font-semibold text-gray-900">Change Password</h2>
            </div>
            <form method="POST" action="{{ route('settings.password') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="current_password" class="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
                    <input type="password" name="current_password" id="current_password"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('current_password')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                    <input type="password" name="password" id="password"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('password')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="password_confirmation" class="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
                    <input type="password" name="password_confirmation" id="password_confirmation"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
                    Change Password
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-9 h-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0">
                    <x-lucide-cloud class="w-4 h-4 text-orange-600" />
                </div>
                <h2 class="text-lg font-semibold text-gray-900">Cloudflare R2 Configuration</h2>
            </div>

            <form method="POST" action="{{ route('settings.r2') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="r2_access_key_id" class="block text-sm font-medium text-gray-700 mb-1">R2 Access Key ID</label>
                    <input type="text" name="r2_access_key_id" id="r2_access_key_id" value="{{ old('r2_access_key_id') }}"
                           placeholder="{{ $effectiveR2Config['r2_access_key_id']['value'] ? substr($effectiveR2Config['r2_access_key_id']['value'], 0, 4).'**** (current, leave blank to keep)' : 'Not configured' }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_access_key_id')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_access_key_id']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                </div>

                <div>
                    <label for="r2_secret_access_key" class="block text-sm font-medium text-gray-700 mb-1">R2 Secret Access Key</label>
                    <input type="password" name="r2_secret_access_key" id="r2_secret_access_key"
                           placeholder="Leave blank to keep the current Secret Key"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_secret_access_key')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="r2_bucket" class="block text-sm font-medium text-gray-700 mb-1">R2 Bucket</label>
                    <input type="text" name="r2_bucket" id="r2_bucket" value="{{ old('r2_bucket', $effectiveR2Config['r2_bucket']['value']) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_bucket')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_bucket']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                </div>

                <div>
                    <label for="r2_endpoint" class="block text-sm font-medium text-gray-700 mb-1">R2 Endpoint</label>
                    <input type="text" name="r2_endpoint" id="r2_endpoint" value="{{ old('r2_endpoint', $effectiveR2Config['r2_endpoint']['value']) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_endpoint')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_endpoint']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                </div>

                <div>
                    <label for="r2_url" class="block text-sm font-medium text-gray-700 mb-1">R2 URL</label>
                    <input type="text" name="r2_url" id="r2_url" value="{{ old('r2_url', $effectiveR2Config['r2_url']['value']) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_url')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_url']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                </div>

                <p class="text-xs text-gray-500">Leaving any field blank (except Secret Key) will fall back to the default value from the server's .env.</p>

                <div class="flex items-start gap-2">
                    <input type="checkbox" name="delete_from_r2_on_destroy" id="delete_from_r2_on_destroy" value="1"
                           @checked(old('delete_from_r2_on_destroy', $settings->delete_from_r2_on_destroy))
                           class="mt-1 rounded border-gray-300 text-emerald-600 focus:ring-emerald-600">
                    <label for="delete_from_r2_on_destroy" class="text-sm text-gray-700">
                        Delete file on R2 when deleting video
                        <span class="block text-xs text-gray-500">If unchecked, deleting a video only removes the record in the system; the file on R2 will be kept.</span>
                    </label>
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
                    Save R2 Configuration
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                    <x-lucide-video class="w-4 h-4 text-indigo-600" />
                </div>
                <h2 class="text-lg font-semibold text-gray-900">HLS Transcoding Options</h2>
            </div>
            <form method="POST" action="{{ route('settings.transcode') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="transcode_resolution" class="block text-sm font-medium text-gray-700 mb-1">Output Resolution</label>
                    <select name="transcode_resolution" id="transcode_resolution"
                            class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                        @php $currentResolution = old('transcode_resolution', $settings->transcode_resolution); @endphp
                        <option value="480" @selected($currentResolution == '480')>480p (SD)</option>
                        <option value="720" @selected($currentResolution == '720')>720p (HD) — default</option>
                        <option value="1080" @selected($currentResolution == '1080')>1080p (Full HD)</option>
                    </select>
                    @error('transcode_resolution')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="transcode_segment_seconds" class="block text-sm font-medium text-gray-700 mb-1">HLS Segment Length (seconds)</label>
                    <input type="number" name="transcode_segment_seconds" id="transcode_segment_seconds" min="2" max="15"
                           value="{{ old('transcode_segment_seconds', $settings->transcode_segment_seconds) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    <p class="mt-1 text-xs text-gray-500">Default: 6 seconds. Shorter segments make seeking smoother but create more files.</p>
                    @error('transcode_segment_seconds')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="transcode_fps" class="block text-sm font-medium text-gray-700 mb-1">Output FPS (leave blank = keep original FPS)</label>
                    <input type="number" name="transcode_fps" id="transcode_fps" min="15" max="60"
                           value="{{ old('transcode_fps', $settings->transcode_fps) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    <p class="mt-1 text-xs text-gray-500">Leaving this blank keeps the video's original FPS without forcing a specific FPS.</p>
                    @error('transcode_fps')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
                    Save Transcoding Options
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                    <x-lucide-sliders-horizontal class="w-4 h-4 text-violet-600" />
                </div>
                <h2 class="text-lg font-semibold text-gray-900">Other Options</h2>
            </div>
            <form method="POST" action="{{ route('settings.display') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="videos_per_page" class="block text-sm font-medium text-gray-700 mb-1">Videos per page</label>
                    <select name="videos_per_page" id="videos_per_page"
                            class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                        @php $currentVideosPerPage = old('videos_per_page', $settings->videos_per_page); @endphp
                        <option value="12" @selected($currentVideosPerPage == 12)>12</option>
                        <option value="24" @selected($currentVideosPerPage == 24)>24</option>
                        <option value="48" @selected($currentVideosPerPage == 48)>48</option>
                        <option value="100" @selected($currentVideosPerPage == 100)>100</option>
                    </select>
                    @error('videos_per_page')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="display_timezone" class="block text-sm font-medium text-gray-700 mb-1">Display timezone</label>
                    <select name="display_timezone" id="display_timezone"
                            class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                        @php $currentDisplayTimezone = old('display_timezone', $settings->display_timezone); @endphp
                        @foreach (\DateTimeZone::listIdentifiers() as $timezoneOption)
                            <option value="{{ $timezoneOption }}" @selected($currentDisplayTimezone === $timezoneOption)>{{ $timezoneOption }}</option>
                        @endforeach
                    </select>
                    @error('display_timezone')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
                    Save Other Options
                </button>
            </form>
        </div>
    </div>
@endsection
