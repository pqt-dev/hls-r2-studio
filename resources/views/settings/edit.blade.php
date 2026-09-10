@extends('layouts.app')

@section('title', 'Cài đặt - HLS R2 Studio')
@section('page-title', 'Cài đặt')
@section('breadcrumb', 'Trang chủ / Cài đặt')

@section('content')
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <h2 class="text-lg font-semibold text-gray-900 mb-4">Đổi mật khẩu</h2>
            <form method="POST" action="{{ route('settings.password') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="current_password" class="block text-sm font-medium text-gray-700 mb-1">Mật khẩu hiện tại</label>
                    <input type="password" name="current_password" id="current_password"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('current_password')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Mật khẩu mới</label>
                    <input type="password" name="password" id="password"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('password')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="password_confirmation" class="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu mới</label>
                    <input type="password" name="password_confirmation" id="password_confirmation"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                    Đổi mật khẩu
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <h2 class="text-lg font-semibold text-gray-900 mb-4">Cấu hình Cloudflare R2</h2>

            <form method="POST" action="{{ route('settings.r2') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="r2_access_key_id" class="block text-sm font-medium text-gray-700 mb-1">R2 Access Key ID</label>
                    <input type="text" name="r2_access_key_id" id="r2_access_key_id" value="{{ old('r2_access_key_id') }}"
                           placeholder="{{ $effectiveR2Config['r2_access_key_id']['value'] ? substr($effectiveR2Config['r2_access_key_id']['value'], 0, 4).'**** (hiện tại, để trống nếu không đổi)' : 'Chưa cấu hình' }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_access_key_id')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_access_key_id']['from_db'] ? '(từ Cài đặt)' : '(mặc định từ .env server)' }}</p>
                </div>

                <div>
                    <label for="r2_secret_access_key" class="block text-sm font-medium text-gray-700 mb-1">R2 Secret Access Key</label>
                    <input type="password" name="r2_secret_access_key" id="r2_secret_access_key"
                           placeholder="Để trống nếu không đổi Secret Key hiện tại"
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
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_bucket']['from_db'] ? '(từ Cài đặt)' : '(mặc định từ .env server)' }}</p>
                </div>

                <div>
                    <label for="r2_endpoint" class="block text-sm font-medium text-gray-700 mb-1">R2 Endpoint</label>
                    <input type="text" name="r2_endpoint" id="r2_endpoint" value="{{ old('r2_endpoint', $effectiveR2Config['r2_endpoint']['value']) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_endpoint')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_endpoint']['from_db'] ? '(từ Cài đặt)' : '(mặc định từ .env server)' }}</p>
                </div>

                <div>
                    <label for="r2_url" class="block text-sm font-medium text-gray-700 mb-1">R2 URL</label>
                    <input type="text" name="r2_url" id="r2_url" value="{{ old('r2_url', $effectiveR2Config['r2_url']['value']) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    @error('r2_url')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                    <p class="mt-1 text-xs text-gray-500">{{ $effectiveR2Config['r2_url']['from_db'] ? '(từ Cài đặt)' : '(mặc định từ .env server)' }}</p>
                </div>

                <p class="text-xs text-gray-500">Để trống bất kỳ trường nào (trừ Secret Key) sẽ dùng lại giá trị mặc định từ .env của server.</p>

                <div class="flex items-start gap-2">
                    <input type="checkbox" name="delete_from_r2_on_destroy" id="delete_from_r2_on_destroy" value="1"
                           @checked(old('delete_from_r2_on_destroy', $settings->delete_from_r2_on_destroy))
                           class="mt-1 rounded border-gray-300 text-emerald-600 focus:ring-emerald-600">
                    <label for="delete_from_r2_on_destroy" class="text-sm text-gray-700">
                        Xoá file trên R2 khi xoá video
                        <span class="block text-xs text-gray-500">Nếu bỏ chọn, khi xoá video chỉ xoá record trong hệ thống, file trên R2 vẫn được giữ lại.</span>
                    </label>
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                    Lưu cấu hình R2
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <h2 class="text-lg font-semibold text-gray-900 mb-4">Tuỳ chọn băm video (HLS)</h2>
            <form method="POST" action="{{ route('settings.transcode') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="transcode_resolution" class="block text-sm font-medium text-gray-700 mb-1">Độ phân giải đầu ra</label>
                    <select name="transcode_resolution" id="transcode_resolution"
                            class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                        @php $currentResolution = old('transcode_resolution', $settings->transcode_resolution); @endphp
                        <option value="480" @selected($currentResolution == '480')>480p (SD)</option>
                        <option value="720" @selected($currentResolution == '720')>720p (HD) — mặc định</option>
                        <option value="1080" @selected($currentResolution == '1080')>1080p (Full HD)</option>
                    </select>
                    @error('transcode_resolution')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="transcode_segment_seconds" class="block text-sm font-medium text-gray-700 mb-1">Độ dài mỗi đoạn HLS (giây)</label>
                    <input type="number" name="transcode_segment_seconds" id="transcode_segment_seconds" min="2" max="15"
                           value="{{ old('transcode_segment_seconds', $settings->transcode_segment_seconds) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    <p class="mt-1 text-xs text-gray-500">Mặc định: 6 giây. Đoạn ngắn hơn giúp tua nhanh mượt hơn nhưng tạo nhiều file hơn.</p>
                    @error('transcode_segment_seconds')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <div>
                    <label for="transcode_fps" class="block text-sm font-medium text-gray-700 mb-1">FPS đầu ra (để trống = giữ nguyên FPS gốc)</label>
                    <input type="number" name="transcode_fps" id="transcode_fps" min="15" max="60"
                           value="{{ old('transcode_fps', $settings->transcode_fps) }}"
                           class="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600">
                    <p class="mt-1 text-xs text-gray-500">Để trống nghĩa là giữ nguyên FPS gốc của video, không ép FPS.</p>
                    @error('transcode_fps')
                        <p class="mt-1 text-xs text-red-600">{{ $message }}</p>
                    @enderror
                </div>

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                    Lưu tuỳ chọn băm video
                </button>
            </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <h2 class="text-lg font-semibold text-gray-900 mb-4">Tuỳ chọn khác</h2>
            <form method="POST" action="{{ route('settings.display') }}" class="space-y-5">
                @csrf
                @method('PUT')

                <div>
                    <label for="videos_per_page" class="block text-sm font-medium text-gray-700 mb-1">Số video mỗi trang</label>
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

                <button type="submit"
                        class="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                    Lưu tuỳ chọn khác
                </button>
            </form>
        </div>
    </div>
@endsection
