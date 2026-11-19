<?php

namespace App\Http\Controllers;

use App\Exceptions\R2NotConfiguredException;
use App\Models\Setting;
use App\Models\Video;
use App\Support\EmbedStoryboard;
use Illuminate\Http\Request;

class EmbedController extends Controller
{
    /**
     * Display a standalone player page for embedding a video via iframe.
     */
    public function show(Request $request, Video $video)
    {
        if ($video->status !== 'ready') {
            abort(404);
        }

        $settings = Setting::current();
        try {
            $disk = $settings->r2Disk();
        } catch (R2NotConfiguredException) {
            abort(503, 'Video storage is not configured.');
        }

        $playlistUrl = $disk->url($video->playlist_path);

        $autoplay = $request->boolean('autoplay');
        $muted = $request->boolean('muted') || $autoplay; // browsers require muted for unattended autoplay to actually work

        $storyboardThumbnails = EmbedStoryboard::pick($video->storyboards, $disk);

        $response = response()->view('embed.show', compact('video', 'playlistUrl', 'storyboardThumbnails', 'autoplay', 'muted'));

        $allowedOrigins = $settings->embedAllowedOrigins();

        if ($allowedOrigins !== []) {
            $response->header('Content-Security-Policy', "frame-ancestors 'self' ".implode(' ', $allowedOrigins));
        }

        $response->headers->set('Cache-Control', 'public, max-age=60, s-maxage=300');
        $response->headers->set('X-Robots-Tag', 'noindex, nofollow');

        return $response;
    }
}
