<?php

namespace App\Http\Controllers;

use App\Models\Setting;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;
use Illuminate\View\View;

class SettingsController extends Controller
{
    public function edit(): View
    {
        $settings = Setting::current();
        $user = auth()->user();

        return view('settings.edit', compact('settings', 'user'));
    }

    public function updateStorage(Request $request): RedirectResponse
    {
        Setting::current()->update([
            'delete_from_r2_on_destroy' => $request->boolean('delete_from_r2_on_destroy'),
        ]);

        return back()->with('success', 'Storage options saved.');
    }

    public function updateR2(Request $request): RedirectResponse
    {
        $settings = Setting::current();
        $hasKey = $settings->r2AccessKeyLast4() !== null;
        $hasSecret = $settings->hasR2Secret();

        $request->merge(array_map(
            fn ($value) => is_string($value) ? trim($value) : $value,
            $request->only(['r2_access_key_id', 'r2_secret_access_key', 'r2_bucket', 'r2_endpoint', 'r2_url']),
        ));

        $validated = $request->validate([
            'r2_access_key_id' => [$hasKey ? 'nullable' : 'required', 'string', 'max:255'],
            'r2_secret_access_key' => [$hasSecret ? 'nullable' : 'required', 'string', 'max:1000'],
            'r2_bucket' => ['required', 'string', 'max:255'],
            'r2_endpoint' => ['required', 'url:https', 'max:255'],
            'r2_url' => ['required', 'url:https', 'max:255'],
        ]);

        $attributes = [
            'r2_bucket' => $validated['r2_bucket'],
            'r2_endpoint' => $validated['r2_endpoint'],
            'r2_url' => rtrim($validated['r2_url'], '/'),
        ];

        // Blank credential inputs keep the stored values.
        foreach (['r2_access_key_id', 'r2_secret_access_key'] as $column) {
            if (($validated[$column] ?? '') !== '') {
                $attributes[$column] = $validated[$column];
            }
        }

        $settings->update($attributes);

        return back()->with('success', 'R2 settings saved.');
    }

    public function testR2(): RedirectResponse
    {
        $key = '_connection-test/'.Str::random(16).'.txt';

        try {
            $disk = Setting::current()->r2Disk();

            if ($disk->put($key, 'ok') === false) {
                throw new \RuntimeException('Write failed.');
            }

            $disk->delete($key);
        } catch (\Throwable) {
            // Details are never surfaced: SDK errors can echo endpoint or credential data.
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

        return back()->with('success', 'Password changed.');
    }
}
