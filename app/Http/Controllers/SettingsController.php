<?php

namespace App\Http\Controllers;

use App\Models\Setting;
use App\Services\R2SettingsService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\View\View;

class SettingsController extends Controller
{
    public function edit(): View
    {
        $settings = Setting::current();
        $user = auth()->user();

        $appTokens = $user->tokens()->latest('id')->get();

        return view('settings.edit', compact('settings', 'user', 'appTokens'));
    }

    public function updateStorage(Request $request): RedirectResponse
    {
        Setting::current()->update([
            'delete_from_r2_on_destroy' => $request->boolean('delete_from_r2_on_destroy'),
        ]);

        return back()->with('success', 'Storage options saved.');
    }

    public function updateR2(Request $request, R2SettingsService $r2): RedirectResponse
    {
        $r2->update($request->only(['r2_access_key_id', 'r2_secret_access_key', 'r2_bucket', 'r2_endpoint', 'r2_url']));

        return back()->with('success', 'R2 settings saved.');
    }

    public function testR2(R2SettingsService $r2): RedirectResponse
    {
        if (! $r2->testConnection()) {
            return back()->withErrors(['r2_test' => 'R2 connection test failed. Check the access key, secret, bucket and endpoint.']);
        }

        return back()->with('success', 'R2 connection test succeeded.');
    }

    public function updateTranscode(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'transcode_resolution' => ['required', 'in:480,720,1080'],
            'transcode_segment_seconds' => ['required', 'integer', 'min:2', 'max:15'],
            'transcode_fps' => ['nullable', 'integer', 'min:15', 'max:60'],
        ]);

        Setting::current()->update([
            'transcode_resolution' => $validated['transcode_resolution'],
            'transcode_segment_seconds' => $validated['transcode_segment_seconds'],
            'transcode_fps' => $validated['transcode_fps'],
        ]);

        return back()->with('success', 'Transcoding options saved.');
    }

    public function updateDisplay(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'display_timezone' => ['required', 'timezone'],
        ]);

        Setting::current()->update([
            'display_timezone' => $validated['display_timezone'],
        ]);

        return back()->with('success', 'Display options saved.');
    }

    public function updateEmbed(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'embed_allowed_domains' => ['nullable', 'string', 'max:20000', function (string $attribute, mixed $value, \Closure $fail) {
                $parsed = Setting::parseEmbedEntries($value);

                if ($parsed['invalid'] !== []) {
                    $fail('Invalid entries: '.implode(', ', array_map(fn ($entry) => '"'.mb_substr($entry, 0, 60).'"', array_slice($parsed['invalid'], 0, 5))).'. Use one domain per line, like example.com, *.example.com or https://example.com:8443.');
                }

                if (count($parsed['valid']) > Setting::EMBED_MAX_ENTRIES) {
                    $fail('You can list at most '.Setting::EMBED_MAX_ENTRIES.' domains.');
                }
            }],
        ]);

        $entries = Setting::parseEmbedEntries($validated['embed_allowed_domains'] ?? null)['valid'];

        Setting::current()->update([
            'embed_allowed_domains' => $entries === [] ? null : implode("\n", $entries),
        ]);

        return back()->with('success', 'Embed protection saved.');
    }

    public function updatePassword(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'current_password' => ['required', 'current_password'],
            'password' => ['required', 'confirmed', 'min:8'],
        ]);

        auth()->user()->update(['password' => $validated['password']]);

        $request->session()->regenerate();

        Auth::logoutOtherDevices($validated['password']);

        // Desktop app tokens must not survive a password change.
        auth()->user()->tokens()->delete();

        return back()->with('success', 'Password changed.');
    }

    public function destroyAppToken(Request $request, string $token): RedirectResponse
    {
        // Scoped to the current user's own tokens: anyone else's id answers 404.
        $request->user()->tokens()->findOrFail($token)->delete();

        return back()->with('success', 'Token revoked.');
    }

    public function destroyAppTokens(Request $request): RedirectResponse
    {
        $request->user()->tokens()->delete();

        return back()->with('success', 'All desktop app tokens revoked.');
    }
}
