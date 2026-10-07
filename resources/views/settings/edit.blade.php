@extends('layouts.app')

@section('title', 'Settings - HLS R2 Studio')
@section('page-title', 'Settings')
@section('breadcrumb', 'Home / Settings')

@section('content')
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        <x-ui.card class="min-w-0">
            <x-ui.card-header>
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-sky-100 flex items-center justify-center shrink-0">
                        <x-lucide-key-round class="w-4 h-4 text-sky-600" />
                    </div>
                    <x-ui.card-title class="text-lg">Change Password</x-ui.card-title>
                </div>
            </x-ui.card-header>
            <x-ui.card-content>
                <form method="POST" action="{{ route('settings.password') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="current_password" class="block mb-2">Current Password</x-ui.label>
                        <x-ui.input type="password" name="current_password" id="current_password" />
                        @error('current_password')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="password" class="block mb-2">New Password</x-ui.label>
                        <x-ui.input type="password" name="password" id="password" />
                        @error('password')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="password_confirmation" class="block mb-2">Confirm New Password</x-ui.label>
                        <x-ui.input type="password" name="password_confirmation" id="password_confirmation" />
                    </div>

                    <x-ui.button type="submit">
                        Change password
                    </x-ui.button>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0">
            <x-ui.card-header>
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0">
                        <x-lucide-cloud class="w-4 h-4 text-orange-600" />
                    </div>
                    <x-ui.card-title class="text-lg">Cloudflare R2 Configuration</x-ui.card-title>
                </div>
            </x-ui.card-header>
            <x-ui.card-content>
                <form method="POST" action="{{ route('settings.r2') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="r2_access_key_id" class="block mb-2">R2 Access Key ID</x-ui.label>
                        <x-ui.input type="text" name="r2_access_key_id" id="r2_access_key_id" value="{{ old('r2_access_key_id') }}" placeholder="{{ $effectiveR2Config['r2_access_key_id']['value'] ? substr($effectiveR2Config['r2_access_key_id']['value'], 0, 4).'**** (current, leave blank to keep)' : 'Not configured' }}" />
                        @error('r2_access_key_id')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                        <p class="mt-1 text-xs text-muted-foreground">{{ $effectiveR2Config['r2_access_key_id']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                    </div>

                    <div>
                        <x-ui.label for="r2_secret_access_key" class="block mb-2">R2 Secret Access Key</x-ui.label>
                        <x-ui.input type="password" name="r2_secret_access_key" id="r2_secret_access_key" placeholder="Leave blank to keep the current Secret Key" />
                        @error('r2_secret_access_key')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="r2_bucket" class="block mb-2">R2 Bucket</x-ui.label>
                        <x-ui.input type="text" name="r2_bucket" id="r2_bucket" value="{{ old('r2_bucket', $effectiveR2Config['r2_bucket']['value']) }}" />
                        @error('r2_bucket')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                        <p class="mt-1 text-xs text-muted-foreground">{{ $effectiveR2Config['r2_bucket']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                    </div>

                    <div>
                        <x-ui.label for="r2_endpoint" class="block mb-2">R2 Endpoint</x-ui.label>
                        <x-ui.input type="text" name="r2_endpoint" id="r2_endpoint" value="{{ old('r2_endpoint', $effectiveR2Config['r2_endpoint']['value']) }}" />
                        @error('r2_endpoint')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                        <p class="mt-1 text-xs text-muted-foreground">{{ $effectiveR2Config['r2_endpoint']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                    </div>

                    <div>
                        <x-ui.label for="r2_url" class="block mb-2">R2 URL</x-ui.label>
                        <x-ui.input type="text" name="r2_url" id="r2_url" value="{{ old('r2_url', $effectiveR2Config['r2_url']['value']) }}" />
                        @error('r2_url')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                        <p class="mt-1 text-xs text-muted-foreground">{{ $effectiveR2Config['r2_url']['from_db'] ? '(from Settings)' : '(default from server .env)' }}</p>
                    </div>

                    <p class="text-xs text-muted-foreground">Leaving any field blank (except Secret Key) will fall back to the default value from the server's .env.</p>

                    <div class="flex items-start gap-2">
                        <x-ui.checkbox name="delete_from_r2_on_destroy" id="delete_from_r2_on_destroy" value="1"
                               :checked="(bool) old('delete_from_r2_on_destroy', $settings->delete_from_r2_on_destroy)"
                               class="mt-0.5" />
                        <label for="delete_from_r2_on_destroy" class="text-sm text-foreground">
                            Delete file on R2 when deleting video
                            <span class="block text-xs text-muted-foreground">If unchecked, deleting a video only removes the record in the system; the file on R2 will be kept.</span>
                        </label>
                    </div>

                    <x-ui.button type="submit">
                        Save R2 configuration
                    </x-ui.button>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0">
            <x-ui.card-header>
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <x-lucide-video class="w-4 h-4 text-foreground" />
                    </div>
                    <x-ui.card-title class="text-lg">HLS Transcoding Options</x-ui.card-title>
                </div>
            </x-ui.card-header>
            <x-ui.card-content>
                <form method="POST" action="{{ route('settings.transcode') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="transcode_resolution" class="block mb-2">Output Resolution</x-ui.label>
                        <x-ui.select name="transcode_resolution" id="transcode_resolution">
                            @php $currentResolution = old('transcode_resolution', $settings->transcode_resolution); @endphp
                            <option value="480" @selected($currentResolution == '480')>480p (SD)</option>
                            <option value="720" @selected($currentResolution == '720')>720p (HD) — default</option>
                            <option value="1080" @selected($currentResolution == '1080')>1080p (Full HD)</option>
                        </x-ui.select>
                        @error('transcode_resolution')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="transcode_segment_seconds" class="block mb-2">HLS Segment Length (seconds)</x-ui.label>
                        <x-ui.input type="number" name="transcode_segment_seconds" id="transcode_segment_seconds" min="2" max="15" value="{{ old('transcode_segment_seconds', $settings->transcode_segment_seconds) }}" />
                        <p class="mt-1 text-xs text-muted-foreground">Default: 6 seconds. Shorter segments make seeking smoother but create more files.</p>
                        @error('transcode_segment_seconds')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="transcode_fps" class="block mb-2">Output FPS (leave blank = keep original FPS)</x-ui.label>
                        <x-ui.input type="number" name="transcode_fps" id="transcode_fps" min="15" max="60" value="{{ old('transcode_fps', $settings->transcode_fps) }}" />
                        <p class="mt-1 text-xs text-muted-foreground">Leaving this blank keeps the video's original FPS without forcing a specific FPS.</p>
                        @error('transcode_fps')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <x-ui.button type="submit">
                        Save transcoding options
                    </x-ui.button>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0">
            <x-ui.card-header>
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                        <x-lucide-sliders-horizontal class="w-4 h-4 text-violet-600" />
                    </div>
                    <x-ui.card-title class="text-lg">Other Options</x-ui.card-title>
                </div>
            </x-ui.card-header>
            <x-ui.card-content>
                <form method="POST" action="{{ route('settings.display') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="videos_per_page" class="block mb-2">Videos per page</x-ui.label>
                        <x-ui.select name="videos_per_page" id="videos_per_page">
                            @php $currentVideosPerPage = old('videos_per_page', $settings->videos_per_page); @endphp
                            <option value="10" @selected($currentVideosPerPage == 10)>10</option>
                            <option value="20" @selected($currentVideosPerPage == 20)>20</option>
                            <option value="50" @selected($currentVideosPerPage == 50)>50</option>
                            <option value="100" @selected($currentVideosPerPage == 100)>100</option>
                        </x-ui.select>
                        @error('videos_per_page')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="display_timezone" class="block mb-2">Display timezone</x-ui.label>
                        <x-ui.select name="display_timezone" id="display_timezone">
                            @php $currentDisplayTimezone = old('display_timezone', $settings->display_timezone); @endphp
                            @foreach (\DateTimeZone::listIdentifiers() as $timezoneOption)
                                <option value="{{ $timezoneOption }}" @selected($currentDisplayTimezone === $timezoneOption)>{{ $timezoneOption }}</option>
                            @endforeach
                        </x-ui.select>
                        @error('display_timezone')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <x-ui.button type="submit">
                        Save other options
                    </x-ui.button>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0">
            <x-ui.card-header>
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                        <x-lucide-shield-check class="w-4 h-4 text-violet-600" />
                    </div>
                    <x-ui.card-title class="text-lg">Embed protection</x-ui.card-title>
                </div>
            </x-ui.card-header>
            <x-ui.card-content>
                <form method="POST" action="{{ route('settings.embed') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="embed_allowed_domains" class="block mb-2">Allowed domains</x-ui.label>
                        <x-ui.textarea name="embed_allowed_domains" id="embed_allowed_domains" rows="5" class="font-mono" placeholder="example.com&#10;*.example.com&#10;https://example.com:8443">{{ old('embed_allowed_domains', $settings->embed_allowed_domains) }}</x-ui.textarea>
                        <p class="mt-1 text-xs text-muted-foreground">Only these domains can embed the player iframe. Leave empty to allow any website. Your own site is always allowed.</p>
                        @error('embed_allowed_domains')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <x-ui.button type="submit">
                        Save embed protection
                    </x-ui.button>
                </form>
            </x-ui.card-content>
        </x-ui.card>
    </div>
@endsection
