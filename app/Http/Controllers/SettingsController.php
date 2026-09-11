<?php

namespace App\Http\Controllers;

use App\Models\Setting;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class SettingsController extends Controller
{
    public function edit(): View
    {
        $settings = Setting::current();
        $user = auth()->user();
        $effectiveR2Config = $settings->effectiveR2Config();

        return view('settings.edit', compact('settings', 'user', 'effectiveR2Config'));
    }

    public function updateR2(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'r2_access_key_id' => ['nullable', 'string'],
            'r2_secret_access_key' => ['nullable', 'string'],
            'r2_bucket' => ['nullable', 'string'],
            'r2_endpoint' => ['nullable', 'string', 'url'],
            'r2_url' => ['nullable', 'string', 'url'],
        ]);

        $settings = Setting::current();

        $settings->r2_bucket = $validated['r2_bucket'];
        $settings->r2_endpoint = $validated['r2_endpoint'];
        $settings->r2_url = $validated['r2_url'];
        $settings->delete_from_r2_on_destroy = $request->boolean('delete_from_r2_on_destroy');

        if (filled($validated['r2_access_key_id'])) {
            $settings->r2_access_key_id = $validated['r2_access_key_id'];
        }

        if (filled($validated['r2_secret_access_key'])) {
            $settings->r2_secret_access_key = $validated['r2_secret_access_key'];
        }

        $settings->save();

        return back()->with('success', 'R2 configuration saved.');
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
            'videos_per_page' => ['required', 'in:12,24,48,100'],
        ]);

        Setting::current()->update([
            'videos_per_page' => $validated['videos_per_page'],
        ]);

        return back()->with('success', 'Display options saved.');
    }

    public function updatePassword(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'current_password' => ['required', 'current_password'],
            'password' => ['required', 'confirmed', 'min:8'],
        ]);

        auth()->user()->update(['password' => $validated['password']]);

        return back()->with('success', 'Password changed.');
    }
}
