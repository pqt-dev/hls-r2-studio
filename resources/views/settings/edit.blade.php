@extends('layouts.app')

@section('title', 'Settings - HLS R2 Studio')
@section('page-title', 'Settings')
@section('breadcrumb', 'Home / Settings')

@section('content')
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        <x-ui.card class="min-w-0 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-50 to-sky-100 ring-1 ring-inset ring-sky-200/70 flex items-center justify-center shrink-0">
                    <x-lucide-key-round class="w-4 h-4 text-sky-600 stroke-[1.75]" />
                </div>
                <h3 class="text-sm font-semibold text-foreground">Change password</h3>
            </div>
            <x-ui.card-content class="not-first:pt-5!">
                <form method="POST" action="{{ route('settings.password') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="current_password" class="block mb-2">Current password</x-ui.label>
                        <x-ui.input type="password" name="current_password" id="current_password" />
                        @error('current_password')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="password" class="block mb-2">New password</x-ui.label>
                        <x-ui.input type="password" name="password" id="password" />
                        @error('password')
                            <p class="mt-1 text-xs text-destructive">{{ $message }}</p>
                        @enderror
                    </div>

                    <div>
                        <x-ui.label for="password_confirmation" class="block mb-2">Confirm new password</x-ui.label>
                        <x-ui.input type="password" name="password_confirmation" id="password_confirmation" />
                    </div>

                    <div class="-mx-6 -mb-6 border-t border-border bg-muted/40 px-6 py-3 flex justify-end">
                        <x-ui.button type="submit" class="max-md:w-full">Change password</x-ui.button>
                    </div>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-50 to-orange-100 ring-1 ring-inset ring-orange-200/70 flex items-center justify-center shrink-0">
                    <x-lucide-cloud class="w-4 h-4 text-orange-600 stroke-[1.75]" />
                </div>
                <h3 class="text-sm font-semibold text-foreground">Storage</h3>
            </div>
            <x-ui.card-content class="not-first:pt-5!">
                <form method="POST" action="{{ route('settings.storage') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div class="flex items-start gap-2">
                        <x-ui.checkbox name="delete_from_r2_on_destroy" id="delete_from_r2_on_destroy" value="1"
                               :checked="(bool) old('delete_from_r2_on_destroy', $settings->delete_from_r2_on_destroy)"
                               class="mt-0.5" />
                        <label for="delete_from_r2_on_destroy" class="text-sm text-foreground">
                            Delete file on R2 when deleting video
                            <span class="block text-xs text-muted-foreground">If unchecked, deleting a video only removes the record in the system; the file on R2 will be kept.</span>
                        </label>
                    </div>

                    <div class="-mx-6 -mb-6 border-t border-border bg-muted/40 px-6 py-3 flex justify-end">
                        <x-ui.button type="submit" class="max-md:w-full">Save storage options</x-ui.button>
                    </div>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 ring-1 ring-inset ring-slate-200/70 flex items-center justify-center shrink-0">
                    <x-lucide-film class="w-4 h-4 text-slate-700 stroke-[1.75]" />
                </div>
                <h3 class="text-sm font-semibold text-foreground">HLS transcoding options</h3>
            </div>
            <x-ui.card-content class="not-first:pt-5!">
                <form method="POST" action="{{ route('settings.transcode') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

                    <div>
                        <x-ui.label for="transcode_resolution" class="block mb-2">Output resolution</x-ui.label>
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
                        <x-ui.label for="transcode_segment_seconds" class="block mb-2">HLS segment length (seconds)</x-ui.label>
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

                    <div class="-mx-6 -mb-6 border-t border-border bg-muted/40 px-6 py-3 flex justify-end">
                        <x-ui.button type="submit" class="max-md:w-full">Save transcoding options</x-ui.button>
                    </div>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 ring-1 ring-inset ring-slate-200/70 flex items-center justify-center shrink-0">
                    <x-lucide-sliders-horizontal class="w-4 h-4 text-slate-600 stroke-[1.75]" />
                </div>
                <h3 class="text-sm font-semibold text-foreground">Other options</h3>
            </div>
            <x-ui.card-content class="not-first:pt-5!">
                <form method="POST" action="{{ route('settings.display') }}" class="space-y-5">
                    @csrf
                    @method('PUT')

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

                    <div class="-mx-6 -mb-6 border-t border-border bg-muted/40 px-6 py-3 flex justify-end">
                        <x-ui.button type="submit" class="max-md:w-full">Save other options</x-ui.button>
                    </div>
                </form>
            </x-ui.card-content>
        </x-ui.card>

        <x-ui.card class="min-w-0 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100 ring-1 ring-inset ring-emerald-200/70 flex items-center justify-center shrink-0">
                    <x-lucide-shield-check class="w-4 h-4 text-emerald-600 stroke-[1.75]" />
                </div>
                <h3 class="text-sm font-semibold text-foreground">Embed protection</h3>
            </div>
            <x-ui.card-content class="not-first:pt-5!">
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

                    <div class="-mx-6 -mb-6 border-t border-border bg-muted/40 px-6 py-3 flex justify-end">
                        <x-ui.button type="submit" class="max-md:w-full">Save embed protection</x-ui.button>
                    </div>
                </form>
            </x-ui.card-content>
        </x-ui.card>
    </div>
@endsection
